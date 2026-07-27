// The mixing audio engine (spec 03-02), redesigned as Web Audio graph
// orchestration on node-web-audio-api (issue #54 Phase 0 decision): source
// nodes + GainNode automation + scheduled starts — the graph IS the mixer, no
// hand-rolled sample loop. Long sources stream as chunk-scheduled buffer
// segments (sample-accurate back-to-back starts; ~1e-11 max seam error measured
// offline), so an hour-long source holds ~leadS seconds of PCM in memory, never
// a whole AudioBuffer.
//
// Channels: featured music (ducks under voice), voice clips (auto-duck any live
// music — one rule covers "talk over music" and "interjection ducks the song"),
// and the low-gain background bed (spec 03-04: no pump-duck, crossfades out
// under the featured song and back after it).
//
// Deterministic by construction: every gain move is anchored to context-time
// automation the moment its trigger is known — the unduck at a voice clip's
// scheduled end, the bed's return at the song's end-of-stream time — so an
// OfflineAudioContext render of the same calls is the unit-test layer.

import { readFile } from 'node:fs/promises'

import type { AudioClip, BedSource, MixingPlayer, MusicHandle } from './contracts.ts'

// Starting values tuned by ear on the Python engine (spec 03-02 §6 / 03-04 §3.3).
export const FULL_GAIN = 1.0
export const DUCK_TARGET = 0.3
export const RAMP_S = 0.3
export const BED_GAIN = 0.5
export const BED_XFADE_S = 1.5

// Scheduling lead for streamed sources: how far ahead of playback chunks are
// scheduled. Trades memory (~lead seconds of PCM) against stall resilience.
const LEAD_S = 8
// Re-anchor margin after an underrun (a chunk arriving behind playback).
const START_SAFETY_S = 0.05
// Dead-sink margin: play() must never hang forever if the output stops pulling.
const VOICE_TIMEOUT_MARGIN_S = 5

export type Decode = (source: string, signal: AbortSignal) => AsyncIterable<Float32Array>

function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

// Ramp an AudioParam to `target` over `rampS`, starting now — or, with `at` in
// the future, starting at `at` from the explicit `from` value. Cancellation is
// anchored at the ramp's start, so a future-scheduled ramp composes with (does
// not wipe) automation that plays out before it; a ramp starting now wins over
// everything later — later intent always wins.
function ramp(
  param: AudioParam,
  target: number,
  now: number,
  rampS: number,
  at?: number,
  from?: number,
): void {
  const start = at !== undefined && at > now ? at : now
  param.cancelScheduledValues(start)
  param.setValueAtTime(start > now ? (from ?? param.value) : param.value, start)
  param.linearRampToValueAtTime(target, start + rampS)
}

// --- streamed source: chunk-scheduled buffer segments ---------------------- //

type StreamedSource = {
  // First chunk scheduled (true) / stream ended or died with none (false).
  started: Promise<boolean>
  // All chunks scheduled; resolves with the timeline end time (null if none).
  eof: Promise<number | null>
  // No more audio will play: natural end, stop(), or death.
  done: Promise<void>
  stop(): void
  failed(): Error | null
}

