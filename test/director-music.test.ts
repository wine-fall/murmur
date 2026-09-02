// The Director's music branch (spec 03-02 §3.5 + §1 #5/#6/#9) on fakes: cadence
// consulted at boundaries, prefetch never blocks the air, real audio confirmed
// before the announce commits, interjections duck (never stop) the song.
import { describe, expect, it } from 'vitest'

import { EveryNCadence } from '../src/cadence.ts'
import { Director, type DirectorDeps } from '../src/director.ts'
import { InProcessMemoryStore } from '../src/memory.ts'
import { sceneFor } from '../src/scene.ts'
import {
  directorSettings,
  FakeBrain,
  FakeHost,
  FakeMixingPlayer,
  FakeMusicHandle,
  FakeTrackSource,
  FakeVoice,
  pickOf,
  until,
} from './fakes.ts'

function build(
  overrides: Partial<DirectorDeps> & { gapSeconds?: number; recentWindow?: number } = {},
) {
  const { gapSeconds = 0, recentWindow = 6, ...rest } = overrides
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
  const memory = new InProcessMemoryStore()
  const knobs = directorSettings({ gapSeconds, recentWindow })
  const deps: DirectorDeps = {
    persona: 'persona',
    brain,
    voice,
    player,
    memory,
    host,
    settings: () => knobs,
    music: { source, cadence: new EveryNCadence(1), engine: player },
    // Injected like every other harness: the Director has no default opener,
    // so a browser can never be launched from a test.
    openUrl: () => {},
    ...rest,
  }
  return { deps, knobs, brain, voice, player, host, source, memory, director: new Director(deps) }
}

