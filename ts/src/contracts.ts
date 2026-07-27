// Outbound interface contracts owned by spec 01 (the core is the consumer).
//
// Redesigned for TS (issue #54 ground rule): plain readonly object types over
// dataclasses, structural interfaces over Protocols, and only the seams the
// TS design needs today. Implementations land per phase:
//   VoiceProvider -> stub here; hosted voice in Phase 2 (spec 02)
//   Player        -> subprocess player here; Web Audio engine in Phase 3 (spec 03-02)
//   MemoryStore   -> in-process here; persistent three-tier in Phase 4 (spec 05)
//   Brain         -> stub + claude-agent-sdk implementations in brain.ts

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

// The compact context handed to the Brain per call (master §6). Spec-01 fields
// only; later phases add scene/profile/coveredTopics.
export type ContextPack = {
  readonly persona: string
  readonly recent: readonly Turn[]
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

export interface MemoryStore {
  record(turn: Turn): void
  recent(n: number): Turn[]
}

// Two-method Brain contract (spec 01 §3.2). Talk generation is batched from
// the start (spec 04 §3.2 shape): one call returns up to `count` beats, and a
// brain that cannot batch returns a single-beat array.
export interface Brain {
  nextTalks(ctx: ContextPack, count: number): Promise<TalkBeat[]>
  respond(userText: string, ctx: ContextPack): Promise<string>
}
