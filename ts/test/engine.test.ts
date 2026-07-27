// Engine behavior on OfflineAudioContext (spec 03-02 acceptance #2/#3/#4/#6 +
// 03-04): the same graph the live engine builds, rendered deterministically —
// gain choreography is asserted numerically on samples, no device, no network.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OfflineAudioContext } from 'node-web-audio-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AudioClip, MusicHandle } from '../src/contracts.ts'
import { AudioEngine, type Decode } from '../src/engine.ts'
import { encodeWav } from '../src/wav.ts'

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

// Let the eager scheduling of a synchronous fake stream settle before render.
const settle = () => new Promise((r) => setTimeout(r, 25))

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
    const { context, engine } = build(3, dcChunks(0.5, 3))
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

  it('interjection semantics: stop() cuts voice, never the song', async () => {
    const { context, engine } = build(2, dcChunks(0.5, 2))
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
    const engine = new AudioEngine({ context, decode, rampS: 0.2, bedGain: 0.5, bedXfadeS: 0.2 })
    await engine.startBed({ tracks: () => ['bed://a'] })
    // song starts mid-render (t=1): mutate under suspend, then resume
    let handle: MusicHandle | null = null
    const suspended = context.suspend(1.0).then(async () => {
      handle = await engine.playMusic(MUSIC)
      await handle.waitStarted(1)
      await settle()
      await context.resume()
    })
    const rendered = await context.startRendering()
    await suspended
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

describe('teardown', () => {
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
