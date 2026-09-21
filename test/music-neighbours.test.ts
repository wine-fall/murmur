// Neighbours of the song on air (spec 14 §3.10 step 4): read in the
// background WHILE that song plays and read from cache at the next pick, so
// the pool never costs the pick a second.
import { describe, expect, it } from 'vitest'

import type { TrackCandidate, TrackPick } from '../src/contracts.ts'
import { musicTools } from '../src/music/music-tools.ts'
import { NeighbourPool } from '../src/music/neighbours.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

const NETEASE = 'https://music.163.com/#/song?id=5'
const YOUTUBE = 'https://www.youtube.com/watch?v=abc123'

const candidate = (ref: string): TrackCandidate => ({ ref, title: `track ${ref}`, uploader: 'someone', durationS: 200, extra: {}, catalogue: 'netease' })

function pool(over: Partial<{ similar: (id: string) => Promise<TrackCandidate[]>; mix: (id: string) => Promise<TrackCandidate[]> }> = {}) {
  const asked: string[] = []
  const log: string[] = []
  const p = new NeighbourPool({
    similar: over.similar ?? (async (id) => (asked.push(`netease:${id}`), [candidate(`n${id}`)])),
    mix: over.mix ?? (async (id) => (asked.push(`youtube:${id}`), [candidate(`y${id}`)])),
    log: (m) => log.push(m),
  })
  return { p, asked, log }
}

describe('NeighbourPool', () => {
  it('reads the neighbours of a NetEase song by its id', async () => {
    const { p, asked } = pool()
    await p.prime(NETEASE)
    expect(asked).toEqual(['netease:5'])
    expect(await p.search('', 5)).toEqual([candidate('n5')])
  })

  it('reads the auto-mix of a YouTube video by its id, in both spellings', async () => {
    const { p, asked } = pool()
    await p.prime(YOUTUBE)
    await p.prime('https://youtu.be/xyz789')
    expect(asked).toEqual(['youtube:abc123', 'youtube:xyz789'])
  })

  it('primes a ref once, however many times the same song is submitted', async () => {
    const { p, asked } = pool()
    await p.prime(NETEASE)
    await p.prime(NETEASE)
    expect(asked).toHaveLength(1)
  })

  it('keeps the pool it has when a read fails, and logs a count with no title', async () => {
    const { p, log } = pool()
    await p.prime(NETEASE)
    const failing = pool({ similar: async () => Promise.reject(new Error('boom')) })
    await failing.p.prime(NETEASE)
    expect(await failing.p.search('', 5)).toEqual([])
    expect(failing.log.join()).toMatch(/music\.neighbours netease failed/)
    expect(log.join()).toContain('music.neighbours netease n=1')
    expect(log.join()).not.toContain('track')
  })

  // Two primes can overlap: the queue runs two picks ahead, and a YouTube
  // mix takes ~15 s. The pool must hold the song on air, not whichever read
  // happened to finish last.
  it('keeps the newest seed when an older read lands after it', async () => {
    let releaseSlow = (): void => {}
    const slow = new Promise<void>((r) => (releaseSlow = r))
    const { p } = pool({
      mix: async (id) => {
        await slow
        return [candidate(`y${id}`)]
      },
    })
    const first = p.prime(YOUTUBE)
    await p.prime(NETEASE)
    releaseSlow()
    await first
    expect(await p.search('', 5)).toEqual([candidate('n5')])
  })

  // The catalogue describes itself as the neighbours of the song ON AIR, so
  // a song no platform here can seed from leaves an empty pool, never the
  // previous song's neighbours wearing this song's name.
  it('has nothing to say for a ref no platform here can seed from', async () => {
    const { p, asked } = pool()
    await p.prime('https://www.bilibili.com/video/BV1')
    expect(asked).toEqual([])
    expect(await p.search('', 5)).toEqual([])
    await p.prime(NETEASE)
    expect(await p.search('', 5)).toHaveLength(1)
    await p.prime('https://y.qq.com/n/ryqq/songDetail/abc')
    expect(await p.search('', 5)).toEqual([])
  })

  // A read that failed is not a song with no neighbours: keeping what the
  // pool had is worth more to the next pick than an empty shelf.
  it('keeps the pool when the read throws, and empties it when the platform truly has none', async () => {
    const { p } = pool()
    await p.prime(NETEASE)
    const thrown = pool({ mix: async () => Promise.reject(new Error('yt-dlp timed out')) })
    await thrown.p.prime(NETEASE)
    await thrown.p.prime(YOUTUBE)
    expect(await thrown.p.search('', 5)).toEqual([candidate('n5')])
    const empty = pool({ mix: async () => [] })
    await empty.p.prime(NETEASE)
    await empty.p.prime(YOUTUBE)
    expect(await empty.p.search('', 5)).toEqual([])
  })

  it('answers the cache and never the network, at pick time', async () => {
    const { p } = pool()
    await p.prime(NETEASE)
    const before = await p.search('', 1)
    expect(before).toHaveLength(1)
    // A second read while nothing new was primed is the same cached answer.
    expect(await p.search('anything at all', 5)).toEqual(before)
  })

  it('keeps no more than the cap it was given', async () => {
    const { p } = pool({ similar: async () => Array.from({ length: 30 }, (_, i) => candidate(`n${i}`)) })
    await p.prime(NETEASE)
    expect((await p.search('', 3))).toHaveLength(3)
  })
})

describe('submit_pick primes the pool for the next pick (spec 14 §3.10)', () => {
  function build() {
    const provider = new FakeMusicProvider()
    provider.candidates = [{ ref: NETEASE, title: 'Song', uploader: 'Artist', durationS: 200, extra: {} }]
    const picks: TrackPick[] = []
    const primed: string[] = []
    const tools = musicTools(provider, (pick) => picks.push(pick), undefined, undefined, undefined, [], {
      prime: (ref) => void primed.push(ref),
    })
    return { tools, picks, primed, provider }
  }

  it('primes with the ref it just committed to, after the pick is finished', async () => {
    const { tools, picks, primed } = build()
    const result = await callTool(tools, 'submit_pick', { ref: NETEASE, why: 'w', title: 'Song', artist: 'Artist' })
    expect(result.ok).toBe(true)
    expect(picks).toHaveLength(1)
    expect(primed).toEqual([NETEASE])
  })

  it('primes nothing when the submit was refused', async () => {
    const { tools, primed } = build()
    await callTool(tools, 'submit_pick', { ref: NETEASE, why: 'w', title: '', artist: '' })
    expect(primed).toEqual([])
  })

  it('offers the catalogue only while the pool is wired', () => {
    const { tools } = build()
    const wired = tools.find((t) => t.name === 'search_music')!
    expect(String(wired.description)).toContain('neighbours')
    const bare = musicTools(new FakeMusicProvider(), () => {}).find((t) => t.name === 'search_music')!
    expect(String(bare.description)).not.toContain('neighbours')
  })
})
