// Engine behavior on OfflineAudioContext (spec 03-02 acceptance #2/#3/#4/#6 +
// 03-04): the same graph the live engine builds, rendered deterministically —
// gain choreography is asserted numerically on samples, no device, no network.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OfflineAudioContext } from 'node-web-audio-api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AudioClip, MusicHandle } from '../src/contracts.ts'
import { AudioEngine, RAMP_S, UNDUCK_RAMP_S, type Decode } from '../src/audio/engine.ts'
import { logBins, VIZ_BINS } from '../src/audio/viz.ts'
import { encodeWav } from '../src/audio/wav.ts'

const RATE = 48_000

// A fake decode stream: interleaved-stereo DC blocks — flat known amplitude, so
// gain choreography reads directly off the rendered samples.
function dcChunks(value: number, seconds: number, chunkS = 0.25): Decode {
  return async function* () {
    const chunkFrames = Math.round(chunkS * RATE)
    let left = Math.round(seconds * RATE)
    while (left > 0) {
      const frames = Math.min(chunkFrames, left)
      left -= frames
      const pcm = new Float32Array(frames * 2)
      pcm.fill(value)
      yield pcm
    }
  }
}

// oxlint-disable-next-line require-yield -- dying before the first yield IS the fixture
const deadStream: Decode = async function* () {
  throw new Error('this stream never decodes a frame')
}

// Mean |sample| over a window — DC in, gain out.
function level(rendered: AudioBuffer, fromS: number, toS: number): number {
  const ch = rendered.getChannelData(0)
  const a = Math.round(fromS * RATE)
  const b = Math.min(Math.round(toS * RATE), ch.length)
  let sum = 0
  for (let i = a; i < b; i++) sum += Math.abs(ch[i]!)
  return sum / (b - a)
}

let dir: string
let voiceClip: AudioClip // 1s of DC 0.25 (audible in renders)
let silentClip: AudioClip // 1s of silence (duck windows stay music-only)

function dcWav(value: number, seconds: number): Buffer {
  const frames = Math.round(seconds * RATE)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(value * 32767), i * 2)
  return encodeWav({ channels: 1, sampleRate: RATE, bitsPerSample: 16 }, data)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'murmur-engine-test-'))
  const voicePath = join(dir, 'voice.wav')
  const silentPath = join(dir, 'silent.wav')
  await writeFile(voicePath, dcWav(0.25, 1))
  await writeFile(silentPath, dcWav(0, 1))
  voiceClip = { source: voicePath, kind: 'talk' }
  silentClip = { source: silentPath, kind: 'talk' }
})

afterAll(() => rm(dir, { recursive: true, force: true }))

type EngineOverrides = Partial<ConstructorParameters<typeof AudioEngine>[0]>

function build(seconds: number, decode: Decode, overrides: EngineOverrides = {}) {
  const context = new OfflineAudioContext(2, Math.round(seconds * RATE), RATE)
  const engine = new AudioEngine({ context, decode, rampS: 0.2, ...overrides })
  return { context, engine }
}

// Let the graph finish building before startRendering. It is built by async
// work a render cannot wait on from the inside — a voice clip's read + decode,
// the fake stream's chunk scheduling — so ONE fixed sleep is a race the moment
// the runner is loaded (a full-suite run starves the timer and the render then
// sees an unducked graph). Yield many short turns instead of guessing one long
// one: a starved loop gets that many chances to run the pending continuations.
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
}

const MUSIC = { source: 'fake://music', kind: 'music' } as const

describe('voice channel', () => {
  it('plays a clip through to the output', async () => {
    const { context, engine } = build(1, dcChunks(0, 0))
    const played = engine.play(voiceClip)
    await settle()
    const rendered = await context.startRendering()
    await played
    expect(level(rendered, 0.1, 0.9)).toBeCloseTo(0.25, 1)
  })

  it('an unreadable clip degrades to a silent segment, never a rejection', async () => {
    const { engine } = build(1, dcChunks(0, 0))
    await engine.play({ source: '/nonexistent/clip.wav', kind: 'talk' }) // must not throw
    await engine.aclose()
  })

  it('stop() cuts the voice; play() resolves', async () => {
    const { context, engine } = build(1, dcChunks(0, 0))
    const played = engine.play(voiceClip)
    await settle()
    await engine.stop()
    const rendered = await context.startRendering()
    await played
    expect(level(rendered, 0.2, 0.9)).toBeLessThan(0.01)
  })
})

