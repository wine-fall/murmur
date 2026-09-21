// The music source (spec 03-01 §2.2): search + resolve over the yt-dlp binary,
// which covers YouTube and Bilibili with no login — and, with a mounted source
// (spec 14 §2.5), the listener's own cookie for the host a ref belongs to,
// leased as a jar file for the one call.
//
// search runs `--dump-json --flat-playlist ytsearch{limit}:<query>` — one
// request for the whole result page (issue #76: a full per-hit extraction
// measured ~10-17s per search; flat is ~2s) whose entries still carry the
// judging signal (title, uploader, duration, view_count), so the brain can
// reject junk (hour-long loops, low-quality re-uploads) and prefer official
// audio. Bilibili searches the same way through `bilisearch{limit}:`; NetEase
// has no yt-dlp search, so a mounted NetEase client answers that catalogue
// (spec 14 §2.8). Searching is anonymous for both — Bilibili's risk control
// answers a signed-in search 412 — and so is YouTube PLAYBACK: under a
// signed-in web client yt-dlp skips the formats it can hand ffmpeg and the
// URL it prints answers 403. The jar stays where it earns its keep: the
// taste reads, and Bilibili/NetEase playback (spec 14 §2.5). resolve runs `-f bestaudio/best` with `--print` and returns a
// STREAM URL plus the track's length, never a download (master decision A);
// Phase 3's engine decodes it, and spec 10 §3.3's rail counts against the
// length.
//
// yt-dlp's JSON is an untrusted boundary, so every hit is zod-parsed and a hit
// that does not fit is skipped rather than coerced. Its stderr is read once,
// on failure, for the auth shapes spec 14 §2.6 names — and only for a host
// that has a mount, because with nothing to renew there is nothing to say.

import { execFile } from 'node:child_process'
import { debuglog, promisify } from 'node:util'

import { z } from 'zod'

import type { AudioClip, Catalogue, MusicProvider, TrackCandidate } from '../contracts.ts'
import { classifyAuthFailure, rightsMiss, SourceAuthError, TrackRightsError } from './sources/auth.ts'
import { BrowserCookieError, type CookieLease } from './sources/cookies.ts'
import { sourceOfRef, type CookieSource } from './sources/store.ts'

const debug = debuglog('murmur')
const run = promisify(execFile)

// Full per-hit metadata is large; the default 1 MB would truncate a 5-hit search.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

// nullish, not optional: yt-dlp writes explicit nulls (a live stream has no
// duration, a re-upload no uploader) and a null must not disqualify the hit.
const HitSchema = z.object({
  title: z.string().min(1),
  webpage_url: z.string().nullish(),
  url: z.string().nullish(),
  id: z.string().nullish(),
  uploader: z.string().nullish(),
  channel: z.string().nullish(),
  duration: z.number().nullish(),
  view_count: z.number().nullish(),
})

export function parseSearchOutput(stdout: string, limit: number): TrackCandidate[] {
  const candidates: TrackCandidate[] = []
  for (const line of stdout.split('\n')) {
    if (candidates.length >= limit) break
    const trimmed = line.trim()
    if (!trimmed) continue
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      continue // yt-dlp chatter on stdout, not a hit
    }
    const hit = HitSchema.safeParse(json)
    if (!hit.success) continue
    const ref = hit.data.webpage_url ?? hit.data.url ?? hit.data.id
    if (!ref) continue
    candidates.push({
      ref,
      title: hit.data.title,
      uploader: hit.data.uploader ?? hit.data.channel ?? '',
      // A live stream or a missing field yields no usable duration; 0 says
      // "unknown" rather than dropping an otherwise fine candidate.
      durationS: Math.trunc(hit.data.duration ?? 0),
      extra: hit.data.view_count == null ? {} : { viewCount: hit.data.view_count },
    })
  }
  return candidates
}

// resolve prints two fields (see MusicProvider.resolve below): the track's
// length, then its stream url. The url is found by shape rather than by
// position — a duration handed to the decoder as a source is a song that dies
// silently, and this is an untrusted boundary like the search JSON above.
// yt-dlp's `%(http_headers)j`: the request that made the extraction work. A
// trust boundary — an object of strings or nothing at all, never coerced.
const HttpHeadersSchema = z.record(z.string(), z.string())

