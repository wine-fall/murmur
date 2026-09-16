// The curated-channel search source (spec 14 §2.9): a committed list of music
// channels, refreshed from GitHub at runtime, whose recent uploads make a
// local pool the pick task can search as the `channels` catalogue.
//
// THE DISTINCTION THIS MODULE EXISTS UNDER: this list is a place to LOOK for a
// song, never taste. The listener's own accounts (spec 14 §2.3) decide WHAT
// KIND of song to look for; these channels are one of the places to look for
// it. Nothing here reaches the taste digest or the situation block, and nothing
// here describes the listener.
//
// Three things live here, in the order they run:
//   1. the manifest — one channel url per line, fetched from GitHub with the
//      committed copy as the floor, so a channel added upstream reaches a
//      listener without waiting for a release;
//   2. the pool — each channel's recent uploads (title, ref, uploader), read
//      once a day on the taste refresh's own clock and cached;
//   3. the search — a local substring match over that pool. No network at
//      search time: the pick task is already paying for a real search.
//
// Every entry point is total. A dead network, a 404, a hand-mangled cache or a
// channel behind risk control costs at most the channels that failed — never
// the feature, and never the pick.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import type { TrackCandidate } from '../contracts.ts'
import { cacheRoot } from '../paths.ts'
import type { YtDlpRunner } from './music.ts'
import { RETRY_MS, STALE_MS } from './sources/refresh.ts'
import { BilibiliSpace, type ChannelTrack } from './sources/wbi.ts'

export type { ChannelTrack }

// fileURLToPath, not URL.pathname: pathname keeps %-escapes (a checkout path
// with a space would silently read as an empty list).
export const BUNDLED_CHANNELS = fileURLToPath(new URL('../../assets/music_channels.txt', import.meta.url))

export const CHANNEL_MANIFEST_URL = 'https://raw.githubusercontent.com/wine-fall/murmur/main/assets/music_channels.txt'

// Half a day: the list changes when someone edits a file in the repo, so
// hourly would be polling a constant, and a week would make an added channel
// feel broken. The pool below refreshes on the taste clock (a day), so the
// manifest is never the reason a channel is missing for long.
export const MANIFEST_TTL_MS = 12 * 60 * 60_000

// How many recent uploads each channel contributes. Enough that a pool of a
// handful of channels has something to say about most queries, small enough
// that a refresh is a few seconds of network once a day.
export const UPLOADS_PER_CHANNEL = 20

// Bilibili answers a burst of space reads with its risk-control page; the
// refresh is a background job with a whole day to finish, so it waits.
const BETWEEN_CHANNELS_MS = 1_500

// --- chapters as songs (spec 14 §2.9) ------------------------------------- //
//
// A city-pop channel uploads one 1.5-2 h file a week and marks each song as a
// YouTube CHAPTER. Played whole it is not a song at all; played per chapter it
// is twenty. So an upload past the mix threshold below has to justify itself
// with chapters, and each chapter becomes its own candidate.

// Past this, an upload is a set, not a song — a DJ mix, a "3 hours of lofi",
// a playlist. Twelve minutes clears the longest thing anyone calls a track
// (a prog side, a live jam) and is far under the shortest thing anyone calls
// a mix. It bounds CHAPTERS too: the closing "Replay The Vibes" chapter of a
// real playlist upload is an hour-long re-run of its own first half.
export const MIX_DURATION_S = 12 * 60

// yt-dlp writes the run-up before a creator's first marker as a placeholder
// chapter with this exact title.
const PLACEHOLDER_CHAPTER = /^<untitled chapter \d+>$/i

// Under this a chapter is an intro, an outro or a sting, not a song.
export const MIN_CHAPTER_S = 45

// One upload can carry 29 chapters. Twelve is an evening's worth from a single
// file and leaves room in the pool for the other channels.
export const MAX_CHAPTERS_PER_UPLOAD = 12

// The ceiling on what one channel puts in the pool, so 20 uploads x 29
// chapters cannot swamp the `channels` catalogue and crowd out everyone else.
export const TRACKS_PER_CHANNEL = 40

// Full metadata costs one yt-dlp extraction per upload (~2 s), and only a long
// upload is ever asked. Four per channel per refresh bounds a daily refresh at
// a few seconds of extra network per channel; the rest of that channel's long
// uploads are read on a later refresh, out of the cache below or fresh.
export const CHAPTER_LOOKUPS_PER_CHANNEL = 4

