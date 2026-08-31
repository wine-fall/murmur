// The Director's proactive-and-pacing behavior on fakes (spec 07 §5): presence
// reaches the pack, an away room gets longer gaps and no talk generation, and
// time anchors beat the buffer.
import { describe, expect, it } from 'vitest'

import { IdleSensor, type Activity, type ActivitySensor } from '../src/activity.ts'
import { EveryNCadence, PacingCadence } from '../src/cadence.ts'
import { Director, type DirectorDeps, type PacingWiring } from '../src/director.ts'
import { InProcessMemoryStore } from '../src/memory.ts'
import type { AnchorId, Scheduler } from '../src/scheduler.ts'
import {
  directorSettings,
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
function build(
  over: Partial<DirectorDeps> & { gapSeconds?: number; anchorsEnabled?: boolean } = {},
  pacing: Partial<PacingWiring> | null = {},
) {
  const { gapSeconds = 0, anchorsEnabled = true, ...rest } = over
  const brain = new FakeBrain()
  const voice = new FakeVoice()
  const player = new FakeMixingPlayer()
  const host = new FakeHost()
  const memory = new InProcessMemoryStore()
  const sensor = new FakeSensor()
  const knobs = directorSettings({ gapSeconds, anchorsEnabled })
  const deps: DirectorDeps = {
    persona: 'p',
    brain,
    voice,
    player,
    memory,
    host,
    settings: () => knobs,
    // Injected like every other harness: the Director has no default opener,
    // so a browser can never be launched from a test.
    openUrl: () => {},
    ...(pacing !== null && { pacing: { sensor, ...pacing } }),
    ...rest,
  }
  return { brain, voice, player, host, memory, sensor, knobs, deps, director: new Director(deps) }
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

// The retired spec-07 turn-to-you machinery must stay gone: an ordinary talk
// batch never carries a cue — the cue channel belongs to anchors alone.
describe('ordinary talk carries no cue', () => {
  it('plain talk batches never ask the model to turn to the listener', async () => {
    const { brain, host, director } = build({ gapSeconds: 0 })
    brain.batches = Array.from({ length: 12 }, (_, i) => [`beat ${i}a`, `beat ${i}b`])
    await director.run(6)
    expect(brain.talkContexts.map((c) => c.cue)).toEqual(
      Array.from({ length: brain.talkContexts.length }, () => undefined),
    )
    expect(host.radio).toHaveLength(6)
  })
})

// spec 12 §3.2: anchors are gated live at the fire site — the scheduler stays
// constructed, the flag decides at each boundary.
describe('live anchorsEnabled (spec 12)', () => {
  it('a due anchor is skipped while off and fires once back on', async () => {
    const scheduler = new FakeScheduler('morning')
    const { brain, host, knobs, director } = build({}, { scheduler })
    knobs.anchorsEnabled = false
    brain.batches = [['plain talk', 'more talk'], ['later']]
    const off = director.run(1)
    await off
    expect(scheduler.fired).toEqual([]) // due, but the live flag said no
    expect(host.radio).toEqual(['plain talk'])

    const again = new FakeScheduler('morning')
    const on = build({}, { scheduler: again })
    on.brain.batches = [['anchor beat', 'x'], ['y']]
    await on.director.run(1)
    expect(again.fired).toEqual(['morning'])
  })
})
