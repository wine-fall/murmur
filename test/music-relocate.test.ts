// Play-source preference (spec 14 §2.13, acceptance §5.17): a song FOUND on
// any mounted catalogue is PLAYED from the catalogue highest in the play
// order. The relocation is code's, never the model's — these tests drive
// submit_pick directly and read the clip it finishes with.
import { describe, expect, it, vi } from 'vitest'

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
      ...(opts.playOrder !== undefined && { playOrder: () => opts.playOrder as PlayCatalogue[] }),
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

  // A submit that names nothing cannot be looked for elsewhere -- and is no
  // longer accepted at all (spec 14 §3.10), so nothing resolves either.
  it('turns back a submit that carries no title instead of resolving it', async () => {
    const { tools, picks, provider, log } = build()
    const result = await submit(tools, { title: undefined, artist: undefined })
    expect(result.ok).toBe(false)
    expect(picks).toHaveLength(0)
    expect(relocations(provider)).toEqual([])
    expect(log.filter((l) => l.startsWith('music.relocate'))).toEqual([])
  })

  it('does not relocate a segment ref', async () => {
    const ref = 'https://www.bilibili.com/video/BV1#t=612,868'
    const { tools, picks, provider } = build({ mounted: ['bilibili'] })
    await callTool(tools, 'submit_pick', { ref, why: 'w', title: 'Kong Kong', artist: 'Chen Li' })
    expect(picks[0]?.clip.segment).toEqual({ startS: 612, endS: 868 })
    expect(relocations(provider)).toEqual([])
  })

  it('does not relocate a ref whose catalogue is already top-ranked', async () => {
    const { tools, provider } = build({ mounted: ['netease'] })
    await callTool(tools, 'submit_pick', { ref: 'https://www.youtube.com/watch?v=abc', why: 'w', title: 'Kong Kong', artist: 'Chen Li' })
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

  // Regression, codex review 2026-09-20: a karaoke backing track is the right
  // length under the right name, and relocating onto one plays the wrong audio
  // under the model's own announce.
  it('refuses another recording of the same title', async () => {
    const { tools, picks } = build({
      byCatalogue: {
        youtube: [candidate('https://www.youtube.com/watch?v=abc', { title: 'Kong Kong - Karaoke instrumental', uploader: 'sing along', durationS: 239 })],
      },
    })
    await callTool(tools, 'search_music', { query: 'kong kong', catalogue: 'netease' })
    await submit(tools)
    expect(picks[0]?.clip.source).toBe(`https://stream/${NETEASE_REF}`)
  })

  // Regression, codex review 2026-09-20: the artist has to show up somewhere in
  // the hit, or a same-titled song by someone else takes the pick.
  it('refuses a same-titled hit by someone else', async () => {
    const { tools, picks } = build({
      byCatalogue: { youtube: [candidate('https://www.youtube.com/watch?v=abc', { uploader: 'Another Band' })] },
    })
    await submit(tools)
    expect(picks[0]?.clip.source).toBe(`https://stream/${NETEASE_REF}`)
    // The same hit, with the artist in its uploader, IS taken.
    const ok = build({ byCatalogue: { youtube: [candidate('https://www.youtube.com/watch?v=abc', { uploader: 'Chen Li - Topic' })] } })
    await submit(ok.tools)
    expect(ok.picks[0]?.clip.source).toBe('https://stream/https://www.youtube.com/watch?v=abc')
  })

  // Regression, codex review 2026-09-20: a channels pick knows its length, so
  // the 20 s window must cover that path too — a 3600 s loop version of the
  // same title is not the song.
  it("keeps a channels candidate's stated length for the window", async () => {
    const bili = 'https://www.bilibili.com/video/BV1'
    const provider = new FakeMusicProvider()
    provider.byCatalogue = { youtube: [candidate('https://www.youtube.com/watch?v=abc', { durationS: 3600 })] }
    const picks: TrackPick[] = []
    const tools = musicTools(
      provider,
      (pick) => picks.push(pick),
      async () => true,
      { catalogues: () => [], debug: () => {} },
      { count: () => 1, search: () => [candidate(bili, { durationS: 240 })] },
    )
    await callTool(tools, 'search_music', { query: 'kong kong', catalogue: 'channels' })
    await callTool(tools, 'submit_pick', { ref: bili, why: 'w', title: 'Kong Kong', artist: 'Chen Li' })
    expect(picks[0]?.clip.source).toBe(`https://stream/${bili}`)
  })

  // Regression, codex review 2026-09-20: relocation is an optimisation and may
  // not become the thing the pick waits on.
  it('gives up on a hung relocation search and plays the original', async () => {
    const provider = new FakeMusicProvider()
    provider.candidates = [candidate(NETEASE_REF)]
    provider.byCatalogue = { bilibili: [], qqmusic: [], netease: [candidate(NETEASE_REF)] }
    // A search that never settles, exactly as a stuck yt-dlp spawn looks here.
    const original = provider.search.bind(provider)
    provider.search = async (query, limit, catalogue) =>
      catalogue === 'youtube' ? new Promise<TrackCandidate[]>(() => {}) : original(query, limit, catalogue)
    const picks: TrackPick[] = []
    const log: string[] = []
    const tools = musicTools(provider, (p) => picks.push(p), async () => true, {
      catalogues: () => ['netease', 'bilibili'],
      debug: (m) => log.push(m),
    })
    vi.useFakeTimers()
    try {
      const done = callTool(tools, 'submit_pick', { ref: NETEASE_REF, why: 'w', title: 'Kong Kong', artist: 'Chen Li' })
      await vi.advanceTimersByTimeAsync(20_000)
      await done
    } finally {
      vi.useRealTimers()
    }
    expect(picks[0]?.clip.source).toBe(`https://stream/${NETEASE_REF}`)
    expect(log).toContain('music.relocate from=netease none reason=timed-out')
  })

  // Regression, codex review round 2: a marker the submitted title already
  // carries must not wave every OTHER marker through with it.
  it('refuses a hit that adds a recording marker the pick did not ask for', async () => {
    const { tools, picks } = build({
      byCatalogue: { youtube: [candidate('https://www.youtube.com/watch?v=abc', { title: 'Kong Kong (Remix) - Karaoke' })] },
    })
    await callTool(tools, 'submit_pick', { ref: NETEASE_REF, why: 'w', title: 'Kong Kong (Remix)', artist: 'Chen Li' })
    expect(picks[0]?.clip.source).toBe(`https://stream/${NETEASE_REF}`)
    // The remix itself is still the song it asked for.
    const ok = build({ byCatalogue: { youtube: [candidate('https://www.youtube.com/watch?v=abc', { title: 'Kong Kong (Remix)' })] } })
    await callTool(ok.tools, 'submit_pick', { ref: NETEASE_REF, why: 'w', title: 'Kong Kong (Remix)', artist: 'Chen Li' })
    expect(ok.picks[0]?.clip.source).toContain('watch?v=abc')
  })

  // Regression, codex review round 2: yt-dlp prints a missing duration as 0,
  // and a 0 held against a 20 s window refuses every real hit.
  it('treats a zero stated length as no length at all', async () => {
    const { tools, picks } = build({
      byCatalogue: {
        netease: [candidate(NETEASE_REF, { durationS: 0 })],
        youtube: [candidate('https://www.youtube.com/watch?v=abc', { durationS: 240 })],
      },
    })
    await callTool(tools, 'search_music', { query: 'kong kong', catalogue: 'netease' })
    await submit(tools)
    expect(picks[0]?.clip.source).toContain('watch?v=abc')
  })
})