export function parseResolveOutput(stdout: string): {
  source: string
  durationS: number
  headers?: Record<string, string>
} {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const source = lines.find((line) => /^https?:\/\//.test(line))
  if (source === undefined) throw new Error('yt-dlp produced no stream url')
  // yt-dlp writes the literal `NA` for a field it has no value for (a live
  // stream, a hit whose extractor omits it). 0 = unknown, the same reading
  // TrackCandidate.durationS gives a missing duration.
  const durationS = Math.trunc(Number(lines[0]))
  // The headers line is the one JSON object; junk there costs the headers, not
  // the song — the stream still plays for every host that needs none.
  const printed = lines.find((line) => line.startsWith('{'))
  const headers = printed === undefined ? undefined : HttpHeadersSchema.safeParse(tryJson(printed)).data
  return {
    source,
    durationS: Number.isFinite(durationS) && durationS > 0 ? durationS : 0,
    ...(headers !== undefined && Object.keys(headers).length > 0 && { headers }),
  }
}

function tryJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

// The chapter ref (spec 14 §2.9): a curated-channel candidate that is one
// chapter of a long upload carries the upload's own url plus a W3C media
// fragment, `#t=<start>,<end>` in seconds. Only the complete, forward pair is
// a segment — half a fragment or someone else's `#` (a NetEase ref is
// `.../#/song?id=5`) leaves the ref exactly as it came.
const MEDIA_FRAGMENT = /^(.*)#t=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/

export function parseSegmentRef(ref: string): { url: string; segment?: { startS: number; endS: number } } {
  const match = MEDIA_FRAGMENT.exec(ref)
  if (match === null) return { url: ref }
  const startS = Number(match[2])
  const endS = Number(match[3])
  if (!(endS > startS)) return { url: ref }
  return { url: match[1] ?? ref, segment: { startS, endS } }
}

// Injectable so the unit layer covers argument construction without the binary
// or the network; the real runner is the yt-dlp subprocess. `tmpdir` becomes
// the child's TMPDIR: a caller that owns a throwaway directory can keep
// yt-dlp's own scratch inside it, which matters when the spawn is killed and
// never gets to clean up after itself (spec 14 §2.8).
export type YtDlpRunner = (args: string[], opts?: { tmpdir?: string }) => Promise<string>

// What a failed runner said. execFile's rejection carries stderr; an injected
// runner's plain Error carries only its message.
export function ytdlpFailureText(err: unknown): string {
  const stderr = typeof err === 'object' && err !== null && 'stderr' in err ? err.stderr : undefined
  return typeof stderr === 'string' && stderr.trim() !== '' ? stderr : String(err)
}

// The catalogues yt-dlp cannot search (spec 14 §2.8): NetEase has no
// extractor search, QQ Music has no `qqmusicsearch:` prefix, so each is
// answered by its own mounted client. Wired only while that source is
// mounted.
export type ClientCatalogue = { search(query: string, limit: number): Promise<TrackCandidate[]> }

// The cookie seam (spec 14 §2.5): a leased jar for a mounted cookie source
// (its `args` ride the call, `release` runs after), null when that source
// is not mounted. Absent = no cookie ever: today's arguments byte for byte.
export type CookieLeaser = (source: CookieSource) => Promise<CookieLease | null>

export type YtDlpMusicProviderOptions = {
  binary?: string
  run?: YtDlpRunner
  cookies?: CookieLeaser
  netease?: ClientCatalogue
  qqmusic?: ClientCatalogue
  // The mood pool (spec 14 3.10): playlists other people keep, read
  // anonymously, so it is wired whether or not anything is mounted.
  playlists?: ClientCatalogue
}

// The ceiling on one yt-dlp spawn. Generous on purpose: a cold network, a
// slow extractor, or a macOS keychain prompt waiting behind another window
// each take tens of seconds on a call that then succeeds, and killing those
// costs the listener the thing they asked for. It exists to end a HANG, not
// to police slowness — raise it only if a healthy call is ever measured past
// it (the cookie export measures 0.75s, the account read 1.9s).
export const YTDLP_TIMEOUT_MS = 90_000

// A spawn that outlived the ceiling and was killed. Its own class because the
// kill leaves no stderr worth quoting: every layer above reads it to say the
// two things a listener can act on instead (spec 14 §2.8).
export class YtDlpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`yt-dlp did not answer in ${Math.max(1, Math.round(timeoutMs / 1000))}s — the network may be slow, or your system may be asking permission to read the browser's keychain in a window behind this one.`)
    this.name = 'YtDlpTimeoutError'
  }
}

// The real runner: one yt-dlp subprocess per call, under the ceiling above.
// Shared with the taste sources (spec 14 §2.8), which read the same binary.
export function ytdlpRunner(binary = 'yt-dlp', timeoutMs = YTDLP_TIMEOUT_MS): YtDlpRunner {
  return async (args, opts) => {
    debug('music.ytdlp %s', args.join(' '))
    try {
      // SIGKILL, not the default SIGTERM: a yt-dlp stuck inside the browser's
      // cookie store (the keychain prompt) is exactly the case that ignores a
      // polite signal, and a timeout nobody can enforce is no timeout.
      const { stdout } = await run(binary, args, {
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(opts?.tmpdir !== undefined && { env: { ...process.env, TMPDIR: opts.tmpdir } }),
      })
      return stdout
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'killed' in err && err.killed === true) throw new YtDlpTimeoutError(timeoutMs)
      throw err
    }
  }
}

export class YtDlpMusicProvider implements MusicProvider {
  private run: YtDlpRunner
  private opts: YtDlpMusicProviderOptions

  constructor(opts: YtDlpMusicProviderOptions) {
    this.opts = opts
    this.run = opts.run ?? ytdlpRunner(opts.binary)
  }

