// The Director's proactive-and-pacing behavior on fakes (spec 07 §5): presence
// reaches the pack, an away room gets longer gaps and no talk generation, time
// anchors beat the buffer, and the invite/slide-back window is one flag plus
// one deadline.
import { describe, expect, it } from 'vitest'

import { IdleSensor, type Activity, type ActivitySensor } from '../src/activity.ts'
import { EveryNCadence, PacingCadence } from '../src/cadence.ts'
import { Director, type DirectorDeps, type PacingWiring } from '../src/director.ts'
import { InProcessMemoryStore } from '../src/memory.ts'
import type { AnchorId, Scheduler } from '../src/scheduler.ts'
import {
  FakeBrain,
  FakeHost,
  FakeMixingPlayer,
  FakeTrackSource,
  FakeVoice,
  pickOf,
  until,
} from './fakes.ts'

// Presence under test control. noteInput moves it to engaged, exactly as the
// real sensor does — that is what makes "resume" a property of the loop rather
// than of a special branch.
class FakeSensor implements ActivitySensor {
  inputs = 0
  activity: Activity = 'present'

  state(_now: Date): Activity {
    return this.activity
  }

  idleMs(_now: Date): number | null {
    return 0
  }

  noteInput(_at: Date): void {
    this.inputs++
    this.activity = 'engaged'
  }
}

// Fires one anchor, once — the Scheduler's own windows/persistence are pinned
// in scheduler.test.ts; here only the Director's handling matters.
class FakeScheduler implements Scheduler {
  fired: AnchorId[] = []
  pending: AnchorId | null

  constructor(pending: AnchorId | null = null) {
    this.pending = pending
  }

  due(_now: Date): AnchorId | null {
    return this.pending
  }

  markFired(id: AnchorId, _now: Date): void {
    this.fired.push(id)
    this.pending = null
  }
}

// `pacing: null` builds a pre-spec-07 Director (no pacing block at all).
function build(over: Partial<DirectorDeps> = {}, pacing: Partial<PacingWiring> | null = {}) {
  const brain = new FakeBrain()
  const voice = new FakeVoice()
  const player = new FakeMixingPlayer()
  const host = new FakeHost()
  const memory = new InProcessMemoryStore()
  const sensor = new FakeSensor()
  const deps: DirectorDeps = {
    persona: 'p',
    brain,
    voice,
    player,
    memory,
    host,
    gapSeconds: 0,
    recentWindow: 12,
    ...(pacing !== null && { pacing: { sensor, ...pacing } }),
    ...over,
  }
  return { brain, voice, player, host, memory, sensor, deps, director: new Director(deps) }
}

// Music wiring whose cadence always says music — the away room's stream.
function withMusic(player: FakeMixingPlayer, gating = true) {
  const source = new FakeTrackSource()
  source.picks = Array.from({ length: 8 }, (_, i) => pickOf(`https://stream/${i}`))
  const inner = new EveryNCadence(1)
  return {
    source,
    music: { source, cadence: gating ? new PacingCadence(inner) : inner, engine: player },
  }
}

describe('activity in the pack (acceptance 3)', () => {
  it('the sensor state reaches every talk context', async () => {
    const { brain, sensor, director } = build()
    sensor.activity = 'present'
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1)
    expect(brain.talkContexts[0]!.activity).toBe('present')
  })

  it('a hanging OS probe never holds up a boundary (acceptance 2)', async () => {
    // The real sensor, wired to a probe that never answers: the boundary reads
    // it and airs anyway, on murmur's own input recency.
    const sensor = new IdleSensor({ probe: () => new Promise(() => {}) })
    const { brain, host, director } = build({}, { sensor })
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1)
    expect(host.radio).toEqual(['a'])
    expect(brain.talkContexts[0]!.activity).toBe('present') // never observed
  })

  it('without pacing wiring the field is absent (pre-spec-07 behavior)', async () => {
    const { brain, director } = build({}, null)
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1)
    expect(brain.talkContexts[0]!.activity).toBeUndefined()
  })
})

describe('pacing when nobody is around (acceptance 4)', () => {
  const gapOf = async (activity: Activity) => {
    const { brain, sensor, director } = build({ gapSeconds: 0.06 })
    sensor.activity = activity
    brain.batches = [['a', 'b'], ['c', 'd'], ['e']]
    const started = Date.now()
    await director.run(2)
    return Date.now() - started
  }

  it('stretches the inter-segment gap when away, leaves it alone otherwise', async () => {
    const away = await gapOf('away')
    const engaged = await gapOf('engaged')
    // One gap between two segments: ~60ms engaged, ~180ms away (factor 3).
    expect(away).toBeGreaterThan(engaged + 60)
  })
})

