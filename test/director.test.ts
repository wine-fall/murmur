import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory.ts'
import { Director, steerFromLine, type DirectorDeps } from '../src/director.ts'
import { SCENES } from '../src/scene.ts'
import { FakeBrain, FakeHost, FakePlayer, FakeVoice, until } from './fakes.ts'

function setup(over: Partial<DirectorDeps> = {}) {
  const brain = new FakeBrain()
  const voice = new FakeVoice()
  const player = new FakePlayer()
  const host = new FakeHost()
  const memory = new InProcessMemoryStore()
  const director = new Director({
    persona: 'p',
    brain,
    voice,
    player,
    memory,
    host,
    gapSeconds: 0,
    recentWindow: 12,
    ...over,
  })
  return { brain, voice, player, host, memory, director }
}

describe('steerFromLine', () => {
  it('classifies /quit and talkback', () => {
    expect(steerFromLine(' /quit ')).toEqual({ intent: 'quit' })
    expect(steerFromLine('hello')).toEqual({ intent: 'talkback', text: 'hello' })
  })
})

describe('Director — autonomous talk loop', () => {
  it('airs beats from batched calls and records them', async () => {
    const { brain, player, host, memory, director } = setup()
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(3)
    // Batches cover multiple segments in order: the extras air from the
    // look-ahead buffer, never regenerated (a cold call per segment would air
    // fresh later-batch beats instead of b).
    expect(host.radio).toEqual(['a', 'b', 'c'])
    expect(player.played).toHaveLength(3)
    expect(memory.recent(10).map((t) => t.text)).toEqual(['a', 'b', 'c'])
  })

  it('a failing brain degrades to a skipped segment, never a crash', async () => {
    const { brain, host, director } = setup()
    brain.batches = [] // every call throws
    await director.run(2)
    expect(host.radio).toEqual([])
    expect(host.infos.some((m) => m.includes('talk generation failed'))).toBe(true)
  })

  it('a failing synth retries then skips the segment', async () => {
    const retry = setup()
    retry.brain.batches = [['a']]
    retry.voice.failTimes = 1 // first attempt fails; retry succeeds
    await retry.director.run(1)
    expect(retry.host.radio).toEqual(['a'])

    const skip = setup()
    skip.brain.batches = [['b']]
    skip.voice.failTimes = 99 // every attempt fails: the segment is skipped
    await skip.director.run(1)
    expect(skip.host.radio).toEqual([])
    expect(skip.host.infos.some((m) => m.includes('voice synthesis failed'))).toBe(true)
  })
})

describe('Director — talk look-ahead (spec 04 §3.3)', () => {
  it('the next segment airs the buffered beat, pre-synthesized behind the prior one', async () => {
    const { brain, voice, host, director } = setup()
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(2)
    // b came from the depth-2 buffer (a cold call at segment 2 would have
    // aired c, the next batch's first beat).
    expect(host.radio).toEqual(['a', 'b'])
    // b's synthesis was scheduled with the cold batch — behind segment 1, not
    // on segment 2's critical path.
    expect(voice.synthesized.slice(0, 2)).toEqual(['a', 'b'])
  })

  it('a top-up refill carries the queued beat as a prior radio turn (coherence)', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1)
    // Call 0 is the cold batch; call 1 is the refill fired after a was
    // recorded, whose context holds BOTH the aired a and the queued-but-unaired
    // b — so the batch continues the monologue instead of duplicating b.
    await until(() => brain.talkContexts.length >= 2, 'refill fired')
    const texts = brain.talkContexts[1]!.recent.map((t) => t.text)
    expect(texts).toContain('a')
    expect(texts).toContain('b')
    expect(brain.talkContexts[1]!.recent.at(-1)).toEqual({ role: 'radio', text: 'b' })
    // The refill's stages land in the dev log (spec 04 §3.3).
    expect(host.debugs.some((m) => m.includes('talk.refill'))).toBe(true)
  })

  it('a transient nextTalks failure is retried; the beat still airs', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a', 'b']]
    brain.nextTalksFailTimes = 1
    await director.run(1)
    expect(host.radio).toEqual(['a'])
  })
})

