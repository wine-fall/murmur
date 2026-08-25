// Outbound interface contracts owned by spec 01 (the core is the consumer).
//
// Redesigned for TS (issue #54 ground rule): plain readonly object types over
// dataclasses, structural interfaces over Protocols, and only the seams the
// TS design needs today. Implementations land per phase:
//   VoiceProvider -> stub here; hosted voice in Phase 2 (spec 02)
//   Player        -> subprocess player here; Web Audio engine in Phase 3 (spec 03-02)
//   MemoryStore   -> in-process here; persistent three-tier in Phase 4 (spec 05)
//   Brain         -> stub + claude-agent-sdk implementations in brain.ts

import type { CanUseTool, PermissionMode, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'

import type { Activity } from './activity.ts'

export type AudioClip = {
  // Local file path (L0); may become a stream URL once music lands (spec 03-01).
  readonly source: string
  readonly kind: 'talk' | 'music'
}

export type Turn = {
  readonly role: 'radio' | 'user'
  readonly text: string
}

// One self-initiated talk beat from the batched call (spec 04 §3.2). `topic`
// is the optional ledger key for cross-day anti-repeat (spec 05, Phase 4).
export type TalkBeat = {
  readonly text: string
  readonly topic?: string
}

// The compact context handed to the Brain per call (master §6). Beyond the
// spec-01 fields: `scene` is the time-of-day bucket (spec 04 §3.4, ratified by
// spec 05 §2.2); `profile` and `coveredTopics` are the tier-①/③ memory reads
// (spec 05 §3.5 — coveredTopics is cross-day, the issue-#44 anti-repeat).
// `activity` is the spec-07 §2.2 presence signal (the field spec 05 reserved),
// and `cue` the per-call intent the Director asks the prompt to carry (an
// anchor — spec 07 §3.4).
// All optional: absent renders nothing, so spec-01 call sites stay valid.
export type ContextPack = {
  readonly persona: string
  readonly recent: readonly Turn[]
  readonly scene?: string
  readonly profile?: string
  readonly coveredTopics?: readonly string[]
  readonly activity?: Activity
  readonly cue?: string
}

export interface VoiceProvider {
  // Bring the backend to a warm, ready state. Idempotent; called once at startup.
  start(): Promise<void>
  // Render text to a complete AudioClip(kind: 'talk').
  synthesize(text: string): Promise<AudioClip>
  // Release the backend and clean up temp clips.
  close(): Promise<void>
}

// One clip on air at a time; stop() cuts it (the barge-in, spec 01 §3.3).
export interface Player {
  play(clip: AudioClip): Promise<void>
  stop(): Promise<void>
}

// The duck seam (spec 03-02 §2.2): one intent, two prospective mechanisms. The
// engine's MixedHandle drives mixer gain automation; a future ControlledHandle
// would issue volume commands to a black-box player. duck/unduck are sync gain
// intents — `at` (context-time seconds) lets a caller schedule the unduck
// declaratively at a known clip end instead of waiting to fire it.
export interface MusicHandle {
  duck(): void
  unduck(at?: number): void
  stop(): Promise<void>
  // Resolves at natural end or stop — never rejects; a died stream also ends.
  wait(): Promise<void>
  // True once the source has produced real scheduled audio; false on timeout or
  // a stream that dies first (the "announced but silent" guard, spec 03-02).
  waitStarted(timeoutS: number): Promise<boolean>
}

// The mixing engine surface the Director consumes (spec 03-02 §2.1): the spec-01
// Player seam (voice channel; play() auto-ducks live music) plus music playback
// behind a handle.
export interface MixingPlayer extends Player {
  playMusic(clip: AudioClip): Promise<MusicHandle>
}

// Local cached bed tracks, in play order (spec 03-04 §2.2). Empty = no bed.
// Resolving/pulling happened at loading time — never on the audio path.
export interface BedSource {
  tracks(): string[]
}

// Where the bed left off (spec 03-04 resume): the audible track and the offset
// within it, captured at clean shutdown and replayed on the next boot. `track`
// is whatever string the BedSource listed (a path in the engine, a basename in
// the persisted file).
export type BedPosition = { track: string; offsetS: number }

// 'anchor' keys one aired time anchor (spec 07 §2.4), so a restart inside the
// window does not re-fire it. 'setup' keys the onboarding offer's standing
// answer (spec 03-03 §7.1): a recorded decline is what turns later boots with
// the same gaps quiet instead of re-opening the conversation.
export type LedgerKind = 'topic' | 'song' | 'anchor' | 'setup'

// The three-tier store (spec 05 §2.1): the spec-01 turn log (tier ②) plus the
// profile read (tier ①) and the anti-repeat ledger (tier ③). recentTopics /
// recentSongs / recentAnchors span sessions and days on the persistent store
// (issue #44; spec 07 §2.4).
export interface MemoryStore {
  record(turn: Turn): void
  recent(n: number): Turn[]
  profile(): string
  recordEvent(kind: LedgerKind, key: string): void
  recentTopics(n: number): string[]
  recentSongs(n: number): string[]
  recentAnchors(n: number): string[]
}

// A search hit the brain judges (spec 03-01 §2.2): enough signal to reject junk
// (hour-long loops, low-quality re-uploads) and prefer official audio.
export type TrackCandidate = {
  readonly ref: string // opaque provider handle, passed back to resolve()
  readonly title: string
  readonly uploader: string
  readonly durationS: number
  readonly extra: Readonly<Record<string, unknown>> // provider passthrough (viewCount, ...)
}

// The low-level music source (spec 03-01 §2.2). No start/close: the default
// adapter is a binary invoked per call, with nothing to warm or release.
export interface MusicProvider {
  search(query: string, limit?: number): Promise<TrackCandidate[]>
  resolve(ref: string): Promise<AudioClip> // AudioClip(kind: 'music')
}

// One found-and-pulled track (spec 03-01 §2.4, widened by 03-02): the playable
// clip, the display metadata the model read off the candidate, and the one-line
// in-persona DJ intro to speak over its ducked head (absent -> no intro).
export type TrackPick = {
  readonly clip: AudioClip
  readonly title?: string
  readonly artist?: string
  readonly announce?: string
}

// What the Director consumes at a music boundary (spec 03-01 §2.4): find + pull
// one track. MusicProgrammer is the real implementation; tests inject a fake.
export interface TrackSource {
  nextTrack(ctx: MusicContext): Promise<TrackPick | null>
}

// The carrier passed to nextTrack (spec 03-01 §2.4): a stable cacheable prefix
// plus a volatile block. Which signals ride in `situation` grows with later
// specs; adding one touches only the renderer, never the harness.
export type MusicContext = {
  readonly persona: string
  readonly situation: string
}

// --- the brain harness (spec 03-01 §2.1) ---------------------------------- //
//
// In TS the SDK's own `tool()` already carries a tool's name, description, zod
// schema and handler, so there is no murmur-side BrainTool type to declare: a
// task's tool set IS a list of SDK tools. What murmur adds is the termination
// rule — the tools are built around a `finish` callback, and the tool that calls
// it ends the task with a typed value (the Python `terminal` flag + `ok` result
// convention collapses into the closure).
//
// A tool in a task's list, with its schema erased: the argument type differs per
// tool, so the only shape a mixed list can hold is one whose handler args are
// unconstrained (the SDK does the same for its own server config). Each tool's
// arguments are still validated by its own zod schema before its handler runs.
export type TaskTool = Omit<SdkMcpToolDefinition, 'inputSchema' | 'handler'> & {
  inputSchema: unknown
  // oxlint-disable-next-line no-explicit-any
  handler: (args: any, extra: unknown) => ReturnType<SdkMcpToolDefinition['handler']>
}

export type Task<T> = {
  readonly systemPrompt: string // stable, cacheable prefix
  readonly prompt: string // first turn: instruction + volatile context
  readonly model: string // tier per task (music search -> Haiku)
  readonly maxTurns: number // hard bound on the tool-use loop
  readonly tools: (finish: (value: T) => void) => TaskTool[]
}

// The agentic capability, separate from the tool-less Brain so talk-only brains
// (stub / fakes) are not forced to fake a tool-use loop and each consumer
// depends only on what it needs.
export interface Harness {
  // Runs the bounded loop; returns the value a tool finished with, or null if
  // the turn budget ran out first.
  runTask<T>(task: Task<T>): Promise<T | null>
}

// --- the steer task (spec 11 §2.2) ----------------------------------------- //
//
// The Director-owned surface a steer task's tools act through: callbacks closed
// over live program state (current track, pick slot, shutdown arming). Tools
// never import the Director. `music` is absent when music is not wired — which
// is what gates switch_music out of the tool set.
export type SteerMusicActions = {
  playing(): boolean
  switchTrack(hint?: string): void
}

// Two-phase shutdown (spec 11 §2.1): an unarmed end_broadcast call can only arm
// and ask for confirmation; a call while armed closes. The armed flag is
// Director-owned so it survives across steer tasks and disarms when a task
// passes without the call.
export type SteerShutdownActions = {
  armed(): boolean
  arm(): void
  confirm(): void
}

export type SteerActions = {
  readonly music?: SteerMusicActions
  readonly shutdown: SteerShutdownActions
}

// The agentic reply capability (spec 11 §2.2): resolves to the reply text the
// model finished with, or null when it never made the terminal call — the
// caller then falls back to the tool-less Brain.respond.
export interface SteerBrain {
  respond(userText: string, ctx: ContextPack, actions: SteerActions): Promise<string | null>
}

// --- the guide harness (spec 03-03 §2) ------------------------------------ //
//
// A DIFFERENT harness from runTask: the native Claude Code agent with its
// built-in system tools (Bash/Read/...) enabled — interactive setup/repair,
// not a murmur-owned tool loop. Consent is the entry authorization: the
// permission callback allows within it, and the secret guard rides a
// PreToolUse hook (spec 03-03 §3).
export type GuideRequest = {
  readonly systemPrompt: string // behavior-shaping persona (investigate → explain → ask → fix)
  readonly prompt: string // the high-level task; never prescribes the remedy
  readonly model: string
  readonly maxTurns: number
  readonly permissionMode?: PermissionMode // shipped default: 'default'
  readonly canUseTool?: CanUseTool // routes each pre-action ask to the user
  // murmur-owned tools offered ALONGSIDE the SDK built-ins (spec 03-03 §7.2),
  // riding the same `tools` allowlist that bounds the built-in surface.
  readonly tools?: readonly TaskTool[]
  readonly onText?: (text: string) => void // the agent's text, streamed as it arrives
  // Tool activity, surfaced so a long install never runs in silence: the
  // command before it executes, its printed output after. `detail` is the
  // Bash command itself, or compact JSON for any other tool's input. The
  // tool_use id ties a result back to its use, so the consumer can apply a
  // per-use display policy (e.g. withhold a secret-bearing read's output).
  readonly onToolUse?: (name: string, detail: string, toolUseId: string) => void
  readonly onToolResult?: (output: string, isError: boolean, toolUseId: string) => void
  // The user's next natural-language reply after each agent turn; null ends
  // the conversation. Absent = single-shot (one agent turn).
  readonly nextUserInput?: () => Promise<string | null>
  // Resolves when the listener leaves mid-session (a typed /quit, Ctrl-C): the
  // loop stops consuming messages and closes the SDK subprocess instead of
  // waiting out the turn in flight.
  readonly interrupt?: Promise<unknown>
  // Hands the caller a live handle once the session opens. interruptTurn cuts
  // only the turn in flight (the SDK answers with a result and the reply loop
  // continues) — the listener's Esc, as opposed to `interrupt`'s /quit. On a
  // query without interrupt support it resolves as a no-op.
  readonly onSession?: (session: GuideSession) => void
}

export type GuideSession = {
  interruptTurn(): Promise<void>
}

// The setup/repair capability, separate from Harness (find-music has no
// built-in tools) — interface segregation: each consumer depends on the one
// capability it needs. Returns the final plain-language explanation.
export interface GuideCapable {
  runGuide(req: GuideRequest): Promise<string>
}

// One answer to one first-run onboarding question (spec 06 §2.2). The question
// travels with the answer so the fold reads as a conversation, not three loose
// strings.
export type SeedAnswer = { readonly question: string; readonly answer: string }

// The Brain contract (spec 01 §3.2). Talk generation is batched from
// the start (spec 04 §3.2 shape): one call returns up to `count` beats, and a
// brain that cannot batch returns a single-beat array.
export interface Brain {
  nextTalks(ctx: ContextPack, count: number): Promise<TalkBeat[]>
  respond(userText: string, ctx: ContextPack): Promise<string>
  // Fold the transcript's durable facts into the profile text and return the
  // update (spec 05 §2.4). A pure text fold, no tools; the Compactor drives it
  // off the live loop. The stub returns `profile` unchanged (offline no-op).
  compactProfile(profile: string, transcript: readonly Turn[]): Promise<string>
  // Turn the first-run onboarding answers into a persona seed: a complete
  // standalone system prompt for the host, in the listener's own language
  // (spec 06 §2.2). `language` is the machine-detected default, used only where
  // the answers do not settle the question. Tool-less text generation, same
  // posture as compactProfile.
  seedPersona(answers: readonly SeedAnswer[], language: string): Promise<string>
}
