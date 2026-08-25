// Fakes for the seams (DESIGN §11.1): the unit layer drives the Director and
// friends with these — no network, LLM, audio, or real stdin.

import { setTimeout as sleep } from 'node:timers/promises'

import type {
  AudioClip,
  Brain,
  ContextPack,
  Harness,
  MixingPlayer,
  MusicContext,
  MusicHandle,
  MusicProvider,
  Player,
  SeedAnswer,
  TalkBeat,
  Task,
  TaskTool,
  TrackCandidate,
  TrackPick,
  TrackSource,
  Turn,
} from '../src/contracts.ts'
import type { DirectorSettings } from '../src/director.ts'
import type { AskKind, Host } from '../src/host.ts'
import type { ProgramState } from '../src/ipc.ts'
import { LineQueue } from '../src/host.ts'

// The Director's live-settings thunk (spec 12 §3.2), test defaults. Mutate the
// returned object to exercise hot application.
export function directorSettings(over: Partial<DirectorSettings> = {}): DirectorSettings {
  return { gapSeconds: 0, recentWindow: 12, anchorsEnabled: true, musicEnabled: true, ...over }
}

// Stands in for the model driving an agentic task: `play` is handed the task's
// tools and calls them the way the model would. Whatever a tool passes to
// `finish` is what runTask returns — so the termination rule is exercised for
// real, with no SDK or network.
export class FakeHarness implements Harness {
  lastTask: Task<unknown> | null = null
  calls = 0

  private play: (tools: TaskTool[]) => Promise<void>

  constructor(play: (tools: TaskTool[]) => Promise<void> = async () => {}) {
    this.play = play
  }

  async runTask<T>(task: Task<T>): Promise<T | null> {
    this.calls++
    this.lastTask = task as Task<unknown>
    let captured: T | null = null
    await this.play(task.tools((value) => (captured = value)))
    return captured
  }
}

// Call one of a task's tools by name, as the model would.
export async function callTool(
  tools: TaskTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`no such tool: ${name}`)
  const result = await tool.handler(args, {})
  const first = result.content[0]
  if (first === undefined || first.type !== 'text') throw new Error('tool returned no text')
  return JSON.parse(first.text) as Record<string, unknown>
}

export class FakeMusicProvider implements MusicProvider {
  candidates: TrackCandidate[] = []
  searches: { query: string; limit: number | undefined }[] = []
  // refs that fail to resolve (a dead link the model must pick away from)
  broken = new Set<string>()

  async search(query: string, limit?: number): Promise<TrackCandidate[]> {
    this.searches.push({ query, limit })
    return this.candidates
  }

  async resolve(ref: string): Promise<AudioClip> {
    if (this.broken.has(ref)) throw new Error(`cannot resolve ${ref}`)
    return { source: `https://stream/${ref}`, kind: 'music' }
  }
}

export class FakeBrain implements Brain {
  // Each nextTalks call shifts one batch; empty list -> throws (failure mode).
  // A string entry is a bare beat; a TalkBeat entry can carry a topic tag.
  batches: (string | TalkBeat)[][] = []
  nextTalksCalls = 0
  talkContexts: ContextPack[] = []
  // Scripted transient failures / latency for the look-ahead retry + refill-
  // during-music tests (spec 04 §3.3).
  nextTalksFailTimes = 0
  nextTalksDelayMs = 0
  respondCalls: string[] = []
  respondContexts: ContextPack[] = []
  respondDelayMs = 0
  failRespond = false
  seedAnswers: (readonly SeedAnswer[])[] = []

  async nextTalks(ctx: ContextPack, _count: number): Promise<TalkBeat[]> {
    this.nextTalksCalls++
    this.talkContexts.push(ctx)
    if (this.nextTalksFailTimes > 0) {
      this.nextTalksFailTimes--
      throw new Error('brain down')
    }
    if (this.nextTalksDelayMs > 0) await sleep(this.nextTalksDelayMs)
    const batch = this.batches.shift()
    if (batch === undefined) throw new Error('no more batches')
    return batch.map((beat) => (typeof beat === 'string' ? { text: beat } : beat))
  }

  async respond(userText: string, ctx: ContextPack): Promise<string> {
    if (this.respondDelayMs > 0) await sleep(this.respondDelayMs)
    this.respondCalls.push(userText)
    this.respondContexts.push(ctx)
    if (this.failRespond) throw new Error('brain down')
    return `re:${userText}`
  }

  async compactProfile(profile: string, transcript: readonly Turn[]): Promise<string> {
    return `${profile}+${transcript.length}`
  }

  async seedPersona(answers: readonly SeedAnswer[], language: string): Promise<string> {
    this.seedAnswers.push(answers)
    return `persona from ${answers.length} answers in ${language}`
  }
}

export class FakeVoice {
  synthesized: string[] = []
  failTimes = 0
  failWith = 'synth down'

  async start(): Promise<void> {}

