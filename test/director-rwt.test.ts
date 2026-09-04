// The Director's side of spec 13 (§2.4): one offer per ordinary talk batch,
// never on an anchor or coda, gated live by the knob; the refresh poked at
// every boundary and never awaited.
import { describe, expect, it } from 'vitest'

import type { ActivitySensor } from '../src/director/activity.ts'
import { EveryNCadence } from '../src/director/cadence.ts'
import type { RwtTopic } from '../src/contracts.ts'
import { Director, type DirectorDeps } from '../src/director/director.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import type { AnchorId, Scheduler } from '../src/director/scheduler.ts'
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

class FakeRwt {
  offers = 0
  refreshes = 0
  topic: RwtTopic | null = {
    id: 'ab12',
    title: 'Typhoon season opens early',
    gist: 'The first storm came in a month ahead of the usual.',
    category: 'news',
    fetchedAt: 0,
    used: false,
  }

  offer(): RwtTopic | null {
    this.offers++
    return this.topic
  }

  maybeRefresh(): boolean {
    this.refreshes++
    return false
  }
}

// Presence, pinned: the pacing block needs a sensor to exist at all.
const presentSensor: ActivitySensor = {
  state: () => 'present',
  idleMs: () => 0,
  noteInput: () => {},
}

class FakeScheduler implements Scheduler {
  pending: AnchorId | null
  constructor(pending: AnchorId | null) {
    this.pending = pending
  }
  due(_now: Date): AnchorId | null {
    return this.pending
  }
  markFired(_id: AnchorId, _now: Date): void {
    this.pending = null
  }
}

function build(over: Partial<DirectorDeps> & { rwtEnabled?: boolean; player?: FakeMixingPlayer } = {}) {
  const { rwtEnabled = true, player = new FakeMixingPlayer(), ...rest } = over
  const brain = new FakeBrain()
  const host = new FakeHost()
  const rwt = new FakeRwt()
  const knobs = directorSettings({ gapSeconds: 0, rwtEnabled })
  const memory = new InProcessMemoryStore()
  const deps: DirectorDeps = {
    persona: 'p',
    brain,
    voice: new FakeVoice(),
    player,
    memory,
    host,
    settings: () => knobs,
    openUrl: () => {},
    rwt,
    ...rest,
  }
  return { brain, host, player, rwt, knobs, memory, director: new Director(deps) }
}

describe('real-world topics on the talk path (spec 13 §2.4)', () => {
  it('offers once per ordinary batch and the pack carries the item', async () => {
    const { brain, rwt, director } = build()
    // Enough batches that no call fails: a retried batch is the same batch
    // and rolls once, so offers and calls only match while nothing retries.
    brain.batches = [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]
    await director.run(3)
    await until(() => brain.nextTalksCalls >= 2, 'refill fired')
    expect(rwt.offers).toBe(brain.nextTalksCalls)
    for (const ctx of brain.talkContexts) {
      expect(ctx.rwt).toEqual({
        title: 'Typhoon season opens early',
        gist: 'The first storm came in a month ahead of the usual.',
      })
    }
  })

  // spec 13 §3.7: the ledger row lands with the take — the pool's own `used`
  // mark and the ledger agree on when a topic is spent.
  it('an offered item is ledgered as rwt, by title, once per offer', async () => {
    const { brain, rwt, memory, director } = build()
    brain.batches = [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]
    await director.run(3)
    await until(() => brain.nextTalksCalls >= 2, 'refill fired')
    expect(memory.recentRwt(10)).toHaveLength(rwt.offers)
    expect(new Set(memory.recentRwt(10))).toEqual(new Set(['Typhoon season opens early']))
  })

  it('a null offer leaves no ledger row', async () => {
    const { brain, rwt, memory, director } = build()
    rwt.topic = null
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(1)
    expect(memory.recentRwt(10)).toEqual([])
  })

  it('a null offer leaves the pack without the field', async () => {
    const { brain, rwt, director } = build()
    rwt.topic = null
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(1)
    expect(rwt.offers).toBeGreaterThanOrEqual(1)
    for (const ctx of brain.talkContexts) expect(ctx.rwt).toBeUndefined()
  })

  it('the knob off means no roll at all', async () => {
    const { brain, rwt, director } = build({ rwtEnabled: false })
    brain.batches = [['a', 'b']]
    await director.run(1)
    expect(rwt.offers).toBe(0)
    expect(brain.talkContexts[0]!.rwt).toBeUndefined()
  })

  it('an anchor beat is never offered one', async () => {
    const { brain, rwt, director } = build({
      pacing: { sensor: presentSensor, scheduler: new FakeScheduler('morning'), gating: false },
    })
    brain.batches = [['good morning'], ['after', 'that']]
    await director.run(1)
    expect(brain.talkContexts[0]!.cue).toBe('anchor:morning')
    expect(brain.talkContexts[0]!.rwt).toBeUndefined()
    // The refill the anchor kicks off IS an ordinary batch; only that rolls.
    expect(rwt.offers).toBe(brain.talkContexts.filter((c) => c.cue === undefined).length)
  })

  it('the coda is never offered one', async () => {
    const source = new FakeTrackSource()
    source.picks = [pickOf('https://stream/s1')]
    const engine = new FakeMixingPlayer()
    const { brain, player, rwt, director } = build({
      player: engine,
      music: { source, cadence: new EveryNCadence(1), engine },
    })
    brain.batches = [['talk one', 'talk two'], ['three', 'four']]
    brain.cueBeats = { coda: ['the coda'] }
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'song on air')
    await until(() => brain.talkContexts.some((c) => c.cue === 'coda'), 'coda requested')
    const offersBeforeEnd = rwt.offers
    player.handles[0]!.end()
    await run
    const coda = brain.talkContexts.find((c) => c.cue === 'coda')!
    expect(coda.rwt).toBeUndefined()
    // every offer came from an ordinary batch
    expect(rwt.offers).toBe(brain.talkContexts.filter((c) => c.cue === undefined).length)
    expect(offersBeforeEnd).toBeLessThanOrEqual(rwt.offers)
  })

  it('the refresh is poked at every boundary', async () => {
    const { brain, rwt, director } = build()
    brain.batches = [['a', 'b', 'c']]
    await director.run(3)
    expect(rwt.refreshes).toBeGreaterThanOrEqual(3)
  })
})