describe('Director — prepare-then-barge-in interjection', () => {
  it('keeps playing while composing, then cuts over when the reply is ready', async () => {
    const { brain, player, host, memory, director } = setup()
    // Batch 2 feeds the background refill (discarded by the steer); batch 3 is
    // the fresh post-reply regeneration.
    brain.batches = [['a'], ['bg'], ['next']]
    brain.respondDelayMs = 40
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'first clip on air')
    host.type('hi')
    // While the reply composes, the current clip must keep playing (no stop).
    await new Promise((r) => setTimeout(r, 15))
    expect(player.stops).toBe(0)
    expect(player.playing).toBe(true)
    // Reply lands: the clip is cut, the reply airs over the same channel.
    await until(() => player.stops === 1, 'barge-in stop')
    await until(() => host.radio.length === 2, 'reply aired')
    expect(host.radio[1]).toBe('re:hi')
    expect(memory.recent(10).map((t) => `${t.role}:${t.text}`)).toEqual([
      'radio:a',
      'user:hi',
      'radio:re:hi',
    ])
    player.finish() // reply clip ends
    await until(() => player.played.length >= 3, 'program resumes') // next segment airs
    host.type('/quit')
    player.finish()
    await run
  })

  it('merges lines arriving before the reply is ready into one reply', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    brain.respondDelayMs = 40
    player.auto = false
    const run = director.run(1)
    await until(() => player.played.length === 1, 'clip on air')
    host.type('one')
    await new Promise((r) => setTimeout(r, 10))
    host.type('two')
    await until(() => host.radio.length === 2, 'merged reply aired')
    // The reply covers both lines in one respond call; the discarded first
    // prepare may also have recorded its call — the FINAL one is merged.
    expect(brain.respondCalls.at(-1)).toBe('one\ntwo')
    expect(host.user).toEqual(['one', 'two'])
    expect(host.radio[1]).toBe('re:one\ntwo')
    player.finish()
    player.finish()
    await run
  })

  it('a reply that fails to compose returns to the program', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    brain.failRespond = true
    player.auto = false
    const run = director.run(1)
    await until(() => player.played.length === 1, 'clip on air')
    host.type('hi')
    await until(() => host.infos.some((m) => m.includes('reply failed')), 'degraded')
    expect(player.stops).toBe(0) // nothing to barge in with; clip plays on
    player.finish()
    await run
    expect(host.radio).toEqual(['a'])
  })

  it('discards buffered look-ahead beats on a talkback (stale after the user turn)', async () => {
    const { brain, player, host, director } = setup()
    // Batch 2 is consumed by the background refill; the steer discards both the
    // buffered stale-b and the refilled bg, so the resume regenerates fresh.
    brain.batches = [['a', 'stale-b'], ['bg'], ['fresh']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'clip on air')
    host.type('hi')
    await until(() => host.radio.length === 2, 'reply aired')
    player.finish() // reply ends -> next segment
    await until(() => host.radio.length === 3, 'next segment')
    expect(host.radio[2]).toBe('fresh') // never a stale buffered beat
    expect(host.radio).not.toContain('stale-b')
    expect(host.radio).not.toContain('bg')
    player.finish()
    await run
  })
})

describe('Director — memory wiring (spec 05)', () => {
  it('assembles the pack from the store: profile, covered topics, scene', async () => {
    const store = new PersistentMemoryStore({ dir: mkdtempSync(join(tmpdir(), 'murmur-dir-')) })
    store.applyCompaction('knows jazz', 0)
    store.recordEvent('topic', 'rain')
    store.recordEvent('topic', 'coffee')
    const { brain, director } = setup({ memory: store })
    brain.batches = [['a']]
    await director.run(1)
    const ctx = brain.talkContexts.at(-1)!
    expect(ctx.profile).toBe('knows jazz')
    expect(ctx.coveredTopics).toEqual(['rain', 'coffee'])
    expect(SCENES).toContain(ctx.scene)
  })

  it('ledgers a beat topic at air time; untagged beats ledger nothing', async () => {
    const { brain, memory, director } = setup()
    brain.batches = [[{ text: 'tagged', topic: 'night walks' }, { text: 'plain' }]]
    await director.run(2)
    expect(memory.recentTopics(10)).toEqual(['night walks'])
    expect(memory.recent(10).map((t) => t.text)).toEqual(['tagged', 'plain'])
  })

  it('pokes the compactor once per segment boundary', async () => {
    const pokes: number[] = []
    const compactor = { maybeSchedule: () => (pokes.push(1), false) }
    const { brain, director } = setup({ compactor })
    brain.batches = [['a', 'b'], ['c']]
    await director.run(3)
    expect(pokes.length).toBe(3)
  })
})

describe('Director — quit', () => {
  it('/quit during playback stops the clip and exits cleanly', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('/quit')
    await run
    expect(player.stops).toBeGreaterThanOrEqual(1)
    expect(host.radio).toEqual(['a'])
  })

  it('/quit merged into a compose window quits without airing the reply', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    brain.respondDelayMs = 60
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('hi')
    await new Promise((r) => setTimeout(r, 10))
    host.type('/quit')
    await run
    expect(host.radio).toEqual(['a']) // no reply aired
  })

  it('a line typed during the gap gets a reply, then the program moves on', async () => {
    // A long gap makes the sequencing deterministic: the line always lands
    // inside the gap, and the steer aborts the remaining sleep. Batch 2 feeds
    // the background refill the steer discards; batch 3 airs post-reply.
    const { brain, host, director } = setup({ gapSeconds: 3 })
    brain.batches = [['a'], ['bg'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('hey')
    await until(() => host.radio.includes('re:hey'), 'gap reply aired')
    await until(() => host.radio.includes('b'), 'program resumed')
    await run
    expect(host.radio).toEqual(['a', 're:hey', 'b'])
  })

  it('requestQuit stops the loop between segments', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    director.requestQuit()
    player.finish()
    await run
    expect(host.radio).toEqual(['a'])
  })
})

// spec 10 §2.1/§3.2-D: what the Director tells a front-end with a status
// region. Pushed at boundaries, never polled — and no host is required to care.
describe('Director — program state (spec 10)', () => {
  it('announces each talk segment as it airs, with the scene', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a']]
    await director.run(1)
    const talk = host.states.filter((s) => s.kind === 'talk')
    expect(talk).toHaveLength(1)
    expect(SCENES).toContain(talk[0]!.scene)
  })

  it('marks the gap between segments so the strip does not claim to be talking', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a', 'b']]
    await director.run(2)
    expect(host.states.map((s) => s.kind)).toEqual(['talk', 'gap', 'talk'])
  })

  it('a host with no status region is untouched (onState is optional)', async () => {
    const { brain, host, director } = setup()
    // The pre-spec-10 shape: a Host that never implemented onState.
    delete (host as Partial<FakeHost>).onState
    brain.batches = [['a']]
    await expect(director.run(1)).resolves.toBeUndefined()
    expect(host.radio).toEqual(['a'])
  })
})
