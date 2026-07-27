import { describe, expect, it } from 'vitest'

import { InProcessMemoryStore } from '../src/memory.ts'
import { Director, steerFromLine, type DirectorDeps } from '../src/director.ts'
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
    talkBatch: 2,
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
    brain.batches = [['a', 'b'], ['c']]
    await director.run(3)
    expect(host.radio).toEqual(['a', 'b', 'c'])
    expect(player.played).toHaveLength(3)
    // One batch covers two segments: only two Brain calls for three beats.
    expect(brain.nextTalksCalls).toBe(2)
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
    const { brain, voice, host, director } = setup()
    brain.batches = [['a'], ['b']]
    voice.failTimes = 1 // first attempt fails; retry succeeds
    await director.run(1)
    expect(host.radio).toEqual(['a'])
    voice.failTimes = 99 // both attempts fail on the next beat
    await director.run(1)
    expect(host.radio).toEqual(['a'])
    expect(host.infos.some((m) => m.includes('voice synthesis failed'))).toBe(true)
  })
})

describe('Director — prepare-then-barge-in interjection', () => {
  it('keeps playing while composing, then cuts over when the reply is ready', async () => {
    const { brain, player, host, memory, director } = setup()
    brain.batches = [['a'], ['next']]
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
    brain.batches = [['a', 'stale-b'], ['fresh']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'clip on air')
    host.type('hi')
    await until(() => host.radio.length === 2, 'reply aired')
    player.finish() // reply ends -> next segment
    await until(() => host.radio.length === 3, 'next segment')
    expect(host.radio[2]).toBe('fresh') // not the stale buffered beat
    expect(brain.nextTalksCalls).toBe(2)
    player.finish()
    await run
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
    // inside the gap, and the steer aborts the remaining sleep.
    const { brain, host, director } = setup({ gapSeconds: 3 })
    brain.batches = [['a'], ['b']]
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