describe('activity-gated generation (acceptance 5, 6, 7)', () => {
  it('an away room spends nothing on talk while the stream plays on', async () => {
    const player = new FakeMixingPlayer()
    const { music, source } = withMusic(player)
    const { brain, voice, sensor, host, director } = build({ player, music, gapSeconds: 0 })
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1) // one normal talk segment warms the look-ahead
    await until(() => brain.nextTalksCalls >= 2, 'refill fired')
    const talkCalls = brain.nextTalksCalls
    const synths = voice.synthesized.length

    sensor.activity = 'away' // the listener walks off
    const away = director.run(2)
    for (let i = 0; i < 2; i++) {
      await until(() => player.handles.length === i + 1, `song ${i + 1} on air`)
      player.handles[i]!.end()
    }
    await away
    expect(brain.nextTalksCalls).toBe(talkCalls) // zero further Brain talk calls
    expect(voice.synthesized).toHaveLength(synths) // zero further synthesis
    expect(source.calls).toBeGreaterThan(0) // ...the stream kept playing
    expect(host.radio).toEqual(['a'])

    // The buffered beats were kept, not discarded: when the listener is back,
    // 'b' is what airs — no regenerated batch.
    sensor.activity = 'engaged'
    await director.run(1)
    expect(host.radio).toEqual(['a', 'b'])
  })

  it('a talk-only away room keeps its buffered beats instead of spending them', async () => {
    // No music wiring at all (--no-music, or a failed music preflight): nothing
    // else gates the talk branch, so the gate itself must hold the buffer.
    const { brain, voice, sensor, host, director } = build({ gapSeconds: 0 })
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1)
    await until(() => brain.nextTalksCalls >= 2, 'refill fired')
    const talkCalls = brain.nextTalksCalls
    const synths = voice.synthesized.length

    sensor.activity = 'away'
    await director.run(3)
    expect(host.radio).toEqual(['a']) // the warm buffer was NOT aired to nobody
    expect(brain.nextTalksCalls).toBe(talkCalls)
    expect(voice.synthesized).toHaveLength(synths)

    sensor.activity = 'engaged'
    await director.run(1)
    expect(host.radio).toEqual(['a', 'b']) // still there when they come back
  })

  it('a typed line resumes talk with no extra trigger', async () => {
    const { brain, sensor, host, director } = build({ gapSeconds: 0.05 })
    sensor.activity = 'away'
    brain.batches = [['back on air', 'and more']]
    const run = director.run()
    // Nothing is generated while the room is empty.
    await until(() => host.debugs.some((m) => m.includes('talk.gated')), 'gated')
    expect(brain.nextTalksCalls).toBe(0)
    host.type('still here')
    await until(() => host.radio.includes('re:still here'), 'reply aired')
    // The reply's own post-steer refill is the only trigger needed.
    await until(() => host.radio.includes('back on air'), 'program resumed')
    director.requestQuit()
    await run
  })

  it('--no-gating keeps generating in an away room', async () => {
    const { brain, host, sensor, director } = build({}, { gating: false })
    sensor.activity = 'away'
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1)
    expect(host.radio).toEqual(['a'])
  })
})

describe('time anchors (acceptance 10, 11, 15)', () => {
  it('a due anchor wins its boundary and carries its own cue', async () => {
    const scheduler = new FakeScheduler('morning')
    const { brain, host, director } = build({}, { scheduler })
    brain.batches = [['good morning'], ['after']]
    await director.run(1)
    expect(host.radio).toEqual(['good morning'])
    expect(scheduler.fired).toEqual(['morning'])
    expect(brain.talkContexts[0]!.cue).toBe('anchor:morning')
  })

  it('the anchor is inserted ahead of the buffer, which survives', async () => {
    const scheduler = new FakeScheduler()
    const { brain, host, director } = build({}, { scheduler })
    brain.batches = [['first', 'buffered'], ['refill'], ['anchor line'], ['tail']]
    await director.run(1)
    await until(() => brain.nextTalksCalls >= 2, 'refill fired')
    scheduler.pending = 'night'
    await director.run(2)
    // Segment 2 = the anchor; segment 3 = the beat that was already buffered.
    expect(host.radio).toEqual(['first', 'anchor line', 'buffered'])
  })

  it('an anchor overrides gating: it airs even in an away room', async () => {
    const scheduler = new FakeScheduler('night')
    const { brain, host, sensor, director } = build({}, { scheduler })
    sensor.activity = 'away'
    brain.batches = [['good night']]
    await director.run(1)
    expect(host.radio).toEqual(['good night'])
    expect(scheduler.fired).toEqual(['night'])
  })

  it('--no-anchors (no scheduler wired) never fires one', async () => {
    const { brain, host, director } = build({}, {})
    brain.batches = [['ordinary', 'beat'], ['more']]
    await director.run(1)
    expect(host.radio).toEqual(['ordinary'])
  })

  it('a degraded anchor generation leaves it due, and airs nothing', async () => {
    const scheduler = new FakeScheduler('midday')
    const { brain, host, director } = build({}, { scheduler })
    brain.batches = [] // every generation attempt throws
    await director.run(1)
    expect(host.radio).toEqual([])
    expect(scheduler.fired).toEqual([]) // recorded at AIR time only
    expect(scheduler.due(new Date())).toBe('midday') // still due next boundary
  })
})

