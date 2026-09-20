// Play-source preference (spec 14 §2.13, acceptance §5.17): a song FOUND on
// any mounted catalogue is PLAYED from the catalogue highest in the play
// order. The relocation is code's, never the model's — these tests drive
// submit_pick directly and read the clip it finishes with.
import { describe, expect, it } from 'vitest'

import type { Catalogue, PlayCatalogue, TrackCandidate, TrackPick } from '../src/contracts.ts'
import { musicTools } from '../src/music/music-tools.ts'
import { SourceAuthError } from '../src/music/sources/auth.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

const NETEASE_REF = 'https://music.163.com/#/song?id=5'

function candidate(ref: string, over: Partial<TrackCandidate> = {}): TrackCandidate {
  return { ref, title: 'Kong Kong', uploader: 'Chen Li', durationS: 240, extra: {}, ...over }
}

function build(opts: {
  mounted?: Catalogue[]
  playOrder?: PlayCatalogue[]
  byCatalogue?: Partial<Record<Catalogue, TrackCandidate[] | Error>>
  broken?: string[]
  dead?: string[]
} = {}) {
  const provider = new FakeMusicProvider()
  provider.candidates = [candidate(NETEASE_REF)]
  provider.byCatalogue = { netease: [candidate(NETEASE_REF)], youtube: [], bilibili: [], qqmusic: [], ...opts.byCatalogue }
  for (const ref of opts.broken ?? []) provider.broken.add(ref)
  const dead = new Set(opts.dead ?? [])
  const picks: TrackPick[] = []
  const auth: SourceAuthError[] = []
  const log: string[] = []
  const tools = musicTools(
    provider,
    (pick) => picks.push(pick),
    async (source) => !dead.has(source),
    {
      catalogues: () => opts.mounted ?? ['netease', 'bilibili'],
      onAuthFailure: (err) => auth.push(err),
      ...(opts.playOrder !== undefined && { playOrder: opts.playOrder }),
      debug: (m) => log.push(m),
    },
  )
  return { provider, tools, picks, auth, log }
}

const submit = (tools: ReturnType<typeof build>['tools'], over: Record<string, unknown> = {}) =>
  callTool(tools, 'submit_pick', { ref: NETEASE_REF, why: 'w', title: 'Kong Kong', artist: 'Chen Li', ...over })

// The searches a relocation ran, in order — the netease search that seeded
// the stated length is not one of them.
const relocations = (provider: FakeMusicProvider) => provider.searches.filter((s) => s.catalogue !== 'netease')

describe('play-source preference (spec 14 §2.13)', () => {
  it('plays a NetEase pick from YouTube when YouTube has the same song', async () => {
    const yt = 'https://www.youtube.com/watch?v=abc'
    const { tools, picks, provider, log } = build({ byCatalogue: { youtube: [candidate(yt, { durationS: 238 })] } })
    await callTool(tools, 'search_music', { query: 'kong kong', catalogue: 'netease' })
    const result = await submit(tools)

    expect(result.ok).toBe(true)
    expect(picks[0]?.clip.source).toBe(`https://stream/${yt}`)
    // The model's own words survive the relocation; only the clip moved.
    expect(picks[0]).toMatchObject({ title: 'Kong Kong', artist: 'Chen Li' })
    expect(relocations(provider)[0]).toEqual({ query: 'Chen Li Kong Kong', limit: 5, catalogue: 'youtube' })
    expect(log).toContain('music.relocate from=netease to=youtube ok')
  })

  it('refuses a hit more than 20 s off, falls to bilibili, then keeps the original', async () => {
    const { tools, picks, provider, log } = build({
      byCatalogue: {
        youtube: [candidate('https://www.youtube.com/watch?v=abc', { durationS: 300 })],
        bilibili: [candidate('https://www.bilibili.com/video/BV1', { title: 'something else' })],
      },
    })
    await callTool(tools, 'search_music', { query: 'kong kong', catalogue: 'netease' })
    await submit(tools)

    expect(picks[0]?.clip.source).toBe(`https://stream/${NETEASE_REF}`)
    expect(relocations(provider).map((s) => s.catalogue)).toEqual(['youtube', 'bilibili'])
    expect(log).toContain('music.relocate from=netease none reason=no-hit')
  })

  it('does not relocate a submit that carries no title', async () => {
    const { tools, picks, provider, log } = build()
    await submit(tools, { title: undefined, artist: undefined })
    expect(picks[0]?.clip.source).toBe(`https://stream/${NETEASE_REF}`)
    expect(relocations(provider)).toEqual([])
    expect(log.filter((l) => l.startsWith('music.relocate'))).toEqual([])
  })

  it('does not relocate a segment ref', async () => {
    const ref = 'https://www.bilibili.com/video/BV1#t=612,868'
    const { tools, picks, provider } = build({ mounted: ['bilibili'] })
    await callTool(tools, 'submit_pick', { ref, why: 'w', title: 'Kong Kong' })
    expect(picks[0]?.clip.segment).toEqual({ startS: 612, endS: 868 })
    expect(relocations(provider)).toEqual([])
  })

  it('does not relocate a ref whose catalogue is already top-ranked', async () => {
    const { tools, provider } = build({ mounted: ['netease'] })
    await callTool(tools, 'submit_pick', { ref: 'https://www.youtube.com/watch?v=abc', why: 'w', title: 'Kong Kong' })
    expect(relocations(provider)).toEqual([])
  })

  it('closes a catalogue whose relocation search hits auth, and still finishes the submit', async () => {
    const { tools, picks, auth, provider, log } = build({
      byCatalogue: { youtube: new SourceAuthError('youtube', 'login-required', 'expired') },
    })
    const result = await submit(tools)

    expect(result.ok).toBe(true)
    expect(picks[0]?.clip.source).toBe(`https://stream/${NETEASE_REF}`)
    expect(auth.map((e) => e.source)).toEqual(['youtube'])
    expect(relocations(provider).map((s) => s.catalogue)).toEqual(['youtube', 'bilibili'])
    expect(log).toContain('music.relocate from=netease none reason=auth')
    // The closed catalogue is gone from what search_music will still take.
    expect(await callTool(tools, 'search_music', { query: 'q', catalogue: 'youtube' })).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('falls past a hit that resolves but does not play', async () => {
    const yt = 'https://www.youtube.com/watch?v=abc'
    const bili = 'https://www.bilibili.com/video/BV1'
    const { tools, picks, log } = build({
      byCatalogue: { youtube: [candidate(yt)], bilibili: [candidate(bili)] },
      dead: [`https://stream/${yt}`],
    })
    await submit(tools)
    expect(picks[0]?.clip.source).toBe(`https://stream/${bili}`)
    expect(log).toContain('music.relocate from=netease to=bilibili ok')
  })

  it('walks the configured play order', async () => {
    const { tools, provider, log } = build({
      playOrder: ['bilibili', 'youtube', 'qqmusic', 'netease'],
    })
    await submit(tools)
    expect(relocations(provider).map((s) => s.catalogue)).toEqual(['bilibili', 'youtube'])
    expect(log).toContain('music.relocate from=netease none reason=no-hit')
  })
})
