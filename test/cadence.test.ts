import { describe, expect, it } from 'vitest'

import {
  BrainCadence,
  buildCadence,
  EveryNCadence,
  LiveCadence,
  PacingCadence,
  RandomCadence,
  type CadencePolicy,
  type CadenceState,
  type SegmentKind,
} from '../src/director/cadence.ts'

import { callTool, FakeHarness } from './fakes.ts'

describe('EveryNCadence', () => {
  it('airs a song once N talk segments have passed', async () => {
    const cadence = new EveryNCadence(2)
    expect(await cadence.nextKind({ talksSinceMusic: 0 })).toBe('talk')
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('talk')
    expect(await cadence.nextKind({ talksSinceMusic: 2 })).toBe('music')
  })

  it('never degenerates into wall-to-wall music on a bad N', async () => {
    expect(await new EveryNCadence(0).nextKind({ talksSinceMusic: 0 })).toBe('talk')
    expect(await new EveryNCadence(0).nextKind({ talksSinceMusic: 1 })).toBe('music')
  })
})

describe('RandomCadence', () => {
  it('holds off until minGap and forces music at maxGap', async () => {
    const cadence = new RandomCadence({ p: 1, minGap: 2, maxGap: 4, random: () => 0 })
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('talk') // guardrail wins over p
    expect(await cadence.nextKind({ talksSinceMusic: 2 })).toBe('music')
    const never = new RandomCadence({ p: 0, minGap: 1, maxGap: 4, random: () => 0.99 })
    expect(await never.nextKind({ talksSinceMusic: 3 })).toBe('talk')
    expect(await never.nextKind({ talksSinceMusic: 4 })).toBe('music') // guardrail
  })

  it('uses the injected RNG against p in between', async () => {
    const rolls = [0.1, 0.9]
    const cadence = new RandomCadence({ p: 0.35, minGap: 1, maxGap: 9, random: () => rolls.shift()! })
    expect(await cadence.nextKind({ talksSinceMusic: 2 })).toBe('music')
    expect(await cadence.nextKind({ talksSinceMusic: 2 })).toBe('talk')
  })
})

// The opt-in exception to the zero-tokens-for-pacing rule (master §7 pillar 1):
// a cheap one-shot judgment that must NEVER stall the stream.
describe('BrainCadence', () => {
  it("returns the model's choice", async () => {
    const harness = new FakeHarness(async (tools) => {
      expect(tools.map((t) => t.name)).toEqual(['choose_segment'])
      await callTool(tools, 'choose_segment', { kind: 'music' })
    })
    const cadence = new BrainCadence({ brain: harness, model: 'haiku' })
    expect(await cadence.nextKind({ talksSinceMusic: 0, situation: 'quiet' })).toBe('music')
    expect(harness.lastTask!.prompt).toContain('quiet')
    expect(harness.lastTask!.model).toBe('haiku')
  })

  it('falls back to the local policy when the model never decides', async () => {
    const cadence = new BrainCadence({
      brain: new FakeHarness(),
      model: 'haiku',
      fallback: new EveryNCadence(1),
    })
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('music')
  })

  it('falls back when the task throws', async () => {
    const harness = new FakeHarness(async () => {
      throw new Error('model down')
    })
    const cadence = new BrainCadence({ brain: harness, model: 'haiku', fallback: new EveryNCadence(9) })
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('talk')
  })

  it('falls back when the model hangs past the timeout', async () => {
    const harness = new FakeHarness(() => new Promise(() => {})) // never settles
    const cadence = new BrainCadence({
      brain: harness,
      model: 'haiku',
      fallback: new EveryNCadence(1),
      timeoutMs: 20,
    })
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('music')
  })
})

describe('buildCadence', () => {
  it('constructs the configured mode', () => {
    expect(buildCadence('every_n', { everyN: 3 })).toBeInstanceOf(EveryNCadence)
    expect(buildCadence('random', { everyN: 3 })).toBeInstanceOf(RandomCadence)
    expect(buildCadence('brain', { everyN: 3, brain: new FakeHarness(), model: 'haiku' })).toBeInstanceOf(
      BrainCadence,
    )
  })

  it('refuses brain mode with no harnessed brain behind it', () => {
    expect(() => buildCadence('brain', { everyN: 3 })).toThrow(/brain/i)
  })
})

describe('PacingCadence — activity gating (spec 07 §2.5, acceptance 7)', () => {
  // Records whether the wrapped policy was consulted at all: an away room must
  // skip even the opt-in brain cadence, so gating saves that token too.
  class SpyCadence implements CadencePolicy {
    consulted = 0

    async nextKind(_state: CadenceState): Promise<SegmentKind> {
      this.consulted++
      return 'talk'
    }
  }

  it('short-circuits to music when away, without delegating', async () => {
    const inner = new SpyCadence()
    const cadence = new PacingCadence(inner)
    expect(await cadence.nextKind({ talksSinceMusic: 0, activity: 'away' })).toBe('music')
    expect(inner.consulted).toBe(0)
  })

  it('delegates in every other state, including an absent signal', async () => {
    const inner = new SpyCadence()
    const cadence = new PacingCadence(inner)
    expect(await cadence.nextKind({ talksSinceMusic: 0, activity: 'engaged' })).toBe('talk')
    expect(await cadence.nextKind({ talksSinceMusic: 0, activity: 'present' })).toBe('talk')
    expect(await cadence.nextKind({ talksSinceMusic: 0 })).toBe('talk')
    expect(inner.consulted).toBe(3)
  })

  it('composes with the brain cadence: away makes no brain call', async () => {
    const harness = new FakeHarness()
    const cadence = new PacingCadence(new BrainCadence({ brain: harness, model: 'm' }))
    expect(await cadence.nextKind({ talksSinceMusic: 0, activity: 'away' })).toBe('music')
    expect(harness.calls).toBe(0)
  })
})

// spec 12 §3.2: the mix gear is live — the decision point reads the current
// mode and depth, so a settings change lands at the next boundary with no
// rebuild. The stateless policies are constructed per call; the brain policy
// (which holds a harness) is built once and reused.
describe('LiveCadence (spec 12)', () => {
  it('follows the live mode and depth at each decision point', async () => {
    let mode: 'every_n' | 'random' | 'brain' = 'every_n'
    let everyN = 2
    const cadence = new LiveCadence({
      settings: () => ({ cadenceMode: mode, musicEveryN: everyN }),
    })
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('talk')
    everyN = 1
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('music')
    mode = 'every_n'
    everyN = 9
    expect(await cadence.nextKind({ talksSinceMusic: 3 })).toBe('talk')
  })

  it('brain mode consults the harnessed policy, and leaving it stops the calls', async () => {
    let mode: 'every_n' | 'random' | 'brain' = 'brain'
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'choose_segment', { kind: 'music' })
    })
    const cadence = new LiveCadence({
      settings: () => ({ cadenceMode: mode, musicEveryN: 2 }),
      brain: harness,
      model: 'm',
    })
    expect(await cadence.nextKind({ talksSinceMusic: 0 })).toBe('music')
    expect(harness.calls).toBe(1)
    mode = 'every_n'
    expect(await cadence.nextKind({ talksSinceMusic: 0 })).toBe('talk')
    expect(harness.calls).toBe(1) // no further brain spend
  })

  it('brain mode without a harness falls back to every_n at the live depth', async () => {
    const cadence = new LiveCadence({
      settings: () => ({ cadenceMode: 'brain', musicEveryN: 1 }),
    })
    expect(await cadence.nextKind({ talksSinceMusic: 1 })).toBe('music')
  })
})