describe('ducking (acceptance #2/#3)', () => {
  it('play(voice) ducks live music and the unduck lands at the clip end', async () => {
    const { context, engine } = build(3, dcChunks(0.5, 3), { unduckRampS: 0.2 })
    const handle = await engine.playMusic(MUSIC)
    expect(await handle.waitStarted(1)).toBe(true)
    const played = engine.play(silentClip) // voice occupies [0, 1]
    await settle()
    const rendered = await context.startRendering()
    await played
    // duck plateau after the 0.2s ramp: music at 0.5 * 0.3
    expect(level(rendered, 0.4, 0.95)).toBeCloseTo(0.15, 1)
    // declaratively scheduled unduck: back to full after clip end + ramp
    expect(level(rendered, 1.4, 2.9)).toBeCloseTo(0.5, 1)
  })

  // spec 03-02 §1 #6: the song dips fast under a voice and comes back SLOWLY —
  // a 0.3s snap back to full is the "hard" edge the by-ear pass flagged.
  it('ducks fast and unducks on the slow ramp (the default UNDUCK_RAMP_S)', async () => {
    const { context, engine } = build(5, dcChunks(0.5, 5)) // engine default unduck ramp
    const handle = await engine.playMusic(MUSIC)
    expect(await handle.waitStarted(1)).toBe(true)
    const played = engine.play(silentClip) // voice occupies [0, 1]; unduck at 1.0
    await settle()
    const rendered = await context.startRendering()
    await played
    expect(UNDUCK_RAMP_S).toBeGreaterThan(RAMP_S)
    // the duck itself is still the fast ramp: plateau well before the clip ends
    expect(level(rendered, 0.4, 0.95)).toBeCloseTo(0.15, 1)
    // 1.2s into a 2.5s climb: risen off the duck plateau, nowhere near full
    const climbing = level(rendered, 2.1, 2.3)
    expect(climbing).toBeGreaterThan(0.16)
    expect(climbing).toBeLessThan(0.45)
    // full only after the ramp completes at 1.0 + UNDUCK_RAMP_S
    expect(level(rendered, 3.6, 4.9)).toBeCloseTo(0.5, 1)
  })

  // spec 03-02 §1 #6: ducked before the first frame is scheduled, the head is
  // born at the duck target — a ramp here would let a fast source (a local file,
  // a warm cache) come up at full volume and be shoved down 0.3s later.
  it('a duck before the first frame steps, so the head is born ducked', async () => {
    const { context, engine } = build(1, dcChunks(0.5, 1))
    const handle = await engine.playMusic(MUSIC)
    handle.duck() // the Director's head-duck, before any audio exists
    expect(await handle.waitStarted(1)).toBe(true)
    await settle()
    const rendered = await context.startRendering()
    expect(level(rendered, 0, 0.05)).toBeCloseTo(0.15, 2) // 0.5 * DUCK_TARGET
    expect(level(rendered, 0.5, 0.95)).toBeCloseTo(0.15, 2)
  })

  // The Director ducks a track's head and relies on play() to lift it; a clip
  // that never loads returns early, so the lift has to happen there too or the
  // whole song stays at the duck target.
  it('an unreadable clip lifts a ducked song instead of stranding it', async () => {
    const { context, engine } = build(3, dcChunks(0.5, 3))
    const handle = await engine.playMusic(MUSIC)
    handle.duck()
    expect(await handle.waitStarted(1)).toBe(true)
    await engine.play({ source: '/nonexistent/announce.wav', kind: 'talk' })
    await settle()
    const rendered = await context.startRendering()
    // lifted on the ordinary slow ramp, full once it completes
    expect(level(rendered, 2.7, 2.95)).toBeCloseTo(0.5, 1)
  })

  it('interjection semantics: stop() cuts voice, never the song', async () => {
    const { context, engine } = build(2, dcChunks(0.5, 2), { unduckRampS: 0.2 })
    const handle = await engine.playMusic(MUSIC)
    await handle.waitStarted(1)
    const played = engine.play(voiceClip)
    await settle()
    await engine.stop() // the barge-in signal
    const rendered = await context.startRendering()
    await played
    // no voice DC in the output; the song still airs (ducked until the
    // scheduled unduck at the cut clip's natural end, then full)
    expect(level(rendered, 1.4, 1.9)).toBeCloseTo(0.5, 1)
  })

  it('dispatches duck over the abstract handle (acceptance #6)', async () => {
    const calls: string[] = []
    const controlled: MusicHandle = {
      duck: () => void calls.push('duck'),
      unduck: (at) => void calls.push(`unduck@${at?.toFixed(1)}`),
      stop: async () => {},
      wait: async () => {},
      waitStarted: async () => true,
    }
    const { context, engine } = build(1.5, dcChunks(0, 0))
    engine.adoptHandle(controlled)
    const played = engine.play(voiceClip)
    await settle()
    await context.startRendering()
    await played
    expect(calls[0]).toBe('duck')
    expect(calls[1]).toMatch(/^unduck@1\.0/)
  })
})