describe('music scheduling (cadence at the boundary)', () => {
  it('airs a music segment when the cadence says so, announce over the ducked head', async () => {
    const { director, player, host, source, memory } = build()
    source.picks = [pickOf('https://stream/song1', { title: 'Song', artist: 'Artist', announce: 'up next' })]
    const run = director.run(2) // talk, then music
    await until(() => player.handles.length === 1, 'song on air')
    // the announce is an on-air voice clip riding the engine's auto-duck
    await until(() => player.played.length >= 2, 'announce aired')
    expect(memory.recent(99).some((t) => t.text === 'up next')).toBe(true)
    // The aired song is ledgered at air time (spec 05 §3.5) — the cross-day
    // avoid-list, not a session-local list.
    expect(memory.recentSongs(10)).toEqual(['Song — Artist'])
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
  it('the first pick starts resolving at startup, before the cold talk batch (issue #76)', async () => {
    const { deps, brain, source } = build()
    const order: string[] = []
    source.nextTrack = async (ctx) => {
      order.push('music')
      source.calls++
      source.contexts.push(ctx)
      return null
    }
    const origNextTalks = brain.nextTalks.bind(brain)
    brain.nextTalks = async (ctx, count) => {
      order.push('talk')
      return origNextTalks(ctx, count)
    }
    await new Director(deps).run(1)
    // The pick's discovery is independent of the talk batch: serializing them
    // was the measured ~25-35s head start the first song never got back.
    expect(order[0]).toBe('music')
  })

  it('the music situation carries only the freshest turns, not the whole recent window (issue #76)', async () => {
    const memory = new InProcessMemoryStore()
    for (let i = 1; i <= 12; i++) memory.record({ role: 'radio', text: `turn ${i}` })
    const { deps, source } = build({ memory, recentWindow: 12 })
    await new Director(deps).run(1)
    // Choosing music needs the current mood, not the full talk window — and a
    // growing prompt was the measured hot-slower-than-cold term.
    const situation = source.contexts[0]!.situation
    expect(situation).toContain('turn 12')
    expect(situation).not.toContain('turn 5')
  })

  it('a pick still resolving yields a talk segment instead of dead air', async () => {
    const { deps, host, source, player } = build()
    const slow = directorSettings({ gapSeconds: 0.1, recentWindow: 6 })
    const director = new Director({ ...deps, settings: () => slow })
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

  it('a song ledgered in an earlier session reaches the first pick context', async () => {
    const memory = new InProcessMemoryStore()
    memory.recordEvent('song', 'Old Favorite — X')
    const { director, player, source } = build({ memory })
    source.picks = [pickOf('https://stream/a', { title: 'Fresh', artist: 'B' })]
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'song on air')
    player.handles[0]!.end()
    await run
    expect(source.contexts[0]!.situation).toContain('Old Favorite — X')
  })

  // spec 03-01 §2.3: a shallow avoid-list is why a favourite comes back every
  // other evening. The ledger keeps hundreds; the list must reach back far
  // enough to cover more than one session.
  it('the avoid-list reaches back past a single evening of songs', async () => {
    const memory = new InProcessMemoryStore()
    for (let i = 1; i <= 24; i++) memory.recordEvent('song', `Song ${i} — X`)
    const { director, player, source } = build({ memory })
    source.picks = [pickOf('https://stream/a', { title: 'Fresh', artist: 'B' })]
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'song on air')
    player.handles[0]!.end()
    await run
    expect(source.contexts[0]!.situation).toContain('Song 1 — X')
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

describe('talk look-ahead survives music (spec 04 §3.3)', () => {
  it('a beat buffered before a song airs after it — no cold regen at the boundary', async () => {
    const { director, voice, player, host, source } = build()
    source.picks = [pickOf('https://stream/r1')]
    const run = director.run(3) // talk, music, talk
    await until(() => player.handles.length === 1, 'song on air')
    // The buffered beat's clip is ALREADY synthesized while the song plays —
    // the music->talk boundary has no synth wait, not just no Brain wait.
    expect(voice.synthesized).toContain('talk two')
    player.handles[0]!.end()
    await run
    // talk two was buffered before the song and airs warm after it; a cold
    // regeneration at the music->talk boundary would air a later-batch beat.
    expect(host.radio).toEqual(['talk one', 'talk two'])
  })

  it('depth 2: each post-song talk airs a warm buffered beat across two songs', async () => {
    const { director, voice, player, host, source } = build()
    source.picks = [pickOf('https://stream/r1'), pickOf('https://stream/r2')]
    const run = director.run(5) // talk, music, talk, music, talk
    await until(() => player.handles.length === 1, 'first song')
    expect(voice.synthesized).toContain('talk two') // prebuilt before song 1
    player.handles[0]!.end()
    await until(() => player.handles.length === 2, 'second song')
    expect(voice.synthesized).toContain('talk three') // topped up between songs
    player.handles[1]!.end()
    await run
    // The gap-free numbering proves both post-song talks came from the buffer.
    expect(host.radio).toEqual(['talk one', 'talk two', 'talk three'])
  })

  it('a talkback during a song refills the discarded buffer while the song plays', async () => {
    const { director, voice, player, host, source } = build()
    source.picks = [pickOf('https://stream/r1')]
    const run = director.run(3) // talk, music (interjected), talk
    await until(() => player.handles.length === 1, 'song on air')
    host.type('hello')
    await until(() => host.radio.includes('re:hello'), 'reply aired over the song')
    // The steer discarded the pre-song buffer; the post-reply refill uses the
    // remaining song airtime, so fresh beats are prebuilt before the song ends.
    await until(() => voice.synthesized.includes('talk five'), 'fresh beat prebuilt mid-song')
    player.handles[0]!.end()
    await run
    // The post-song talk airs the fresh refilled beat warm — never the stale
    // pre-steer buffer, and not a cold boundary regeneration.
    expect(host.radio.at(-1)).toBe('talk five')
    expect(host.radio).not.toContain('talk two')
  })

  it('an empty buffer refills DURING the song and the boundary airs the prebuilt clip', async () => {
    const { deps, brain, voice, player, host, source } = build()
    // The first segment is music: the buffer is empty and the refill fires at
    // the song's start — its Brain call + synths overlap the song, and the
    // music->talk boundary airs the prebuilt clip with zero cold generation.
    const script: ('talk' | 'music')[] = ['music']
    const director = new Director({
      ...deps,
      music: { ...deps.music!, cadence: { nextKind: async () => script.shift() ?? 'talk' } },
    })
    brain.batches = [['talk one', 'talk two']]
    source.picks = [pickOf('https://stream/r1')]
    const run = director.run(2) // music, talk
    await until(() => player.handles.length === 1, 'song on air (no talk aired yet)')
    // The refill completes while the song plays: both beats are synthesized
    // behind it, and no talk has aired.
    await until(() => voice.synthesized.includes('talk one'), 'beat prebuilt during the song')
    expect(host.radio).toEqual([])
    expect(brain.nextTalksCalls).toBe(1) // the music-start refill only
    player.handles[0]!.end()
    await run
    expect(host.radio).toEqual(['talk one']) // aired warm, no boundary Brain call
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
    await until(() => host.radio.includes('re:hello there'), 'reply aired over the song')
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

  // Ctrl-C is the same intent as /quit but arrives as a signal, not a line —
  // so it has no racer against the song, and a real run sat through the rest of
  // the track before shutdown even began. The song here never ends on its own:
  // if requestQuit does not wake the wait, this test hangs.
  it('requestQuit during a song stops it too, without riding the track out', async () => {
    const { director, player, source } = build()
    source.picks = [pickOf('https://stream/song')]
    const run = director.run(5)
    await until(() => player.handles.length === 1, 'song on air')

    director.requestQuit()
    await run

    expect(player.handles[0]!.stopped).toBe(true)
  })
})

// spec 10 §3.2-D: what keeps "now playing" on the status strip for the whole
// song, including while an interjection's reply airs over it.
describe('program state during music (spec 10)', () => {
  it('reports the track once real audio is confirmed', async () => {
    const { director, player, host, source } = build()
    source.picks = [pickOf('https://stream/song1', { title: 'Song', artist: 'Artist' })]
    const run = director.run(2)
    await until(() => host.states.some((s) => s.kind === 'music'), 'music state')
    const music = host.states.find((s) => s.kind === 'music')!
    expect(music.nowPlaying).toBe('Song — Artist')
    player.handles[0]!.end()
    await run
  })

  it('carries the track length and its start, so a front-end can draw progress', async () => {
    // spec 10 §3.3: the strip's progress bar needs a denominator (the length,
    // resolved with the stream) and an origin (when this track went on air).
    const { director, player, host, source } = build()
    source.picks = [pickOf('https://stream/song1', { title: 'Song', durationS: 183 })]
    const before = Date.now()
    const run = director.run(2)
    await until(() => host.states.some((s) => s.kind === 'music'), 'music state')
    const music = host.states.find((s) => s.kind === 'music')!
    expect(music.durationS).toBe(183)
    expect(music.startedAt).toBeGreaterThanOrEqual(before)
    expect(music.startedAt).toBeLessThanOrEqual(Date.now())
    player.handles[0]!.end()
    await run
  })

  it('says nothing about a length the source did not know — a live stream has none', async () => {
    const { director, player, host, source } = build()
    source.picks = [pickOf('https://stream/live', { title: 'Live' })]
    const run = director.run(2)
    await until(() => host.states.some((s) => s.kind === 'music'), 'music state')
    const music = host.states.find((s) => s.kind === 'music')!
    expect(music.durationS).toBeUndefined()
    expect(music.startedAt).toBeGreaterThan(0) // the origin stands either way
    player.handles[0]!.end()
    await run
  })

  it('holds the start across a re-emit — a typed line must not restart the bar', async () => {
    const { director, player, host, source } = build()
    source.picks = [pickOf('https://stream/song1', { title: 'Song', durationS: 183 })]
    const run = director.run(2)
    await until(() => host.states.some((s) => s.kind === 'music'), 'music state')
    const first = host.states.find((s) => s.kind === 'music')!
    host.type('this one is nice')
    await until(() => host.radio.some((t) => t.startsWith('re:')), 'reply aired')
    expect(host.states.at(-1)).toMatchObject({
      kind: 'music',
      startedAt: first.startedAt,
      durationS: 183,
    })
    player.handles[0]!.end()
    host.type('/quit')
    await run
  })

  it('records how much of the track actually played, so the log can answer "did it finish"', async () => {
    const { director, player, host, source } = build()
    source.picks = [pickOf('https://stream/song1', { title: 'Song', durationS: 183 })]
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'song on air')
    player.handles[0]!.end()
    await run
    const ended = host.debugs.find((m) => m.startsWith('music.end'))
    expect(ended).toBeDefined()
    expect(ended).toContain('Song')
    expect(ended).toMatch(/expected=183s/)
    expect(ended).toMatch(/played=\d+s/)
  })

  it('keeps now-playing while an interjection is answered over the ducked song', async () => {
    // spec 10 §5.3: the reply must not make the strip forget what is playing —
    // the song is still on air, it is only ducked.
    const { director, player, host, source } = build()
    source.picks = [pickOf('https://stream/song1', { title: 'Song', artist: 'Artist' })]
    const run = director.run(2)
    await until(() => host.states.some((s) => s.kind === 'music'), 'music state')
    host.type('this one is nice')
    await until(() => host.radio.some((t) => t.startsWith('re:')), 'reply aired')
    expect(host.states.at(-1)).toMatchObject({ kind: 'music', nowPlaying: 'Song — Artist' })
    player.handles[0]!.end()
    host.type('/quit')
    await run
  })
})

// spec 12 §3.2: the music switch is live at the scheduling site — flipping it
// off makes the very next boundary talk (pure talk radio), flipping it back on
// lets the cadence schedule again. The pipeline is never torn down.
describe('live musicEnabled (spec 12)', () => {
  it('off yields talk at the next boundary; on resumes scheduling', async () => {
    const { knobs, player, host, source, director } = build()
    source.picks = [pickOf('https://stream/s1'), pickOf('https://stream/s2')]
    knobs.musicEnabled = false
    await director.run(3) // cadence would say music at every other boundary
    expect(player.music.length).toBe(0)
    expect(host.radio.length).toBe(3) // all talk
    const on = build()
    on.source.picks = [pickOf('https://stream/s3')]
    const run = on.director.run(2)
    await until(() => on.player.handles.length === 1, 'music back on air')
    on.player.handles[0]!.end()
    await run
  })

  // Peer review (codex): with the pipeline always constructed, the prefetch
  // paths (run start, per beat, per reply) still spent real discovery calls on
  // a session whose live flag said no music. Off = zero spend, not just zero
  // airtime.
  it('spends nothing on discovery while music is off', async () => {
    const { knobs, source, director } = build()
    knobs.musicEnabled = false
    await director.run(3)
    expect(source.calls).toBe(0)
  })

  it('toggling on schedules music again at the next boundary (the away-stream cold path)', async () => {
    const { knobs, player, source, director } = build({ gapSeconds: 0 })
    knobs.musicEnabled = false
    source.picks = [pickOf('https://stream/later')]
    await director.run(1) // one talk segment, no priming while off
    expect(source.calls).toBe(0)
    knobs.musicEnabled = true
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'music on air after the toggle')
    player.handles[0]!.end()
    await run
  })
})

describe('the talk context carries the real music state (spec 04 bugfix)', () => {
  it('a pick still resolving reads as picking, and the real clock rides along', async () => {
    const { deps, brain, source } = build()
    source.nextTrack = () => new Promise(() => {}) // in flight forever
    await new Director(deps).run(1)
    expect(brain.talkContexts[0]!.music).toEqual({ kind: 'picking' })
    expect(brain.talkContexts[0]!.time).toMatch(/^\w+day \d{4}-\d{2}-\d{2}, \d{1,2}:\d{2} [ap]m$/)
  })

  it('a song on air reads as playing, by its now-playing label', async () => {
    const { director, player, host, source, brain } = build()
    source.picks = [pickOf('https://stream/r1', { title: 'Song', artist: 'Artist' })]
    const run = director.run(3)
    await until(() => player.handles.length === 1, 'song on air')
    host.type('hello')
    await until(() => host.radio.includes('re:hello'), 'reply aired over the song')
    player.handles[0]!.end()
    await run
    expect(brain.respondContexts[0]!.music).toEqual({ kind: 'playing', track: 'Song — Artist' })
  })

  it('a pick that came back empty reads as pickFailed', async () => {
    const { director, brain, host } = build() // no picks scripted -> every pick null
    await director.run(3)
    expect(host.infos.some((m) => m.includes('nothing suitable'))).toBe(true)
    expect(brain.talkContexts.some((c) => c.music?.kind === 'pickFailed')).toBe(true)
  })

  it('after the song ends the context names the last track, nothing playing', async () => {
    const { director, knobs, player, brain, source } = build()
    source.picks = [pickOf('https://stream/r1', { title: 'Song', artist: 'Artist' })]
    const run = director.run(3) // talk, music, talk
    await until(() => player.handles.length === 1, 'song on air')
    knobs.musicEnabled = false // no fresh prefetch after the song ends
    player.handles[0]!.end()
    await run
    expect(brain.talkContexts.at(-1)!.music).toEqual({ kind: 'quiet', lastTrack: 'Song — Artist' })
  })

  it('a pick ready but not yet aired still grounds the beat: quiet, nothing playing (codex review)', async () => {
    const { deps, brain, source } = build()
    deps.music!.cadence = new EveryNCadence(99) // music never due; the primed pick just waits
    source.picks = [pickOf('https://stream/ready', { title: 'Ready' })]
    await new Director(deps).run(2)
    expect(brain.talkContexts.at(-1)!.music).toEqual({ kind: 'quiet' })
  })

  it('a forced MURMUR_SCENE drops the clock line rather than contradict it (codex review)', async () => {
    const { deps, brain } = build()
    const real = sceneFor(new Date())
    const forced = real === 'morning' ? 'evening' : 'morning'
    process.env.MURMUR_SCENE = forced
    try {
      await new Director(deps).run(1)
    } finally {
      delete process.env.MURMUR_SCENE
    }
    expect(brain.talkContexts[0]!.scene).toBe(forced)
    expect(brain.talkContexts[0]!.time).toBeUndefined()
  })
})
