import { describe, expect, it } from 'vitest'

import type { MusicContext, SimilarMusic, TaskTool } from '../src/contracts.ts'
import { MusicProgrammer, type MusicProgrammerDeps, renderMusicContext } from '../src/music-programmer.ts'
import { MUSIC_CONTEXT_HEADER } from '../src/prompts.ts'

import { callTool, FakeHarness, FakeMusicProvider } from './fakes.ts'

const ctx: MusicContext = { persona: 'you are a late-night host', situation: 'quiet, 1am' }

function provider(): FakeMusicProvider {
  const p = new FakeMusicProvider()
  p.candidates = [
    { ref: 'good', title: 'Song A', uploader: 'Label', durationS: 210, extra: {} },
    { ref: 'loop', title: '1 hour loop', uploader: 'rando', durationS: 3_600, extra: {} },
  ]
  return p
}

// The context-insertion mechanism (spec 03-01 §2.5): push, and split so the
// stable half stays prompt-cacheable.
describe('renderMusicContext', () => {
  it('puts the persona in the cacheable system prefix and the situation in the turn', () => {
    const [systemPrompt, situationBlock] = renderMusicContext(ctx)
    expect(systemPrompt).toBe(ctx.persona)
    expect(situationBlock).toBe(`${MUSIC_CONTEXT_HEADER}${ctx.situation}`)
    expect(systemPrompt).not.toContain(ctx.situation) // disjoint: cache stays warm
  })
})

describe('MusicProgrammer.nextTrack', () => {
  it('searches, judges, and hands back the picked track with its announce', async () => {
    const music = provider()
    let searched: Record<string, unknown> | null = null
    const harness = new FakeHarness(async (tools) => {
      searched = await callTool(tools, 'search_music', { query: 'city pop', limit: 2 })
      await callTool(tools, 'submit_pick', {
        ref: 'good',
        why: 'official audio, right mood',
        title: 'Song A',
        artist: 'Label',
        announce: 'up next, something soft',
      })
    })

    const pick = await new MusicProgrammer({ brain: harness, provider: music, model: 'haiku' }).nextTrack(ctx)

    expect(searched).toEqual({
      candidates: [
        { ref: 'good', title: 'Song A', uploader: 'Label', durationS: 210, extra: {} },
        { ref: 'loop', title: '1 hour loop', uploader: 'rando', durationS: 3_600, extra: {} },
      ],
    })
    expect(music.searches).toEqual([{ query: 'city pop', limit: 2 }])
    expect(pick).toEqual({
      clip: { source: 'https://stream/good', kind: 'music' },
      title: 'Song A',
      artist: 'Label',
      announce: 'up next, something soft',
    })
  })

  it('runs on the cheap tier with the persona cached and the instruction in the turn', async () => {
    const harness = new FakeHarness()
    await new MusicProgrammer({
      brain: harness,
      provider: provider(),
      model: 'haiku',
      instruction: () => 'FIND-MUSIC-INSTRUCTION',
    }).nextTrack(ctx)

    const task = harness.lastTask!
    expect(task.model).toBe('haiku')
    expect(task.systemPrompt).toBe(ctx.persona)
    expect(task.prompt).toContain('FIND-MUSIC-INSTRUCTION')
    expect(task.prompt).toContain(ctx.situation)
    // Room for several searches -> judge -> submit: a real pick can spend 5
    // searches before submitting, so the default must leave headroom.
    expect(task.maxTurns).toBeGreaterThanOrEqual(8)
  })

  // spec 03-01 §2.3: the instruction is re-read per pick, so an edit to the
  // policy file lands on the next song without a restart.
  it('re-reads the instruction on every pick', async () => {
    const harness = new FakeHarness()
    let policy = 'FIRST'
    const programmer = new MusicProgrammer({
      brain: harness,
      provider: provider(),
      model: 'haiku',
      instruction: () => policy,
    })

    await programmer.nextTrack(ctx)
    expect(harness.lastTask!.prompt).toContain('FIRST')
    policy = 'SECOND' // the listener edits the file mid-broadcast
    await programmer.nextTrack(ctx)
    expect(harness.lastTask!.prompt).toContain('SECOND')
    expect(harness.lastTask!.prompt).not.toContain('FIRST')
  })

  it('exposes exactly the two music tools and nothing else', async () => {
    let names: string[] = []
    const harness = new FakeHarness(async (tools: TaskTool[]) => {
      names = tools.map((t) => t.name)
    })
    await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku' }).nextTrack(ctx)
    expect(names).toEqual(['search_music', 'submit_pick'])
  })
})