// Paid once per upload: an upload's chapter split does not change. Bounded so
// a year of channel history cannot grow the file without limit.
const CHAPTER_CACHE_ENTRIES = 500

const ManifestCacheSchema = z.object({ at: z.number(), text: z.string() })
const TrackSchema = z.object({ ref: z.string().min(1), title: z.string().min(1), uploader: z.string(), durationS: z.number() })
const PoolCacheSchema = z.object({ at: z.number(), tracks: z.array(TrackSchema) })
const ChapterCacheSchema = z.record(z.string(), z.array(TrackSchema))

// One url per line; `#` comments, blanks and anything that is not an http(s)
// url are skipped. A listener edits this by adding a line, so a line they got
// wrong must cost that line and nothing else.
export function parseChannelManifest(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && /^https?:\/\//.test(line))
}

export function channelsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), 'channels')
}

function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// Temp-file + rename (the settings discipline) so a reader never sees a torn
// file. A cache that cannot be written is a cache miss, not a failure.
function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(value), 'utf8')
    renameSync(temp, path)
  } catch {
    /* a cache is rebuildable by definition */
  }
}

function bundled(path: string): string[] {
  try {
    return parseChannelManifest(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

export type ManifestDeps = {
  dir?: string
  bundledPath?: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  ttlMs?: number
  now?: () => number
}

// The channel list, in order of preference: a cache inside its TTL, a fresh
// fetch, a stale cache, the copy that shipped. Total — the fallback chain is
// the feature's guarantee that a network hiccup never costs it.
export async function loadChannelManifest(deps: ManifestDeps = {}): Promise<string[]> {
  const path = join(deps.dir ?? channelsCacheDir(), 'manifest.json')
  const now = (deps.now ?? Date.now)()
  const cached = readJson(path, ManifestCacheSchema)
  const fromCache = cached === null ? [] : parseChannelManifest(cached.text)
  if (cached !== null && fromCache.length > 0 && now - cached.at < (deps.ttlMs ?? MANIFEST_TTL_MS)) return fromCache

  const text = await fetchManifest(deps)
  if (text !== null) {
    const fresh = parseChannelManifest(text)
    // A body with no channels in it is a 404 page or a half-written file, not
    // "the list is now empty": it must not overwrite what already works.
    if (fresh.length > 0) {
      writeJson(path, { at: now, text })
      return fresh
    }
  }
  return fromCache.length > 0 ? fromCache : bundled(deps.bundledPath ?? BUNDLED_CHANNELS)
}

async function fetchManifest(deps: ManifestDeps): Promise<string | null> {
  const get = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  try {
    const response = await get(CHANNEL_MANIFEST_URL, { signal: AbortSignal.timeout(10_000) })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

const FlatSchema = z.object({
  title: z.string().min(1),
  url: z.string().nullish(),
  webpage_url: z.string().nullish(),
  duration: z.number().nullish(),
  uploader: z.string().nullish(),
  channel: z.string().nullish(),
  // A channel listing names the channel here and leaves `uploader` null.
  playlist_uploader: z.string().nullish(),
})

// yt-dlp's `--dump-json --flat-playlist` output, one JSON object per line. An
// untrusted boundary like every other yt-dlp read: a row that does not fit is
// skipped, never coerced.
export function parseFlatUploads(stdout: string, limit: number): ChannelTrack[] {
  const tracks: ChannelTrack[] = []
  for (const line of stdout.split('\n')) {
    if (tracks.length >= limit) break
    const text = line.trim()
    if (text === '') continue
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      continue // yt-dlp chatter on stdout, not an entry
    }
    const row = FlatSchema.safeParse(json)
    if (!row.success) continue
    const ref = row.data.webpage_url ?? row.data.url
    if (ref == null || ref === '') continue
    tracks.push({
      ref,
      title: row.data.title,
      uploader: row.data.playlist_uploader ?? row.data.uploader ?? row.data.channel ?? '',
      durationS: Math.trunc(row.data.duration ?? 0),
    })
  }
  return tracks
}

export type Chapter = { start_time: number; end_time: number; title: string }

const FullMetaSchema = z.object({
  chapters: z.array(z.object({ start_time: z.number(), end_time: z.number(), title: z.string() })).nullish(),
})

// `yt-dlp --dump-json <video>` (full metadata, NOT --flat-playlist — the flat
// listing the pool is built from carries no chapters at all). An untrusted
// boundary like every other yt-dlp read: [] = this upload has no chapters,
// null = yt-dlp said something that is not an upload, which is not the same
// answer and must not be cached as one.
export function parseChapters(stdout: string): Chapter[] | null {
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      continue
    }
    const meta = FullMetaSchema.safeParse(json)
    if (meta.success) return meta.data.chapters ?? []
  }
  return null
}

// One upload's chapters as pool candidates: the chapter title is the song, the
// channel is the uploader, the chapter's length is the length, and the ref is
// the upload's own url carrying a W3C media fragment (`#t=<start>,<end>`, in
// seconds) that resolve strips back off (spec 03-01 §2.2).
export function chapterTracks(upload: ChannelTrack, chapters: readonly Chapter[]): ChannelTrack[] {
  const tracks: ChannelTrack[] = []
  for (const chapter of chapters) {
    if (tracks.length >= MAX_CHAPTERS_PER_UPLOAD) break
    const title = chapter.title.trim()
    const startS = Math.trunc(chapter.start_time)
    const endS = Math.trunc(chapter.end_time)
    const lengthS = endS - startS
    if (title === '' || PLACEHOLDER_CHAPTER.test(title)) continue
    if (lengthS < MIN_CHAPTER_S || lengthS > MIX_DURATION_S) continue
    tracks.push({ ref: `${upload.ref}#t=${startS},${endS}`, title, uploader: upload.uploader, durationS: lengthS })
  }
  return tracks
}

const BILIBILI_SPACE = /^https?:\/\/space\.bilibili\.com\/(\d+)\b/

export type UploadsDeps = { run: YtDlpRunner; space: Pick<BilibiliSpace, 'recent'>; dir?: string }

// One channel's recent uploads, by the shape of its url. YouTube goes through
// yt-dlp, whose flat listing carries the titles; Bilibili goes through the
// signed space API, because yt-dlp's flat listing of a space returns the refs
// with every title empty (spec 14 §2.9). An unrecognised url is skipped.
export function channelUploads(deps: UploadsDeps): (url: string, limit: number) => Promise<ChannelTrack[]> {
  return async (url, limit) => {
    const space = BILIBILI_SPACE.exec(url)
    if (space !== null) return await deps.space.recent(space[1] ?? '', limit)
    if (!/^https?:\/\/(www\.)?youtube\.com\//.test(url)) return []
    const stdout = await deps.run(['--dump-json', '--flat-playlist', '--playlist-end', String(limit), '--no-warnings', url])
    return await withChapters(deps, parseFlatUploads(stdout, limit))
  }
}

// The chapter pass over one channel's flat listing. A short upload is a song
// and passes through untouched; a long one is a mix unless its chapters say
// otherwise, and then it is not one candidate but many. The cost is bounded
// twice over — by the cache (an upload is read once, ever) and by the lookup
// budget (a channel asks for at most a handful of extractions per refresh).
// A length of 0 is "unknown", not "long": a live stream or an extractor that
// omits the field keeps today's behaviour.
async function withChapters(deps: UploadsDeps, uploads: ChannelTrack[]): Promise<ChannelTrack[]> {
  const path = join(deps.dir ?? channelsCacheDir(), 'chapters.json')
  const cache = readJson(path, ChapterCacheSchema) ?? {}
  const tracks: ChannelTrack[] = []
  let lookups = 0
  let wrote = false
  for (const upload of uploads) {
    if (tracks.length >= TRACKS_PER_CHANNEL) break
    if (upload.durationS === 0 || upload.durationS <= MIX_DURATION_S) {
      tracks.push(upload)
      continue
    }
    let chapters = cache[upload.ref]
    if (chapters === undefined) {
      if (lookups >= CHAPTER_LOOKUPS_PER_CHANNEL) continue
      lookups++
      const read = await readChapters(deps, upload)
      // A video that would not answer costs that video and is not cached as
      // "no chapters": the next refresh asks again.
      if (read === null) continue
      chapters = read
      cache[upload.ref] = read
      wrote = true
    }
    tracks.push(...chapters.slice(0, TRACKS_PER_CHANNEL - tracks.length))
  }
  if (wrote) writeJson(path, Object.fromEntries(Object.entries(cache).slice(-CHAPTER_CACHE_ENTRIES)))
  return tracks
}

async function readChapters(deps: UploadsDeps, upload: ChannelTrack): Promise<ChannelTrack[] | null> {
  try {
    const chapters = parseChapters(await deps.run(['--dump-json', '--no-warnings', upload.ref]))
    return chapters === null ? null : chapterTracks(upload, chapters)
  } catch {
    return null
  }
}

export type ChannelPoolDeps = {
  dir?: string
  manifest?: () => Promise<string[]>
  uploads?: (url: string, limit: number) => Promise<ChannelTrack[]>
  staleMs?: number
  retryMs?: number
  pauseMs?: number
  now?: () => number
  debug?: (message: string) => void
}

// The pool of recent uploads, and the local search over it. One refresh at a
// time, on the taste refresh's own clock — there is no second scheduler here,
// only a staleness gate and a single-flight guard, poked from where the music
// pipeline already runs.
export class ChannelPool {
  private deps: ChannelPoolDeps
  private dir: string
  private tracks: ChannelTrack[]
  private at: number
  private running: Promise<unknown> | null = null
  // When a refresh was last attempted, success or failure — in memory, so a
  // restart tries again at once. Without it an offline listener would respawn
  // yt-dlp over the whole list once a song: `at` only moves on success.
  private tried: number | null = null

  constructor(deps: ChannelPoolDeps = {}) {
    this.deps = deps
    this.dir = deps.dir ?? channelsCacheDir()
    const cached = readJson(join(this.dir, 'pool.json'), PoolCacheSchema)
    this.tracks = cached?.tracks ?? []
    this.at = cached?.at ?? 0
  }

  count(): number {
    return this.tracks.length
  }

  // The background poke. True when a refresh started; false when one is
  // already running or the pool is still fresh.
  maybeRefresh(): boolean {
    if (this.running !== null) return false
    // Empty is always due — the same "no snapshot yet" the taste refresh
    // treats as stale, and the only reason a first run ever builds a pool.
    const now = this.now()
    if (this.tried !== null && now - this.tried < (this.deps.retryMs ?? RETRY_MS)) return false
    if (this.tracks.length > 0 && now - this.at < (this.deps.staleMs ?? STALE_MS)) return false
    const work = this.refresh()
    this.running = work.finally(() => (this.running = null))
    return true
  }

  // For a caller that wants the background work finished (tests, /sources).
  async idle(): Promise<void> {
    await this.running?.catch(() => {})
  }

  // Read every listed channel, keep what answered, cache it. Returns how many
  // tracks the pool now holds. Never throws: a refresh that falls over leaves
  // the pool exactly as it was.
  async refresh(): Promise<number> {
    this.tried = this.now()
    const read = this.deps.uploads ?? (() => Promise.resolve([]))
    let urls: string[]
    try {
      urls = await (this.deps.manifest ?? (() => loadChannelManifest({ dir: this.dir })))()
    } catch (err) {
      this.deps.debug?.(`channels.refresh manifest failed: ${String(err)}`)
      return this.tracks.length
    }
    const found: ChannelTrack[] = []
    const seen = new Set<string>()
    for (const [index, url] of urls.entries()) {
      if (index > 0) await pause(this.deps.pauseMs ?? BETWEEN_CHANNELS_MS)
      try {
        for (const track of await read(url, UPLOADS_PER_CHANNEL)) {
          if (seen.has(track.ref)) continue
          seen.add(track.ref)
          found.push(track)
        }
      } catch (err) {
        // One channel behind risk control or renamed out from under the list
        // costs that channel, not the pool.
        this.deps.debug?.(`channels.refresh ${url} failed: ${String(err)}`)
      }
    }
    // Nothing came back at all: keep what the pool already had rather than
    // emptying it, which would silently unmount the catalogue.
    if (found.length === 0) return this.tracks.length
    this.tracks = found
    this.at = this.now()
    writeJson(join(this.dir, 'pool.json'), { at: this.at, tracks: this.tracks })
    this.deps.debug?.(`channels.refresh n=${found.length} channels=${urls.length}`)
    return found.length
  }

  // The `channels` catalogue's search: every word of the query has to appear
  // in the title or the uploader. Local, so it costs nothing and cannot fail.
  search(query: string, limit = 5): TrackCandidate[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '')
    const hits = this.tracks.filter((t) => {
      const haystack = `${t.title} ${t.uploader}`.toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
    return hits.slice(0, limit).map((t) => ({
      ref: t.ref,
      title: t.title,
      uploader: t.uploader,
      durationS: t.durationS,
      extra: {},
      catalogue: 'channels' as const,
    }))
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}

const pause = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)))
