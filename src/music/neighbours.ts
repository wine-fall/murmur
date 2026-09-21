// The neighbours of the song on air (spec 14 §3.10): the platform's own
// "next to this one" list, read in the background WHILE that song plays and
// answered from cache at the next pick.
//
// Primed from `submit_pick`, once the pick is committed: the pick that
// follows is searched during this one's airtime, so a ~15 s read of the
// YouTube auto-mix costs the listener nothing. Nothing here is ever on the
// pick's own path — `search` reads the cache and returns.

import type { TrackCandidate } from '../contracts.ts'

// The two platforms that answer a useful "songs like this one" for free:
// NetEase's simiSong (anonymous) and YouTube's auto-mix. QQ Music's
// GetSimilarSongs answers null on every seed measured, and Bilibili's related
// list is re-uploads and reaction videos.
const SEEDS: [RegExp, 'netease' | 'youtube'][] = [
  [/music\.163\.com.*[?&]id=(\d+)/, 'netease'],
  [/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/, 'youtube'],
]

// What one seed is worth reading: NetEase answers five, and the YouTube mix
// is capped where it is read (music.ts).
export const NEIGHBOUR_ITEMS = 5

export type NeighbourPoolDeps = {
  similar?: (songId: string) => Promise<TrackCandidate[]>
  mix?: (videoId: string) => Promise<TrackCandidate[]>
  log?: (message: string) => void
}

export class NeighbourPool {
  private deps: NeighbourPoolDeps
  private songs: TrackCandidate[] = []
  private seeded = ''

  constructor(deps: NeighbourPoolDeps) {
    this.deps = deps
  }

  // Fire-and-forget: it resolves, it never rejects, and the same ref twice is
  // one read.
  async prime(ref: string): Promise<void> {
    const seed = SEEDS.map(([re, where]) => [re.exec(ref)?.[1], where] as const).find(([id]) => id !== undefined)
    const read = seed === undefined ? undefined : seed[1] === 'netease' ? this.deps.similar : this.deps.mix
    // The catalogue says these are the neighbours of the song ON AIR, so a
    // song no platform here can seed from leaves an empty pool rather than
    // the previous song's neighbours wearing this song's name.
    if (seed === undefined || read === undefined || seed[0] === undefined) {
      this.seeded = ''
      this.songs = []
      return
    }
    const [id, where] = seed
    if (this.seeded === `${where}:${id}`) return
    const key = `${where}:${id}`
    this.seeded = key
    try {
      const found = await read(id)
      // Counts only, never a title (spec 14 §3.6).
      this.deps.log?.(`music.neighbours ${where} n=${found.length}`)
      // Two primes can overlap -- the queue runs two picks ahead and a mix
      // read takes ~15 s -- and the pool belongs to the newest seed, not to
      // whichever read finished last.
      if (this.seeded === key) this.songs = found
    } catch (err) {
      this.deps.log?.(`music.neighbours ${where} failed: ${String(err)}`)
    }
  }

  // The catalogue seam: whatever the last prime left, never a network round.
  // The query is ignored — the pool IS the query.
  async search(_query: string, limit: number): Promise<TrackCandidate[]> {
    return this.songs.slice(0, limit)
  }
}
