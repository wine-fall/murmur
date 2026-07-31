// The music source (spec 03-01 §2.2): search + resolve over the yt-dlp binary,
// which covers YouTube and Bilibili with no login.
//
// search runs `--dump-json --flat-playlist ytsearch{limit}:<query>` — one
// request for the whole result page (issue #76: a full per-hit extraction
// measured ~10-17s per search; flat is ~2s) whose entries still carry the
// judging signal (title, uploader, duration, view_count), so the brain can
// reject junk (hour-long loops, low-quality re-uploads) and prefer official
// audio. resolve runs `-f bestaudio/best -g` and returns a STREAM URL, never a
// download (master decision A); Phase 3's engine decodes it.
//
// yt-dlp's JSON is an untrusted boundary, so every hit is zod-parsed and a hit
// that does not fit is skipped rather than coerced.

import { execFile } from 'node:child_process'
import { debuglog, promisify } from 'node:util'

import { z } from 'zod'

import type { AudioClip, MusicProvider, TrackCandidate } from './contracts.ts'

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

export function parseStreamUrl(stdout: string): string {
  const url = stdout.split('\n').find((line) => line.trim() !== '')
  if (url === undefined) throw new Error('yt-dlp -g produced no stream url')
  return url.trim()
}

// Injectable so the unit layer covers argument construction without the binary
// or the network; the real runner is the yt-dlp subprocess.
export type YtDlpRunner = (args: string[]) => Promise<string>

export class YtDlpMusicProvider implements MusicProvider {
  private run: YtDlpRunner

  constructor({ binary = 'yt-dlp', run: runner }: { binary?: string; run?: YtDlpRunner }) {
    this.run =
      runner ??
      (async (args) => {
        debug('music.ytdlp %s', args.join(' '))
        const { stdout } = await run(binary, args, { maxBuffer: MAX_OUTPUT_BYTES })
        return stdout
      })
  }

  async search(query: string, limit = 5): Promise<TrackCandidate[]> {
    return parseSearchOutput(await this.run(['--dump-json', '--flat-playlist', `ytsearch${limit}:${query}`]), limit)
  }

  async resolve(ref: string): Promise<AudioClip> {
    return { source: parseStreamUrl(await this.run(['-f', 'bestaudio/best', '-g', ref])), kind: 'music' }
  }
}