describe('turning to you, and sliding back (acceptance 12, 13, 14, 15)', () => {
  const cues = (brain: FakeBrain) => brain.talkContexts.map((c) => c.cue)

  it('no invite before the interval has passed, and none right after a user line', async () => {
    const { brain, host, director } = build({ gapSeconds: 0 })
    brain.batches = Array.from({ length: 10 }, (_, i) => [`beat ${i}a`, `beat ${i}b`])
    await director.run(3)
    expect(cues(brain).slice(0, 3)).toEqual([undefined, undefined, undefined])
    expect(host.radio).toHaveLength(3)
  })

  it('asks for an invite once the interval has passed', async () => {
    const { brain, director } = build({ gapSeconds: 0 })
    brain.batches = Array.from({ length: 12 }, (_, i) => [`beat ${i}a`, `beat ${i}b`])
    await director.run(6)
    expect(cues(brain)).toContain('invite')
  })

  it('never queues a second invite behind one that has not aired yet', async () => {
    // An invited beat sits in the look-ahead for a boundary or two. The refills
    // in between must not stack another question behind it.
    const { brain, director } = build({ gapSeconds: 0 })
    let call = 0
    brain.nextTalks = async (ctx, count) => {
      brain.nextTalksCalls++
      brain.talkContexts.push(ctx)
      call++
      return Array.from({ length: count }, (_, i) => ({
        text: `beat ${call}-${i}`,
        ...(ctx.cue === 'invite' && i === 0 && { invite: true }),
      }))
    }
    await director.run(10)
    const asked = cues(brain)
      .map((cue, i) => (cue === 'invite' ? i : -1))
      .filter((i) => i >= 0)
    for (let i = 1; i < asked.length; i++) {
      expect(asked[i]! - asked[i - 1]!).toBeGreaterThanOrEqual(4) // INVITE_EVERY_N
    }
  })

  it('never asks while away', async () => {
    const { brain, sensor, director } = build({ gapSeconds: 0 }, { gating: false })
    sensor.activity = 'away'
    brain.batches = Array.from({ length: 12 }, (_, i) => [`beat ${i}a`, `beat ${i}b`])
    await director.run(6)
    expect(cues(brain)).not.toContain('invite')
  })

  it('--no-invites never asks', async () => {
    const { brain, director } = build({ gapSeconds: 0 }, { invites: false })
    brain.batches = Array.from({ length: 12 }, (_, i) => [`beat ${i}a`, `beat ${i}b`])
    await director.run(6)
    expect(cues(brain)).not.toContain('invite')
  })

  it('an unanswered invite expires into a slide-back, with no second invite', async () => {
    const { brain, host, director } = build({ gapSeconds: 0 })
    brain.batches = [
      [{ text: 'so what have you been listening to?', invite: true }],
      ['b'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
    ]
    await director.run(5)
    const asked = cues(brain)
    expect(host.radio[0]).toContain('listening to')
    // The window holds for ~2 segments, then exactly one slide-back is asked
    // for — and no invite comes sooner than the normal interval.
    expect(asked).toContain('slide-back')
    expect(asked.filter((c) => c === 'slide-back')).toHaveLength(1)
    const slideAt = asked.indexOf('slide-back')
    expect(asked.slice(0, slideAt + 1)).not.toContain('invite')
  })

  it('an answered invite clears the window with no slide-back', async () => {
    const { brain, player, host, director } = build({ gapSeconds: 0 })
    brain.batches = [
      [{ text: 'what are you up to?', invite: true }],
      ['bg'],
      ['after'],
      ['more'],
      ['still more'],
    ]
    player.auto = false
    const run = director.run(3)
    await until(() => host.radio.length === 1, 'invite aired')
    host.type('reading, mostly')
    await until(() => host.radio.includes('re:reading, mostly'), 'ordinary talkback reply')
    player.finish()
    await until(() => host.radio.length >= 3, 'program resumes')
    host.type('/quit')
    player.finish()
    await run
    expect(cues(brain)).not.toContain('slide-back')
  })

  // spec 10 §5.6: the badge/pose the front-end draws from the same window.
  it('an open invite window is visible in the program state, and clears when answered', async () => {
    const { brain, player, host, director } = build({ gapSeconds: 0 })
    brain.batches = [
      [{ text: 'what are you up to?', invite: true }],
      ['bg'],
      ['after'],
      ['more'],
    ]
    player.auto = false
    const run = director.run(3)
    await until(() => host.radio.length === 1, 'invite aired')
    expect(host.states.at(-1)!.awaitingReply).toBe(true)
    host.type('reading, mostly')
    await until(() => host.states.at(-1)!.awaitingReply === false, 'window cleared')
    player.finish()
    await until(() => host.radio.length >= 3, 'program resumes')
    host.type('/quit')
    player.finish()
    await run
  })
})