describe('music lifecycle', () => {
  it('waitStarted is false for a stream that never decodes; wait() resolves', async () => {
    const { engine } = build(1, deadStream)
    const handle = await engine.playMusic(MUSIC)
    expect(await handle.waitStarted(0.5)).toBe(false)
    await handle.wait()
    await engine.aclose()
  })

  it('a decoder that dies mid-song is logged, never a clean short track', async () => {
    // one real chunk, then an abnormal decoder exit
    const dieMidStream: Decode = async function* () {
      yield new Float32Array(4800 * 2).fill(0.5)
      throw new Error('ffmpeg exited 1 mid-stream')
    }
    const logs: string[] = []
    const { context, engine } = build(1, dieMidStream, { log: (m) => void logs.push(m) })
    const handle = await engine.playMusic(MUSIC)
    expect(await handle.waitStarted(0.5)).toBe(true) // it DID start
    await settle()
    await context.startRendering() // the scheduled chunk plays out
    await handle.wait()
    expect(logs.join('\n')).toContain('music stream failed')
    await engine.aclose()
  })

  it('a second playMusic stops the first (one music at a time)', async () => {
    const { engine } = build(2, dcChunks(0.4, 10))
    const first = await engine.playMusic(MUSIC)
    await first.waitStarted(1)
    const second = await engine.playMusic({ source: 'fake://two', kind: 'music' })
    await first.wait() // resolves because it was stopped
    await second.stop()
    await engine.aclose()
  })

  it('handle.stop() ends the music (sole authority on /quit)', async () => {
    const { context, engine } = build(1, dcChunks(0.5, 10))
    const handle = await engine.playMusic(MUSIC)
    await handle.waitStarted(1)
    await handle.stop()
    const rendered = await context.startRendering()
    await handle.wait()
    // stopped before any samples played: silence
    expect(level(rendered, 0.2, 0.9)).toBeLessThan(0.01)
  })
})

