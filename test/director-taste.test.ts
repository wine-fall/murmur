// The Director's taste seams (spec 14): the /sources recall parks the loop,
// the digest rides the pack and the music situation, the boot refresh never
// blocks the air, and invitations go out once per change.
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { EveryNCadence } from '../src/director/cadence.ts'
import { Director, type DirectorDeps, steerFromLine } from '../src/director/director.ts'
import type { Invitation } from '../src/host/ipc.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import type { SourceId } from '../src/music/sources/taste.ts'
import { directorSettings, FakeBrain, FakeHost, FakeMixingPlayer, FakePlayer, FakeTrackSource, FakeVoice, pickOf, until } from './fakes.ts'

const DIGEST = '## What the listener keeps (as of 2026-09-06)\nSources: NetEase (3 liked)'

type Taste = NonNullable<DirectorDeps['taste']>

function fakeTaste(over: Partial<Taste> & { mountedIds?: SourceId[]; digestText?: string } = {}): Taste & { refreshes: number } {
  const taste = {
    refreshes: 0,
    digest: () => over.digestText ?? DIGEST,
    mounted: () => over.mountedIds ?? [],
    maybeRefresh: () => void taste.refreshes++,
    ...over,
  }
  return taste
}

function setup(over: Partial<DirectorDeps> & { gapSeconds?: number } = {}) {
  const { gapSeconds = 0, ...rest } = over
  const brain = new FakeBrain()
  brain.batches = [['a', 'b'], ['c', 'd'], ['e', 'f']]
  const voice = new FakeVoice()
  const player = new FakePlayer()
  const host = new FakeHost()
  const memory = new InProcessMemoryStore()
  const knobs = directorSettings({ gapSeconds })
  const director = new Director({
    persona: 'p',
    brain,
    voice,
    player,
    memory,
    host,
    settings: () => knobs,
    openUrl: () => {},
    ...rest,
  })
  return { brain, voice, player, host, memory, knobs, director }
}

const commands = (rows: Invitation[][]): string[][] => rows.map((set) => set.map((r) => r.command))

describe('the /sources command (spec 14 §3.1)', () => {
  it('parses as its own intent, never talk-back', () => {
    expect(steerFromLine('/sources').intent).toBe('sources')
    expect(steerFromLine(' /sources ').intent).toBe('sources')
  })

  it('parks the talk loop inside the recall and resumes after, like /setup', async () => {
    let inRecall = false
    let recalls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { brain, player, host, director } = setup({
      sourcesRecall: async () => {
        recalls++
        inRecall = true
        await gate
        inRecall = false
      },
    })
    brain.batches = [['a'], ['b']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'first clip on air')
    host.type('/sources')
    await until(() => inRecall, 'the recall opened')
    await sleep(30)
    expect(player.played.length).toBe(1)
    release()
    player.finish()
    await until(() => player.played.length === 2, 'the broadcast resumed')
    host.type('/quit')
    await run
    expect(recalls).toBe(1)
    expect(host.user).toEqual([]) // a command, not a turn: never echoed, never replied to
  })

  it('without the recall wiring (a stub run), /sources answers with a pointer line', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('/sources')
    await until(() => host.infos.some((m) => m.includes('--brain stub')), 'the pointer line')
    host.type('/quit')
    await run
  })
})

describe('the digest reaches the brain (spec 14 §2.3/§5.3)', () => {
  it('rides the talk pack and the reply pack when there is one', async () => {
    const { brain, director } = setup({ taste: fakeTaste() })
    brain.batches = [['a'], ['b']]
    await director.run(1)
    expect(brain.talkContexts[0]!.taste).toBe(DIGEST)
  })

  it('leaves the pack field absent when the digest is empty, and on a run with no taste wiring', async () => {
    const { brain, director } = setup({ taste: fakeTaste({ digestText: '' }) })
    await director.run(1)
    expect(brain.talkContexts[0]).not.toHaveProperty('taste')
    const bare = setup()
    await bare.director.run(1)
    expect(bare.brain.talkContexts[0]).not.toHaveProperty('taste')
  })

  it('appends the digest to the music situation the pick task receives', async () => {
    const player = new FakeMixingPlayer()
    const source = new FakeTrackSource()
    source.picks = [pickOf('https://stream/1')]
    const { director } = setup({ player, music: { source, cadence: new EveryNCadence(1), engine: player }, taste: fakeTaste() })
    const run = director.run(2)
    await until(() => source.contexts.length >= 1, 'a pick was asked for')
    expect(source.contexts[0]!.situation).toContain(DIGEST)
    expect(source.contexts[0]!.situation).toMatch(/strong prior/)
    await until(() => player.handles.length === 1, 'song on air')
    player.handles[0]!.end()
    await run
  })
})