// spec 03-01 §2.3: real co-listening data as a third tool, so the candidate
// pool is not bounded by what the model happens to remember. Unwired (no key)
// the task is exactly its two-tool self.
describe('similar_music', () => {
  const similar: SimilarMusic = {
    artists: async (artist, limit) => [`similar-to-${artist}`, 'Grouper'].slice(0, limit),
    tracks: async (artist, track) => [{ title: `like-${track}`, artist }],
  }

  const toolNames = async (deps: Partial<MusicProgrammerDeps>): Promise<string[]> => {
    let names: string[] = []
    const harness = new FakeHarness(async (tools: TaskTool[]) => {
      names = tools.map((t) => t.name)
    })
    await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku', ...deps }).nextTrack(ctx)
    return names
  }

  it('is offered only when a data source is wired', async () => {
    expect(await toolNames({})).toEqual(['search_music', 'submit_pick'])
    expect(await toolNames({ similar })).toEqual(['search_music', 'similar_music', 'submit_pick'])
  })

  it('returns similar artists for a seed artist, similar tracks for a seed track', async () => {
    let byArtist: Record<string, unknown> | null = null
    let byTrack: Record<string, unknown> | null = null
    const harness = new FakeHarness(async (tools) => {
      byArtist = await callTool(tools, 'similar_music', { artist: 'Bon Iver', limit: 2 })
      byTrack = await callTool(tools, 'similar_music', { artist: 'Bon Iver', track: 'Holocene' })
    })
    await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku', similar }).nextTrack(ctx)

    expect(byArtist).toEqual({ artists: ['similar-to-Bon Iver', 'Grouper'] })
    expect(byTrack).toEqual({ tracks: [{ title: 'like-Holocene', artist: 'Bon Iver' }] })
  })

  // A dead lookup must cost the pick a turn, not the whole song: the task
  // still has search_music and can submit without ever widening.
  it('hands a failed lookup back to the model instead of killing the task', async () => {
    const dead: SimilarMusic = {
      artists: async () => {
        throw new Error('last.fm artist.getsimilar failed: HTTP 503')
      },
      tracks: async () => [],
    }
    let result: Record<string, unknown> | null = null
    const harness = new FakeHarness(async (tools) => {
      result = await callTool(tools, 'similar_music', { artist: 'Bon Iver' })
      await callTool(tools, 'submit_pick', { ref: 'good', why: 'searched the old way' })
    })
    const pick = await new MusicProgrammer({
      brain: harness,
      provider: provider(),
      model: 'haiku',
      similar: dead,
    }).nextTrack(ctx)

    expect(result).toEqual({ ok: false, error: 'last.fm artist.getsimilar failed: HTTP 503' })
    expect(pick?.clip.source).toBe('https://stream/good')
  })

  it('lets the model pick again when a ref will not resolve', async () => {
    const music = provider()
    music.broken.add('loop')
    const results: Record<string, unknown>[] = []
    const harness = new FakeHarness(async (tools) => {
      results.push(await callTool(tools, 'submit_pick', { ref: 'loop', why: 'oops' }))
      results.push(await callTool(tools, 'submit_pick', { ref: 'good', why: 'better' }))
    })

    const pick = await new MusicProgrammer({ brain: harness, provider: music, model: 'haiku' }).nextTrack(ctx)

    expect(results[0]).toMatchObject({ ok: false })
    expect(results[0]!.error).toMatch(/cannot resolve loop/)
    expect(results[1]).toMatchObject({ ok: true })
    expect(pick!.clip.source).toBe('https://stream/good')
  })

  it('rejects a pick whose resolved stream does not actually play (pull-time probe)', async () => {
    const probed: string[] = []
    const harness = new FakeHarness(async (tools) => {
      const dead = await callTool(tools, 'submit_pick', { ref: 'good', why: 'looks fine' })
      expect(dead).toMatchObject({ ok: false })
      expect(dead.error).toMatch(/pick another/)
    })
    const pick = await new MusicProgrammer({
      brain: harness,
      provider: provider(),
      model: 'haiku',
      probe: async (source) => {
        probed.push(source)
        return false
      },
    }).nextTrack(ctx)

    expect(probed).toEqual(['https://stream/good'])
    expect(pick).toBeNull()
  })

  it('requires a ref', async () => {
    const harness = new FakeHarness(async (tools) => {
      expect(await callTool(tools, 'submit_pick', { ref: '  ', why: 'nothing' })).toMatchObject({
        ok: false,
      })
    })
    expect(await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku' }).nextTrack(ctx)).toBeNull()
  })

  it('returns null when the task ends with no pick', async () => {
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'search_music', { query: 'anything' })
    })
    expect(await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku' }).nextTrack(ctx)).toBeNull()
  })
})

