import { describe, expect, it } from 'vitest'

import { BrainCadence, buildCadence, EveryNCadence, RandomCadence } from '../src/cadence.ts'

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
