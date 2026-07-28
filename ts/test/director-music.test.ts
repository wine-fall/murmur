// The Director's music branch (spec 03-02 §3.5 + §1 #5/#6/#9) on fakes: cadence
// consulted at boundaries, prefetch never blocks the air, real audio confirmed
// before the announce commits, interjections duck (never stop) the song.
import { describe, expect, it } from 'vitest'

import { EveryNCadence } from '../src/cadence.ts'
import { Director, type DirectorDeps } from '../src/director.ts'
import {
  FakeBrain,
  FakeHost,
  FakeMixingPlayer,
  FakeMusicHandle,
  FakeTrackSource,
  FakeVoice,
  pickOf,
  until,
} from './fakes.ts'

function build(overrides: Partial<DirectorDeps> = {}) {
  const brain = new FakeBrain()
  brain.batches = [
    ['talk one', 'talk two'],
    ['talk three', 'talk four'],
    ['talk five', 'talk six'],
  ]
  const voice = new FakeVoice()
  const player = new FakeMixingPlayer()
  const host = new FakeHost()
  const source = new FakeTrackSource()
  const memory = {
    turns: [] as { role: 'radio' | 'user'; text: string }[],
    record(turn: { role: 'radio' | 'user'; text: string }) {
      this.turns.push(turn)
    },
    recent(n: number) {
      return this.turns.slice(-n)
    },
  }
  const deps: DirectorDeps = {
    persona: 'persona',
    brain,
    voice,
    player,
    memory,
    host,
    gapSeconds: 0,
    recentWindow: 6,
    talkBatch: 2,
    music: { source, cadence: new EveryNCadence(1), engine: player },
    ...overrides,
  }
  return { deps, brain, voice, player, host, source, memory, director: new Director(deps) }
}

describe('music scheduling (cadence at the boundary)', () => {
  it('airs a music segment when the cadence says so, announce over the ducked head', async () => {
    const { director, player, host, source, memory } = build()
    source.picks = [pickOf('https://stream/song1', { title: 'Song', artist: 'Artist', announce: 'up next' })]
    const run = director.run(2) // talk, then music
    await until(() => player.handles.length === 1, 'song on air')
    // the announce is an on-air voice clip riding the engine's auto-duck
    await until(() => player.played.length >= 2, 'announce aired')
    expect(memory.turns.some((t) => t.text === 'up next')).toBe(true)
    expect(host.infos.some((m) => m.includes('Song') && m.includes('Artist'))).toBe(true)
    player.handles[0]!.end() // natural end -> segment over
    await run
    expect(player.handles[0]!.stopped).toBe(false)
    expect(player.music[0]!.source).toBe('https://stream/song1')
  })

  it('a pick without an announce plays the track directly', async () => {
    const { director, player, source } = build()
    source.picks = [pickOf('https://stream/plain')]
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'song on air')
    expect(player.played.length).toBe(1) // only the talk segment's clip
    player.handles[0]!.end()
    await run
  })

  it('nothing suitable found degrades to talk', async () => {
    const { director, host, player } = build()
    // source.picks empty -> nextTrack returns null
    await director.run(3)
    expect(host.infos.some((m) => m.includes('nothing suitable'))).toBe(true)
    expect(player.music.length).toBe(0)
    expect(host.radio.length).toBe(3) // every segment fell back to talk
  })
})

describe('prefetch (spec 04 slice: never block the air)', () => {
  it('a pick still resolving yields a talk segment instead of dead air', async () => {
    const { deps, host, source, player } = build()
    const director = new Director({ ...deps, gapSeconds: 0.1 })
    let resolvePick!: (p: ReturnType<typeof pickOf> | null) => void
    const gated = new Promise<ReturnType<typeof pickOf> | null>((r) => (resolvePick = r))
    source.nextTrack = async (ctx) => {
      source.calls++
      source.contexts.push(ctx)
      return gated
    }
    const run = director.run(3)
    // boundary 2 wants music but the prefetched pick is in flight -> talk airs
    await until(() => host.radio.length >= 2, 'second talk aired')
    expect(player.music.length).toBe(0)
    resolvePick(pickOf('https://stream/slow'))
    await until(() => player.handles.length === 1, 'music aired once the pick resolved')
    player.handles[0]!.end()
    await run
    expect(source.calls).toBe(1) // single-slot: one prefetch, consumed at the boundary
  })

  it('the avoid-list carries songs already played this session', async () => {
    const { director, player, source } = build()
    source.picks = [
      pickOf('https://stream/a', { title: 'First Song', artist: 'A' }),
      pickOf('https://stream/b', { title: 'Second Song', artist: 'B' }),
    ]
    const run = director.run(4)
    await until(() => player.handles.length === 1, 'first song')
    player.handles[0]!.end()
    await until(() => player.handles.length === 2, 'second song')
    player.handles[1]!.end()
    await run
    const lastCtx = source.contexts.at(-1)!
    expect(lastCtx.situation).toContain('First Song')
  })
})

describe('confirm real audio before committing (the announced-but-silent guard)', () => {
  it('a stream that never starts is dropped for a fresh pick', async () => {
    const { director, player, host, source } = build()
    player.nextHandles = [new FakeMusicHandle(false), new FakeMusicHandle(true)]
    source.picks = [
      pickOf('https://stream/dead', { announce: 'never airs' }),
      pickOf('https://stream/live', { title: 'Live One' }),
    ]
    const run = director.run(2)
    await until(() => player.handles.length === 2, 'retry with a fresh pick')
    expect(player.handles[0]!.stopped).toBe(true)
    expect(host.radio).not.toContain('never airs')
    expect(host.infos.some((m) => m.includes('Live One'))).toBe(true)
    player.handles[1]!.end()
    await run
  })

  it('all attempts dead degrades visibly to talk', async () => {
    const { director, player, host, source } = build()
    player.nextHandles = [new FakeMusicHandle(false), new FakeMusicHandle(false)]
    source.picks = [pickOf('https://stream/dead1'), pickOf('https://stream/dead2')]
    await director.run(3)
    expect(host.infos.some((m) => m.includes('stream failed to start'))).toBe(true)
    expect(host.radio.length).toBe(3) // the boundary fell back to talk
  })
})

describe('interjections during a song (duck, never stop)', () => {
  it('a typed line replies over the song; the song survives and finishes naturally', async () => {
    const { director, player, host, source, brain } = build()
    source.picks = [pickOf('https://stream/song', { announce: 'intro' })]
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'song on air')
    host.type('hello there')
    await until(() => brain.respondCalls.length === 1, 'reply composed')
    await until(() => player.played.some((c) => c.source === '/fake/3.wav'), 'reply aired over the song')
    expect(player.handles[0]!.stopped).toBe(false)
    player.handles[0]!.end()
    await run
    expect(host.radio).toContain('re:hello there')
  })

  it('/quit during a song stops it (sole authority on shutdown)', async () => {
    const { director, player, host, source } = build()
    source.picks = [pickOf('https://stream/song')]
    const run = director.run(5)
    await until(() => player.handles.length === 1, 'song on air')
    host.type('/quit')
    await run
    expect(player.handles[0]!.stopped).toBe(true)
  })
})