describe('boot never waits (spec 14 §3.4/§5.9)', () => {
  it('pokes the refresh only once the second beat has aired, and never awaits it', async () => {
    const airedAtPoke: number[] = []
    const player = new FakePlayer()
    const taste = fakeTaste({
      maybeRefresh: () => {
        airedAtPoke.push(player.played.length)
        void new Promise<never>(() => {})
      },
    })
    const { brain, director } = setup({ taste, player })
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(3)
    expect(player.played).toHaveLength(3)
    expect(airedAtPoke.length).toBeGreaterThanOrEqual(1)
    expect(Math.min(...airedAtPoke)).toBeGreaterThanOrEqual(2)
  })

  it('airs the first beat at the same index with a hanging refresh as with no taste at all', async () => {
    const hang = fakeTaste({ maybeRefresh: () => void new Promise<never>(() => {}) })
    const withTaste = setup({ taste: hang })
    await withTaste.director.run(2)
    const without = setup()
    await without.director.run(2)
    expect(withTaste.player.played.length).toBe(without.player.played.length)
    expect(withTaste.host.radio).toEqual(without.host.radio)
  })
})

describe('invitations (spec 14 §2.7/§5.10)', () => {
  it('sends the boot set, then one message per change — never on a timer', async () => {
    const { brain, host, director } = setup({ taste: fakeTaste(), gapSeconds: 0.01 })
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(3)
    // Boot: /sources alone (nothing mounted). After the first segment: /bug
    // joins. The second and third segments change nothing, so nothing is sent.
    expect(commands(host.invited)).toEqual([['/sources'], ['/sources', '/bug']])
  })

  it('sends nothing for /sources once something is mounted, and drops it after a mount mid-session', async () => {
    let mounted: SourceId[] = []
    const { brain, player, host, director } = setup({
      taste: fakeTaste({ mounted: () => mounted }),
      sourcesRecall: async () => {
        mounted = ['spotify']
      },
    })
    brain.batches = [['a'], ['b']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'first clip on air')
    expect(commands(host.invited)).toEqual([['/sources']])
    player.finish() // the first segment is aired: /bug joins
    await until(() => host.invited.length === 2, 'the post-segment set')
    expect(commands(host.invited)[1]).toEqual(['/sources', '/bug'])
    await until(() => player.played.length === 2, 'second clip on air')
    host.type('/sources')
    await until(() => host.invited.length === 3, 'the post-mount set')
    expect(commands(host.invited)[2]).toEqual(['/bug'])
    player.finish()
    host.type('/quit')
    await run
  })

  it('a used feedback command leaves the set for the session', async () => {
    const { brain, player, host, director } = setup({ taste: fakeTaste({ mountedIds: ['netease'] }) })
    brain.batches = [['a'], ['b']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'first clip on air')
    expect(commands(host.invited)).toEqual([[]])
    player.finish()
    await until(() => player.played.length === 2, 'second clip on air')
    expect(commands(host.invited)).toEqual([[], ['/bug']])
    host.type('/bug')
    await until(() => host.invited.length === 3, 'the post-filing set')
    expect(commands(host.invited)[2]).toEqual([])
    player.finish()
    host.type('/quit')
    await run
  })

  it('adds /feature-request at the session mark, from a one-shot timer', async () => {
    const { brain, player, host, director } = setup({ taste: fakeTaste({ mountedIds: ['netease'] }), featureInviteAfterMs: 40 })
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'first clip on air')
    await until(() => host.invited.some((set) => set.some((r) => r.command === '/feature-request')), 'the mark')
    expect(commands(host.invited).at(-1)).toEqual(['/feature-request'])
    player.finish()
    host.type('/quit')
    await run
  })

  it('a run with no taste wiring still invites — /sources included, since nothing is mounted', async () => {
    const { director, host } = setup()
    await director.run(1)
    expect(commands(host.invited)[0]).toEqual(['/sources'])
  })
})