function scheduleStream(
  ctx: BaseAudioContext,
  dest: AudioNode,
  chunks: AsyncIterable<Float32Array>,
  { channels = 2, leadS = LEAD_S, startAt = 0 } = {},
): StreamedSource {
  let resolveStarted!: (v: boolean) => void
  let resolveEof!: (v: number | null) => void
  let resolveDone!: () => void
  const started = new Promise<boolean>((r) => (resolveStarted = r))
  const eof = new Promise<number | null>((r) => (resolveEof = r))
  const done = new Promise<void>((r) => (resolveDone = r))
  const live = new Set<AudioBufferSourceNode>()
  let scheduling = true
  let stopped = false
  let nextT: number | null = null
  let error: Error | null = null
  const settle = () => {
    if (!scheduling && live.size === 0) resolveDone()
  }
  const run = async () => {
    try {
      for await (const pcm of chunks) {
        while (!stopped && nextT !== null && nextT - ctx.currentTime > leadS) {
          await sleepUnref(Math.max(10, (nextT - ctx.currentTime - leadS) * 1000))
        }
        if (stopped) break
        const frames = Math.floor(pcm.length / channels)
        if (frames === 0) continue
        const buf = ctx.createBuffer(channels, frames, ctx.sampleRate)
        const plane = new Float32Array(frames)
        for (let c = 0; c < channels; c++) {
          for (let f = 0; f < frames; f++) plane[f] = pcm[f * channels + c]!
          buf.copyToChannel(plane, c)
        }
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(dest)
        const at =
          nextT === null
            ? Math.max(startAt, ctx.currentTime)
            : nextT >= ctx.currentTime
              ? nextT
              : ctx.currentTime + START_SAFETY_S // underrun: a silent gap, re-anchored
        src.start(at)
        nextT = at + frames / ctx.sampleRate
        live.add(src)
        src.onended = () => {
          live.delete(src)
          settle()
        }
        resolveStarted(true)
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
    } finally {
      scheduling = false
      resolveStarted(false)
      resolveEof(nextT)
      settle()
    }
  }
  void run()
  return {
    started,
    eof,
    done,
    failed: () => error,
    stop() {
      stopped = true
      for (const src of live) src.stop()
      live.clear()
      resolveDone()
    },
  }
}

// --- the PCM-mixer duck mechanism (spec 03-02 §2.2 MixedHandle) ------------ //

class MixedHandle implements MusicHandle {
  ducked = false
  // False while born silent under a live bed — gain moves are recorded in
  // `ducked` and applied by the first-frame crossfade (spec 03-04 §3.1).
  audible = false

  private ctx: BaseAudioContext
  readonly gain: GainNode
  private stream: StreamedSource
  private abort: AbortController
  private duckTarget: number
  private rampS: number

  constructor(deps: {
    ctx: BaseAudioContext
    gain: GainNode
    stream: StreamedSource
    abort: AbortController
    duckTarget: number
    rampS: number
  }) {
    this.ctx = deps.ctx
    this.gain = deps.gain
    this.stream = deps.stream
    this.abort = deps.abort
    this.duckTarget = deps.duckTarget
    this.rampS = deps.rampS
  }

  target(): number {
    return this.ducked ? this.duckTarget : FULL_GAIN
  }

  duck(): void {
    this.ducked = true
    if (this.audible) ramp(this.gain.gain, this.duckTarget, this.ctx.currentTime, this.rampS)
  }

  unduck(at?: number): void {
    this.ducked = false
    if (this.audible) {
      // A future unduck starts from the duck plateau it is returning from.
      ramp(this.gain.gain, FULL_GAIN, this.ctx.currentTime, this.rampS, at, this.duckTarget)
    }
  }

  async stop(): Promise<void> {
    this.abort.abort()
    this.stream.stop()
  }

  wait(): Promise<void> {
    return this.stream.done
  }

  async waitStarted(timeoutS: number): Promise<boolean> {
    return (await Promise.race([this.stream.started, sleepUnref(timeoutS * 1000).then(() => false)])) === true
  }
}

// --- the engine ------------------------------------------------------------ //

export type AudioEngineDeps = {
  context: BaseAudioContext
  decode: Decode
  duckTarget?: number
  rampS?: number
  bedGain?: number
  bedXfadeS?: number
  leadS?: number
  log?: (message: string) => void
}

type LiveVoice = { src: AudioBufferSourceNode; end: () => void }

export class AudioEngine implements MixingPlayer {
  private ctx: BaseAudioContext
  private decode: Decode
  private duckTarget: number
  private rampS: number
  private bedGain: number
  private bedXfadeS: number
  private leadS: number
  private log: (message: string) => void

  private closed = false
  private voice: LiveVoice | null = null
  private music: MusicHandle | null = null // whatever duck() dispatches to (§2.2)
  private mixed: MixedHandle | null = null // our own PCM-backed handle

  private bedMaster: GainNode | null = null
  private bedAbort: AbortController | null = null
  private bedStreams = new Set<StreamedSource>()
  private bedTask: Promise<void> | null = null

  constructor(deps: AudioEngineDeps) {
    this.ctx = deps.context
    this.decode = deps.decode
    this.duckTarget = deps.duckTarget ?? DUCK_TARGET
    this.rampS = deps.rampS ?? RAMP_S
    this.bedGain = deps.bedGain ?? BED_GAIN
    this.bedXfadeS = deps.bedXfadeS ?? BED_XFADE_S
    this.leadS = deps.leadS ?? LEAD_S
    this.log = deps.log ?? (() => {})
  }

  // -- Player seam (spec 01): the voice channel ----------------------------- //

  async play(clip: AudioClip): Promise<void> {
    let buf: AudioBuffer
    try {
      const bytes = await readFile(clip.source)
      buf = await this.ctx.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
    } catch (err) {
      // An unreadable clip degrades to a silent segment — a voice fault must
      // never unwind the radio loop (spec-01 Player posture).
      this.log(`voice clip failed to load (${clip.source}): ${String(err)}`)
      return
    }
    // aclose() may have landed while the clip was loading: a closing engine
    // takes no new audio (otherwise this clip would wait out its dead-sink
    // guard with nothing to ever play it).
    if (this.closed) return
    const handle = this.music
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)
    const t0 = this.ctx.currentTime
    handle?.duck()
    src.start(t0)
    // The unduck is scheduled now, at the clip's known end — deterministic, and
    // an early cut (barge-in) leaves it in place: the reply's own duck() takes
    // over within the same arbitration turn.
    handle?.unduck(t0 + buf.duration)
    let ended!: () => void
    const endedP = new Promise<void>((resolve) => (ended = resolve))
    src.onended = () => ended()
    const voice: LiveVoice = { src, end: ended }
    this.voice = voice
    try {
      await Promise.race([endedP, sleepUnref((buf.duration * 2 + VOICE_TIMEOUT_MARGIN_S) * 1000)])
    } finally {
      if (this.voice === voice) this.voice = null
    }
  }

  async stop(): Promise<void> {
    const voice = this.voice
    if (voice === null) return
    this.voice = null
    voice.src.stop()
    voice.end()
  }

  // -- music (spec 03-02 §2.1) ---------------------------------------------- //

  async playMusic(clip: AudioClip): Promise<MusicHandle> {
    const previous = this.mixed ?? this.music
    this.mixed = null
    this.music = null
    if (previous !== null) await previous.stop()

    const gain = this.ctx.createGain()
    gain.connect(this.ctx.destination)
    const abort = new AbortController()
    const stream = scheduleStream(this.ctx, gain, this.decode(clip.source, abort.signal), {
      leadS: this.leadS,
    })
    const handle = new MixedHandle({
      ctx: this.ctx,
      gain,
      stream,
      abort,
      duckTarget: this.duckTarget,
      rampS: this.rampS,
    })
    handle.ducked = this.voice !== null // born ducked under a live voice
    const bedLive = this.bedMaster !== null
    // Under a bed the song is born silent; the crossfade is DEFERRED to the
    // first scheduled frame, so the bed keeps covering stream startup and a
    // dead stream never touches it (spec 03-04 §3.1, the 403 lesson).
    gain.gain.value = bedLive ? 0 : handle.target()
    handle.audible = !bedLive

    void stream.started.then((ok) => {
      if (!ok) return // failure is logged once, from the done path below
      if (this.mixed !== handle) return
      if (this.bedMaster !== null) {
        const now = this.ctx.currentTime
        ramp(this.bedMaster.gain, 0, now, this.bedXfadeS)
        ramp(gain.gain, handle.target(), now, this.bedXfadeS)
      }
      handle.audible = true
    })
    // The bed's return is anchored to the song's end-of-stream time as soon as
    // it is known (~leadS early) — declarative, so it lands exactly at the end.
    void stream.eof.then((endT) => {
      if (endT === null || this.mixed !== handle || this.bedMaster === null) return
      ramp(this.bedMaster.gain, this.bedGain, this.ctx.currentTime, this.bedXfadeS, endT, 0)
    })
    void stream.done.then(() => {
      // One log site for decoder death, whether it died before the first frame
      // or mid-song — an abnormal exit must never read as a clean short track.
      const err = stream.failed()
      if (err !== null) this.log(`music stream failed: ${err.message}`)
      if (this.mixed === handle) this.mixed = null
      if (this.music === handle) this.music = null
      // Covers early stops; harmless after the eof-anchored return (same target).
      if (this.bedMaster !== null) {
        ramp(this.bedMaster.gain, this.bedGain, this.ctx.currentTime, this.bedXfadeS)
      }
    })
    this.mixed = handle
    this.music = handle
    return handle
  }

  // Make an externally-managed music source (a future black-box player's
  // ControlledHandle) the live target for duck dispatch (spec 03-02 §2.2).
  adoptHandle(handle: MusicHandle): void {
    this.music = handle
  }

  // -- background bed (spec 03-04) ------------------------------------------ //

  async startBed(bed: BedSource): Promise<void> {
    if (this.bedMaster !== null) return
    const tracks = bed.tracks()
    if (tracks.length === 0) return // no cache -> no bed, radio still runs
    const master = this.ctx.createGain()
    master.gain.value = 0
    master.connect(this.ctx.destination)
    this.bedMaster = master
    this.bedAbort = new AbortController()
    ramp(master.gain, this.bedGain, this.ctx.currentTime, this.bedXfadeS)
    this.bedTask = this.runBed(tracks, master, this.bedAbort.signal)
  }

  // The bed loop: stream each cached track in turn, crossfading track-to-track
  // (and wrapping the list) so the backdrop never gaps. Scheduling paces itself:
  // eof lands only when playback is within the lead of a track's end.
  private async runBed(tracks: string[], master: GainNode, signal: AbortSignal): Promise<void> {
    let idx = 0
    let misses = 0
    let startAt = 0
    while (!signal.aborted) {
      const source = tracks[idx % tracks.length]!
      idx += 1
      const trackGain = this.ctx.createGain()
      trackGain.connect(master)
      const stream = scheduleStream(this.ctx, trackGain, this.decode(source, signal), {
        leadS: this.leadS,
        startAt,
      })
      this.bedStreams.add(stream)
      void stream.done.then(() => this.bedStreams.delete(stream))
      if (startAt > 0) {
        // fade this track in over the previous one's tail
        trackGain.gain.setValueAtTime(0, startAt)
        trackGain.gain.linearRampToValueAtTime(1, startAt + this.bedXfadeS)
      }
      const endT = await stream.eof
      if (signal.aborted) return
      const err = stream.failed()
      if (err !== null) this.log(`bed track failed (${source}): ${err.message}`)
      if (endT === null) {
        misses += 1
        if (misses >= tracks.length) {
          this.log('bed: every track failed this pass; degrading to no bed')
          return
        }
        continue
      }
      misses = 0
      const xfadeAt = Math.max(endT - this.bedXfadeS, this.ctx.currentTime)
      trackGain.gain.setValueAtTime(1, xfadeAt)
      trackGain.gain.linearRampToValueAtTime(0, endT)
      startAt = xfadeAt
    }
  }

  async stopBed(): Promise<void> {
    const master = this.bedMaster
    if (master === null) return
    this.bedMaster = null
    this.bedAbort?.abort()
    for (const stream of this.bedStreams) stream.stop()
    this.bedStreams.clear()
    ramp(master.gain, 0, this.ctx.currentTime, 0.1)
    await this.bedTask
    this.bedTask = null
  }

  // -- lifecycle ------------------------------------------------------------- //

  async aclose(): Promise<void> {
    this.closed = true
    await this.stop()
    await this.stopBed()
    const music = this.mixed ?? this.music
    this.mixed = null
    this.music = null
    if (music !== null) await music.stop()
    // Close a real device context; an OfflineAudioContext has no close().
    const ctx = this.ctx as Partial<AudioContext>
    if (typeof ctx.close === 'function') await ctx.close()
  }
}
