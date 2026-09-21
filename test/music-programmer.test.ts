import { describe, expect, it } from 'vitest'

import type { MusicContext, TaskTool } from '../src/contracts.ts'
import { MusicProgrammer, renderMusicContext } from '../src/music/music-programmer.ts'
import { buildFindMusicInstruction, MUSIC_CONTEXT_HEADER, NO_REPEATS_RULE } from '../src/prompts/music.ts'

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

  // issue #164: the pick is a bounded search-and-commit, and the SDK's default
  // extended thinking costs it tens of seconds per model turn (measured: ~45 s
  // before the first search, a 4.6k-char thinking block) for a judgment the
  // policy already spells out. The task asks for it off.
  it('asks for no extended thinking — the pick is a bounded judgment, not an essay', async () => {
    const harness = new FakeHarness()
    await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku' }).nextTrack(ctx)
    expect(harness.lastTask!.thinking).toBe('disabled')
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

// Everything after the pick is committed: a ref that will not resolve, a
// stream that does not actually play, a task that ends empty.
describe('the pick task, when a candidate does not hold up', () => {
  it('lets the model pick again when a ref will not resolve', async () => {
    const music = provider()
    music.broken.add('loop')
    const results: Record<string, unknown>[] = []
    const harness = new FakeHarness(async (tools) => {
      results.push(await callTool(tools, 'submit_pick', { ref: 'loop', why: 'oops', title: 'Zelkova Hour', artist: 'Nine Lantern' }))
      results.push(await callTool(tools, 'submit_pick', { ref: 'good', why: 'better', title: 'Zelkova Hour', artist: 'Nine Lantern' }))
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
      const dead = await callTool(tools, 'submit_pick', { ref: 'good', why: 'looks fine', title: 'Zelkova Hour', artist: 'Nine Lantern' })
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
      await callTool(tools, 'submit_pick', { ref: 'good', why: 'fits', title: 'Zelkova Hour', artist: 'Nine Lantern' })
    })
    await new MusicProgrammer({
      brain: harness,
      provider: provider(),
      model: 'haiku',
      probe: async () => true,
      debug: (m) => lines.push(m),
    }).nextTrack(ctx)

    expect(lines[0]).toMatch(/^music\.pick start situation=\d+ch$/)
    // spec 14 §3.6: a taste-led search quotes a kept title, and the dev log
    // is what a /bug report attaches — its size, never its words.
    expect(lines.some((l) => /^music\.search \d+ms hits=\d+ q=\d+ch$/.test(l))).toBe(true)
    expect(lines.join('\n')).not.toContain('city pop')
    expect(lines).toContainEqual(expect.stringMatching(/^music\.search \d+ms hits=2 q=8ch$/))
    expect(lines).toContainEqual(expect.stringMatching(/^music\.resolve \d+ms ok$/))
    expect(lines).toContainEqual(expect.stringMatching(/^music\.probe \d+ms ok$/))
    expect(lines.at(-1)).toMatch(/^music\.pick done \d+ms picked=yes$/)
  })

  // A chapter clip (spec 14 §2.9) plays one slice of a long upload, so the
  // probe has to open THAT slice. Timing it must not cost the offset: with the
  // dev log wired — which is every dev run — the head of a two-hour upload
  // would be probed instead of the song half an hour in.
  it('hands the probe its segment offset even with the timing wrapper in the way', async () => {
    const offsets: (number | undefined)[] = []
    const music = provider()
    music.candidates = [{ ref: 'https://youtube.com/watch?v=a#t=612,868', title: 'S', uploader: 'U', durationS: 7_200, extra: {} }]
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'submit_pick', { ref: 'https://youtube.com/watch?v=a#t=612,868', why: 'fits', title: 'Zelkova Hour', artist: 'Nine Lantern' })
    })
    await new MusicProgrammer({
      brain: harness,
      provider: music,
      model: 'haiku',
      probe: async (_source, _headers, startS) => (offsets.push(startS), true),
      debug: () => {},
    }).nextTrack(ctx)

    expect(offsets).toEqual([612])
  })

  it('times the failure paths too — a dead resolve and a dead probe are stages, not gaps', async () => {
    const music = provider()
    music.broken.add('loop')
    const lines: string[] = []
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'submit_pick', { ref: 'loop', why: 'dead ref', title: 'Zelkova Hour', artist: 'Nine Lantern' })
      await callTool(tools, 'submit_pick', { ref: 'good', why: 'dead stream', title: 'Zelkova Hour', artist: 'Nine Lantern' })
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
      await callTool(tools, 'submit_pick', { ref: 'good', why: 'fits', title: 'Zelkova Hour', artist: 'Nine Lantern' })
    })
    const pick = await new MusicProgrammer({ brain: harness, provider: provider(), model: 'haiku' }).nextTrack(ctx)
    expect(pick).not.toBeNull() // instrumentation is optional and changes nothing
  })
})

// spec 03-01 §2.3: what to do about a recently-played song is a taste rule
// living in the listener's own policy, not a code-fixed one. So the
// deterministic refusal inside submit_pick is armed by that policy: a listener
// who drops the no-repeats rule turns the guard off with it (codex review).
describe('the submit_pick avoid-guard follows the listener policy', () => {
  const AVOIDED: MusicContext = { ...ctx, avoid: ['Song A — Label'] }

  async function submit(instruction: string | undefined) {
    const harness = new FakeHarness(async (tools) => {
      submitted = await callTool(tools, 'submit_pick', { ref: 'good', why: 'w', title: 'Song A', artist: 'Label' })
    })
    let submitted: Record<string, unknown> = {}
    const pick = await new MusicProgrammer({
      brain: harness,
      provider: provider(),
      model: 'haiku',
      ...(instruction !== undefined && { instruction: () => instruction }),
    }).nextTrack(AVOIDED)
    return { submitted, pick }
  }

  it('refuses the repeat while the shipped policy is in force', async () => {
    const { submitted, pick } = await submit(undefined)
    expect(submitted.ok).toBe(false)
    expect(pick).toBeNull()
  })

  it('stands down when the listener wrote a policy that does not forbid repeats', async () => {
    const { submitted, pick } = await submit(buildFindMusicInstruction('1. Play whatever you like, repeats welcome.'))
    expect(submitted.ok).toBe(true)
    expect(pick).not.toBeNull()
  })

  it('still refuses when the listener kept the no-repeats rule in their own policy', async () => {
    const own = buildFindMusicInstruction(`1. More cantopop.\n2. And ${NO_REPEATS_RULE}.`)
    expect((await submit(own)).submitted.ok).toBe(false)
  })
})
