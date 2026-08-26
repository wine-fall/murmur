// The listening-data source behind similar_music / top_tracks (spec 03-01
// §2.3) — the `ListeningData` contract's one adapter, as `music.ts` is the
// `MusicProvider`'s.
//
// Why the seam exists: search_music EXECUTES a search, it does not recommend,
// so the candidate list is only ever as wide as what the model remembers
// first — which is how a personal radio ends up playing the same few famous
// songs forever. Real play data is a different source than the model's memory,
// at both levels: which artist, and which of theirs.
//
// The adapter here is Last.fm's public API (artist.getsimilar,
// track.getsimilar, artist.gettoptracks), read-only and account-free: it needs
// a free API key, never a listener's Last.fm login. No key = the tools are not
// offered at all, and discovery runs on search alone. Another catalogue with
// the same three answers would implement the same contract and change nothing
// above it.
//
// The API is an untrusted boundary (issue #54 rule): every hit is zod-parsed,
// and a hit that does not fit is skipped rather than coerced.

import { z } from 'zod'

import type { ListeningData, SimilarTrack } from './contracts.ts'

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/'

// A pick is on the clock: the Director is waiting to fill a boundary, so a
// hung lookup must fail fast and let the task fall back to plain search.
const DEFAULT_TIMEOUT_MS = 8_000

const NamedSchema = z.object({ name: z.string().min(1) })

const ErrorSchema = z.object({ message: z.string().min(1) })

const ArtistsSchema = z.object({
  similarartists: z.object({ artist: z.array(z.unknown()).optional() }),
})

const TracksSchema = z.object({
  similartracks: z.object({ track: z.array(z.unknown()).optional() }),
})

const TrackSchema = z.object({ name: z.string().min(1), artist: NamedSchema })

const TopTracksSchema = z.object({
  toptracks: z.object({ track: z.array(z.unknown()).optional() }),
})

export type LastfmOptions = {
  apiKey: string
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

export class LastfmListening implements ListeningData {
  private opts: LastfmOptions
  private fetch: typeof fetch

  constructor(opts: LastfmOptions) {
    this.opts = opts
    this.fetch = opts.fetch ?? fetch
  }

  async artists(artist: string, limit: number): Promise<string[]> {
    const json = await this.call('artist.getsimilar', { artist, limit: String(limit) })
    const hits = ArtistsSchema.safeParse(json)
    if (!hits.success) return []
    return (hits.data.similarartists.artist ?? [])
      .map((hit) => NamedSchema.safeParse(hit))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data.name)
  }

  async tracks(artist: string, track: string, limit: number): Promise<SimilarTrack[]> {
    const json = await this.call('track.getsimilar', { artist, track, limit: String(limit) })
    const hits = TracksSchema.safeParse(json)
    if (!hits.success) return []
    return (hits.data.similartracks.track ?? [])
      .map((hit) => TrackSchema.safeParse(hit))
      .filter((parsed) => parsed.success)
      .map((parsed) => ({ title: parsed.data.name, artist: parsed.data.artist.name }))
  }

  async topTracks(artist: string, limit: number): Promise<string[]> {
    const json = await this.call('artist.gettoptracks', { artist, limit: String(limit) })
    const hits = TopTracksSchema.safeParse(json)
    if (!hits.success) return []
    return (hits.data.toptracks.track ?? [])
      .map((hit) => NamedSchema.safeParse(hit))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data.name)
  }

  private async call(method: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(ENDPOINT)
    url.search = new URLSearchParams({
      ...params,
      method,
      api_key: this.opts.apiKey,
      format: 'json',
      // Last.fm matches a misspelled or differently-cased seed to its own
      // catalog name; without it a near-miss returns nothing at all.
      autocorrect: '1',
    }).toString()

    const response = await this.fetch(url, {
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`last.fm ${method} failed: HTTP ${response.status}`)
    const json: unknown = await response.json()
    // The API answers 200 with an error body, so the status alone proves nothing.
    const failed = ErrorSchema.safeParse(json)
    if (failed.success) throw new Error(`last.fm ${method} failed: ${failed.data.message}`)
    return json
  }
}