  async synthesize(text: string): Promise<AudioClip> {
    if (this.failTimes > 0) {
      this.failTimes--
      throw new Error(this.failWith)
    }
    this.synthesized.push(text)
    return { source: `/fake/${this.synthesized.length}.wav`, kind: 'talk' }
  }

  async close(): Promise<void> {}
}

export class FakePlayer implements Player {
  played: AudioClip[] = []
  stops = 0
  // auto: play resolves immediately. Manual: resolves on finish()/stop().
  auto = true
  private release: (() => void) | null = null

  play(clip: AudioClip): Promise<void> {
    this.played.push(clip)
    if (this.auto) return Promise.resolve()
    return new Promise((resolve) => (this.release = resolve))
  }

  async stop(): Promise<void> {
    this.stops++
    this.finish()
  }

  finish(): void {
    this.release?.()
    this.release = null
  }

  get playing(): boolean {
    return this.release !== null
  }
}

export class FakeMusicHandle implements MusicHandle {
  ducks = 0
  unducks = 0
  stopped = false
  endedNaturally = false
  // Scripted: does the stream produce real audio? (false = the dead-403 case)
  startedOk = true

  private ended: Promise<void>
  private release!: () => void

  constructor(startedOk = true) {
    this.startedOk = startedOk
    this.ended = new Promise((resolve) => (this.release = resolve))
  }

  // Test control: the song reaches its natural end.
  end(): void {
    this.endedNaturally = true
    this.release()
  }

  duck(): void {
    this.ducks++
  }

  unduck(): void {
    this.unducks++
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.release()
  }

  wait(): Promise<void> {
    return this.ended
  }

  // Scripted spin-up latency, for the command-short-circuit tests: a stream
  // that takes real seconds to confirm audio.
  startDelayMs = 0

  async waitStarted(_timeoutS: number): Promise<boolean> {
    if (this.startDelayMs > 0) await sleep(this.startDelayMs)
    return this.startedOk
  }
}

export class FakeMixingPlayer extends FakePlayer implements MixingPlayer {
  music: AudioClip[] = []
  handles: FakeMusicHandle[] = []
  // Scripted handles for upcoming playMusic calls; default = started-ok handle.
  nextHandles: FakeMusicHandle[] = []

  async playMusic(clip: AudioClip): Promise<MusicHandle> {
    this.music.push(clip)
    // Mirrors the engine's single-music invariant (engine.ts playMusic): a new
    // track cuts whatever music is still live.
    const previous = this.handles.at(-1)
    if (previous !== undefined && !previous.stopped && !previous.endedNaturally) {
      await previous.stop()
    }
    const handle = this.nextHandles.shift() ?? new FakeMusicHandle()
    this.handles.push(handle)
    return handle
  }
}

export class FakeTrackSource implements TrackSource {
  picks: (TrackPick | null)[] = []
  contexts: MusicContext[] = []
  delayMs = 0
  calls = 0

  async nextTrack(ctx: MusicContext): Promise<TrackPick | null> {
    this.calls++
    this.contexts.push(ctx)
    if (this.delayMs > 0) await sleep(this.delayMs)
    return this.picks.shift() ?? null
  }
}

export function pickOf(source: string, extras: Partial<TrackPick> = {}): TrackPick {
  return { clip: { source, kind: 'music' }, ...extras }
}

export class FakeHost implements Host {
  private queue = new LineQueue()
  private markEof!: () => void
  private eofSeen: Promise<void> = new Promise((resolve) => (this.markEof = resolve))
  radio: string[] = []
  user: string[] = []
  infos: string[] = []
  asks: { text: string; kind: AskKind }[] = []
  debugs: string[] = []
  states: ProgramState[] = []
  banners: { personaFirstLine: string; brain: string; voice: string }[] = []
  // Assign in a test to model a front-end with a settings pane (spec 12 §3.6);
  // left undefined, the host is the plain one and the Director degrades to info.
  showSettings?: () => void

  start(): void {}

  type(line: string): void {
    this.queue.push(line)
  }

  // Close stdin (the non-interactive run): consuming readers resolve '' rather
  // than pending forever.
  endInput(): void {
    this.markEof()
  }

  eof(): Promise<void> {
    return this.eofSeen
  }

  peekLine(): Promise<string> {
    return this.queue.peek()
  }

  takeLine(): string | undefined {
    return this.queue.take()
  }

  onRadioSegment(text: string): void {
    this.radio.push(text)
  }

  onUserLine(text: string): void {
    this.user.push(text)
  }

  info(message: string): void {
    this.infos.push(message)
  }

  ask(text: string, kind: AskKind): void {
    this.asks.push({ text, kind })
  }

  debug(message: string): void {
    this.debugs.push(message)
  }

  onState(state: ProgramState): void {
    this.states.push(state)
  }

  banner(personaFirstLine: string, opts: { brain: string; voice: string }): void {
    this.banners.push({ personaFirstLine, ...opts })
  }
}

// Poll until `cond` is true (or fail after ~1s) — keeps timing-based director
// tests robust without fixed sleeps.
export async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}