describe('background bed (spec 03-04)', () => {
  const bedOf = (...tracks: string[]) => ({ tracks: () => tracks })

  it('plays under talk at the bed gain and never pump-ducks with voice', async () => {
    const decode: Decode = dcChunks(0.4, 4)
    const { context, engine } = build(2, decode, { bedGain: 0.5, bedXfadeS: 0.2 })
    await engine.startBed(bedOf('bed://a'))
    const played = engine.play(silentClip) // a voice clip must NOT duck the bed
    await settle()
    const rendered = await context.startRendering()
    await played
    expect(level(rendered, 0.5, 1.9)).toBeCloseTo(0.4 * 0.5, 2)
    await engine.aclose()
  })

  it('loops track-to-track with a crossfade, no silence gap', async () => {
    // 1s tracks, 0.2s crossfade: the boundary window must hold level (a linear
    // equal-DC crossfade sums flat), never dip toward zero.
    const decode: Decode = dcChunks(0.4, 1)
    const { context, engine } = build(2.5, decode, { bedGain: 0.5, bedXfadeS: 0.2 })
    await engine.startBed(bedOf('bed://a', 'bed://b'))
    await settle()
    const rendered = await context.startRendering()
    const boundary = level(rendered, 0.85, 0.95)
    expect(boundary).toBeGreaterThan(0.15)
    expect(level(rendered, 1.2, 1.7)).toBeCloseTo(0.2, 1)
    await engine.aclose()
  })

  it('crossfades out under the featured song and back after it (deferred to first frame)', async () => {
    const streams: Record<string, Decode> = {
      'bed://a': dcChunks(0.4, 6),
      'fake://music': dcChunks(0.6, 2),
    }
    const decode: Decode = (source, signal) => streams[source]!(source, signal)
    const seconds = 4
    const context = new OfflineAudioContext(2, seconds * RATE, RATE)
    // suspend()/startRendering() race inside node-web-audio-api: both are napi
    // async fns spawned as independent tokio tasks, so on a loaded runner the
    // render task can be polled first, take() the renderer, and suspend rejects
    // InvalidStateError (offline.rs; reproduced in ~1k iterations under CPU
    // load). The engine anchors every move on ctx.currentTime, so instead of
    // mutating mid-render, hand it a clock shifted forward between calls: the
    // song "arrives" at t=1 with the whole graph scheduled before rendering.
    // (AudioParam.value still reads at real t=0, so the bed's out-fade renders
    // as a step at 1.0 instead of a ramp — no asserted window straddles it.)
    let clockShiftS = 0
    const shifted = new Proxy(context, {
      get(target, prop) {
        if (prop === 'currentTime') return target.currentTime + clockShiftS
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const engine = new AudioEngine({
      context: shifted,
      decode,
      rampS: 0.2,
      bedGain: 0.5,
      bedXfadeS: 0.2,
    })
    await engine.startBed({ tracks: () => ['bed://a'] })
    await settle() // bed fully scheduled at t=0
    clockShiftS = 1 // song starts mid-timeline (t=1)
    const handle = await engine.playMusic(MUSIC)
    expect(await handle.waitStarted(1)).toBe(true)
    await settle() // song chunks + the eof-anchored bed return all scheduled
    const rendered = await context.startRendering()
    // bed alone before the song
    expect(level(rendered, 0.5, 0.95)).toBeCloseTo(0.2, 1)
    // song at full, bed crossfaded out
    expect(level(rendered, 1.5, 2.9)).toBeCloseTo(0.6, 1)
    // song over (ends at 3): bed crossfades back in
    expect(level(rendered, 3.5, 3.95)).toBeCloseTo(0.2, 1)
    await engine.aclose()
  })

  it('a stream that never starts leaves the bed untouched (no dead air)', async () => {
    const streams: Record<string, Decode> = {
      'bed://a': dcChunks(0.4, 3),
      'fake://music': deadStream,
    }
    const decode: Decode = (source, signal) => streams[source]!(source, signal)
    const { context, engine } = build(2, decode, { bedGain: 0.5, bedXfadeS: 0.2 })
    await engine.startBed({ tracks: () => ['bed://a'] })
    const handle = await engine.playMusic(MUSIC)
    expect(await handle.waitStarted(0.5)).toBe(false)
    await settle()
    const rendered = await context.startRendering()
    expect(level(rendered, 0.5, 1.9)).toBeCloseTo(0.2, 1)
    await engine.aclose()
  })

  it('every track dead degrades to no bed; the radio does not crash', async () => {
    const { engine } = build(1, deadStream, { bedGain: 0.5 })
    await engine.startBed(bedOf('bed://a', 'bed://b'))
    await settle()
    await engine.aclose()
  })

  it('an empty bed source is a no-op', async () => {
    const { engine } = build(1, dcChunks(0.4, 1))
    await engine.startBed(bedOf())
    await engine.aclose()
  })
})

// The bed remembers where it stopped (spec 03-04 resume): stopBed freezes the
// audible track + offset, and the next startBed replays from there.
describe('bed resume (spec 03-04)', () => {
  const bedOf = (...tracks: string[]) => ({ tracks: () => tracks })

  it('starts at the resumed track, handing decode the offset, then wraps in list order', async () => {
    const calls: [string, number | undefined][] = []
    const decode: Decode = (source, signal, startS) => {
      calls.push([source, startS])
      return dcChunks(0.4, 1)(source, signal)
    }
    const { context, engine } = build(2.5, decode, { bedGain: 0.5, bedXfadeS: 0.2 })
    await engine.startBed(bedOf('bed://a', 'bed://b'), { track: 'bed://b', offsetS: 3 })
    await settle()
    await context.startRendering()
    await settle()
    expect(calls[0]).toEqual(['bed://b', 3])
    expect(calls[1]?.[0]).toBe('bed://a')
    expect(calls[1]?.[1]).toBeUndefined() // the offset applies to the resumed track alone
    await engine.aclose()
  })

  it('ignores a resume track that is no longer cached', async () => {
    const calls: [string, number | undefined][] = []
    const decode: Decode = (source, signal, startS) => {
      calls.push([source, startS])
      return dcChunks(0.4, 30)(source, signal)
    }
    const { engine } = build(1, decode, { bedGain: 0.5 })
    await engine.startBed(bedOf('bed://a'), { track: 'bed://gone', offsetS: 9 })
    await settle()
    expect(calls[0]).toEqual(['bed://a', undefined])
    await engine.aclose()
  })

  it('bedPosition() reports the live track and elapsed offset from the resume point', async () => {
    const { context, engine } = build(2, dcChunks(0.4, 30), { bedGain: 0.5, bedXfadeS: 0.2 })
    await engine.startBed(bedOf('bed://a'), { track: 'bed://a', offsetS: 3 })
    await settle()
    await context.startRendering() // the offline clock ends at t=2
    const pos = engine.bedPosition()
    expect(pos?.track).toBe('bed://a')
    expect(pos?.offsetS).toBeCloseTo(5, 0) // 3 saved + 2 rendered
    await engine.aclose()
  })

  it('stopBed freezes the position so shutdown can persist it after aclose', async () => {
    const { context, engine } = build(2, dcChunks(0.4, 30), { bedGain: 0.5 })
    await engine.startBed(bedOf('bed://a'))
    await settle()
    await context.startRendering()
    await engine.aclose()
    const pos = engine.bedPosition()
    expect(pos?.track).toBe('bed://a')
    expect(pos?.offsetS).toBeCloseTo(2, 0)
  })

  it('is null when no bed ever ran', async () => {
    const { engine } = build(1, dcChunks(0, 0))
    expect(engine.bedPosition()).toBeNull()
    await engine.aclose()
    expect(engine.bedPosition()).toBeNull()
  })

  it('a track that never makes a sound is never the position (nothing stale persists)', async () => {
    const { engine } = build(1, deadStream, { bedGain: 0.5 })
    await engine.startBed(bedOf('bed://a'), { track: 'bed://a', offsetS: 9999 })
    await settle()
    await engine.aclose()
    expect(engine.bedPosition()).toBeNull() // shutdown has nothing to write back
  })

  it('after a dead track the position reports the live one that followed', async () => {
    const streams: Record<string, Decode> = {
      'bed://dead': deadStream,
      'bed://live': dcChunks(0.4, 30),
    }
    const decode: Decode = (source, signal) => streams[source]!(source, signal)
    const { engine } = build(1, decode, { bedGain: 0.5 })
    await engine.startBed(bedOf('bed://dead', 'bed://live'))
    await settle()
    expect(engine.bedPosition()?.track).toBe('bed://live')
    await engine.aclose()
  })
})

describe('teardown', () => {
  it('a closed engine takes no new clip (no dead-sink wait)', async () => {
    const { engine } = build(1, dcChunks(0, 0))
    await engine.aclose()
    const t0 = performance.now()
    await engine.play(voiceClip) // degrades immediately; never waits out the guard
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  it('aclose stops voice, music, and bed cleanly', async () => {
    const { engine } = build(2, dcChunks(0.4, 10), { bedGain: 0.5 })
    await engine.startBed({ tracks: () => ['bed://a'] })
    const handle = await engine.playMusic(MUSIC)
    await handle.waitStarted(1)
    const played = engine.play(voiceClip)
    await settle()
    await engine.aclose()
    await handle.wait()
    await played
  })
})

// spec 10 §3.6 / §5.5: the visualizer's tap on the master bus. What the fast
// layer can prove is the GATING and the graph shape — that an unwatched run has
// no analyser at all, and that opening the tap neither doubles nor disturbs the
// mix. That the bars actually move with music is a by-ear/smoke matter.
describe('visualizer tap (spec 10 §3.6)', () => {
  it('puts no analyser in the graph until something subscribes', async () => {
    // A bed track has to outlast the crossfade: this context is never rendered,
    // so its clock never moves, and a track shorter than BED_XFADE_S would leave
    // runBed re-scheduling the next one at the same frozen instant forever.
    const { context, engine } = build(2, dcChunks(0.4, 10))
    const created = vi.spyOn(context, 'createAnalyser')
    await engine.startBed({ tracks: () => ['bed://a'] })
    const handle = await engine.playMusic(MUSIC)
    await handle.waitStarted(1)
    const played = engine.play(voiceClip)
    await settle()
    // A whole session's worth of audio, nobody watching: no analyser, no reads.
    expect(created).not.toHaveBeenCalled()
    await engine.aclose()
    await played
  })

  it('opens exactly one tap however often the front-end re-subscribes', async () => {
    const { context, engine } = build(1, dcChunks(0.4, 1))
    const created = vi.spyOn(context, 'createAnalyser')
    const first = engine.spectrum()
    const second = engine.spectrum()
    expect(created).toHaveBeenCalledTimes(1)
    expect(first().length).toBe(second().length)
    expect(first().length).toBeGreaterThanOrEqual(VIZ_BINS)
    await engine.aclose()
  })

  it('reads a finite frame off a live graph', async () => {
    const { context, engine } = build(1, dcChunks(0.4, 1))
    const read = engine.spectrum()
    const handle = await engine.playMusic(MUSIC)
    await handle.waitStarted(1)
    await settle()
    await context.startRendering()
    const frame = read()
    // An offline render leaves -Infinity bins behind; logBins is what makes that
    // safe, so all this pins is "a frame of the right shape came back".
    expect(frame.length).toBeGreaterThan(0)
    expect(logBins(frame)).toHaveLength(VIZ_BINS)
    await engine.aclose()
  })

  it('the tap does not change what the mix renders', async () => {
    // The bus is a real node now; a subscribed visualizer must not cost a dB.
    const quiet = build(1, dcChunks(0, 0))
    const watched = build(1, dcChunks(0, 0))
    watched.engine.spectrum()
    const played = [quiet.engine.play(voiceClip), watched.engine.play(voiceClip)]
    await settle()
    const [a, b] = await Promise.all([quiet.context.startRendering(), watched.context.startRendering()])
    await Promise.all(played)
    expect(level(b!, 0.1, 0.9)).toBeCloseTo(level(a!, 0.1, 0.9), 5)
    await Promise.all([quiet.engine.aclose(), watched.engine.aclose()])
  })
})

// spec 12 §3.4: the listener's mute is the master bus gain — instant, mid-word,
// bus-wide (voice + music + bed). The program never notices: clips keep
// rolling, only the output is silent, and unmute picks up mid-sentence.
describe('master mute (spec 12)', () => {
  it('setMuted(true) silences voice and music together', async () => {
    const { context, engine } = build(2, dcChunks(0.5, 2))
    const handle = await engine.playMusic(MUSIC)
    await handle.waitStarted(1)
    const played = engine.play(voiceClip)
    await settle()
    engine.setMuted(true)
    const rendered = await context.startRendering()
    await played
    expect(level(rendered, 0.3, 1.9)).toBeLessThan(0.01) // everything silent post-ramp
  })

  it('setMuted(false) restores the full mix', async () => {
    const { context, engine } = build(2, dcChunks(0.5, 2))
    const handle = await engine.playMusic(MUSIC)
    await handle.waitStarted(1)
    // The chunk feed is async: started != fed. Rendering before the DC has
    // landed reads an empty mix (a slow CI runner failed here, main and PR
    // alike), which is why the sibling test settles too.
    await settle()
    engine.setMuted(true)
    engine.setMuted(false)
    const rendered = await context.startRendering()
    expect(level(rendered, 1.0, 1.9)).toBeCloseTo(0.5, 1) // music back at full
  })
})