// Per-stage discovery timing (issue #76): where the pick's wall-clock goes —
// model turns vs search vs resolve vs probe — readable from the dev log.
describe('discovery instrumentation', () => {
  it('reports every stage with its elapsed time through debug', async () => {
    const lines: string[] = []
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'search_music', { query: 'city pop', limit: 2 })
      await callTool(tools, 'submit_pick', { ref: 'good', why: 'fits' })
    })
    await new MusicProgrammer({
      brain: harness,
      provider: provider(),
      model: 'haiku',
      probe: async () => true,
      debug: (m) => lines.push(m),
    }).nextTrack(ctx)

    expect(lines[0]).toMatch(/^music\.pick start situation=\d+ch$/)
    expect(lines).toContainEqual(expect.stringMatching(/^music\.search \d+ms hits=2 query="city pop"$/))
    expect(lines).toContainEqual(expect.stringMatching(/^music\.resolve \d+ms ok$/))
    expect(lines).toContainEqual(expect.stringMatching(/^music\.probe \d+ms ok$/))
    expect(lines.at(-1)).toMatch(/^music\.pick done \d+ms picked=yes$/)
  })

  it('times the failure paths too — a dead resolve and a dead probe are stages, not gaps', async () => {
    const music = provider()
    music.broken.add('loop')
    const lines: string[] = []
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'submit_pick', { ref: 'loop', why: 'dead ref' })
      await callTool(tools, 'submit_pick', { ref: 'good', why: 'dead stream' })
    })
    const pick = await new MusicProgrammer({
      brain: harness,
      provider: music,
      model: 'haiku',
      probe: async () => false,
      debug: (m) => lines.push(m),
    }).nextTrack(ctx)

    expect(pick).toBeNull()
    expect(lines).toContainEqual(expect.stringMatching(/^music\.resolve \d+ms failed: .*loop/))
    expect(lines).toContainEqual(expect.stringMatching(/^music\.probe \d+ms dead$/))
    expect(lines.at(-1)).toMatch(/^music\.pick done \d+ms picked=no$/)
  })

  it('stays silent with no debug sink', async () => {
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'submit_pick', { ref: 'good', why: 'fits' })
    })
    const pick = await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku' }).nextTrack(ctx)
    expect(pick).not.toBeNull() // instrumentation is optional and changes nothing
  })
})