  async search(query: string, limit = 5, catalogue: Catalogue = 'youtube'): Promise<TrackCandidate[]> {
    // The client catalogues: each answers only while its own mount is there.
    if (catalogue === 'netease' || catalogue === 'qqmusic' || catalogue === 'playlists') {
      const client = this.opts[catalogue]
      if (client === undefined) throw new Error(`${catalogue} is not mounted`)
      return client.search(query, limit)
    }
    // Both catalogues search anonymously: a signed-in `bilisearch` can answer
    // "HTTP Error 412: Precondition Failed" (Bilibili's risk control on the
    // search API) where the same query with no cookie returns hits, and a
    // YouTube search never wanted one.
    const spec = `${catalogue === 'bilibili' ? 'bilisearch' : 'ytsearch'}${limit}:${query}`
    const stdout = await this.run(['--dump-json', '--flat-playlist', spec])
    return parseSearchOutput(stdout, limit).map((c) => ({ ...c, catalogue }))
  }

  async resolve(fullRef: string): Promise<AudioClip> {
    // A chapter ref resolves through the unchanged path: yt-dlp is handed the
    // upload, and the fragment becomes the clip's segment.
    const { url: ref, segment } = parseSegmentRef(fullRef)
    // `--print` in place of `-g`: the same single extraction yields the stream
    // url AND the track's length, which is what a progress bar needs as its
    // denominator (spec 10 §3.3). Measured at no cost over the bare `-g`.
    const dump = (cookie: string[]): Promise<string> =>
      this.run([
        '-f',
        'bestaudio/best',
        '--print',
        '%(duration)s',
        '--print',
        'urls',
        // The headers that extraction used: a Bilibili CDN answers 403 to a
        // request without them, so the decoder must send the same ones.
        '--print',
        '%(http_headers)j',
        ...cookie,
        ref,
      ])
    // YouTube plays anonymously (see the header note), so its mount never
    // reaches a resolve — except as the second chance for a video that says,
    // in words classifyAuthFailure knows, that it wants a login.
    const source = sourceOfRef(ref)
    const printed = await (source === 'youtube'
      ? this.withCookie(null, dump).catch(async (err: unknown) => {
          if (classifyAuthFailure(ytdlpFailureText(err)) === null) throw err
          // Only a jar in hand is worth a second extraction: repeating the
          // same anonymous arguments cannot answer a login wall.
          const lease = await this.leaseFor(source)
          if (lease === null) throw err
          return this.withLease(source, lease, dump)
        })
      : this.withCookie(source, dump))
    const { source: streamUrl, durationS, headers } = parseResolveOutput(printed)
    // On a segment clip the length that matters is the chapter's, never the
    // two-hour upload's: everything downstream (the coda timing, the announce,
    // the talk-ahead) reads durationS and knows nothing about segments.
    // A source shorter than the segment claims would seek past its end and
    // decode NOTHING — and ffmpeg exits 0 doing it, so the playability probe
    // would wave it through and the announce would cover silence. Fail here
    // instead, where submit_pick can tell the model to pick another. A
    // duration of 0 is "unknown" (a live stream), not "too short".
    if (segment !== undefined && durationS > 0 && segment.startS >= durationS) {
      throw new Error(`${fullRef} starts past the end of what resolved (${durationS}s)`)
    }
    const length = segment === undefined ? durationS : segment.endS - segment.startS
    return {
      source: streamUrl,
      kind: 'music',
      ...(length > 0 && { durationS: length }),
      ...(headers !== undefined && { headers }),
      ...(segment !== undefined && { segment }),
    }
  }

  // The call with the mounted host's jar leased around it, released after
  // (success or failure). A failure for a mounted host is read for its auth
  // shape (spec 14 §2.6); every other failure passes through as it always did.
  private async withCookie(source: CookieSource | null, work: (cookie: string[]) => Promise<string>): Promise<string> {
    return this.withLease(source, await this.leaseFor(source), work)
  }

  // A cookie store that cannot be read is a mount diagnosis, not a reason to
  // refuse the call: a public track resolves anonymously, exactly as it did
  // before the reader learned to report its failures. /sources is where the
  // obstacle gets said out loud.
  private async leaseFor(source: CookieSource | null): Promise<CookieLease | null> {
    if (source === null) return null
    try {
      return (await this.opts.cookies?.(source)) ?? null
    } catch (err) {
      if (!(err instanceof BrowserCookieError)) throw err
      debug('music.cookies %s unreadable: %s', source, err.reason)
      return null
    }
  }

  private async withLease(source: CookieSource | null, lease: CookieLease | null, work: (cookie: string[]) => Promise<string>): Promise<string> {
    try {
      return await work(lease?.args ?? [])
    } catch (err) {
      if (source !== null) {
        const text = ytdlpFailureText(err)
        const last = text.trim().split('\n').at(-1) ?? ''
        // Rights first: QQ Music's VIP wall wears the words of a lost login
        // (spec 14 §2.5), and reading it as one would unmount a healthy
        // account over a track the listener was never allowed to hear.
        if (rightsMiss(source, text)) throw new TrackRightsError(source, last)
        const reason = lease === null ? null : classifyAuthFailure(text)
        if (reason !== null) throw new SourceAuthError(source, reason, last)
      }
      throw err
    } finally {
      lease?.release()
    }
  }
}
