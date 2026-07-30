// The murmur wire protocol (spec 10 §2.3): the single source of truth for what
// the engine and the TUI client say to each other.
//
// ndjson over a unix socket — one JSON object per line, `{ v: 1, type, ... }`.
// Both ends import THIS module and validate at the trust boundary: a message
// that does not parse is dropped (with a dev-log line), never coerced and never
// a crash. Unknown types decode to null too, which is exactly the forward
// compatibility rule — a newer peer's additions are ignored, not fatal.

import { z } from 'zod'

import { ACTIVITIES } from './activity.ts'

// Bumped only by a breaking change; additive message types do not touch it.
export const PROTOCOL = 1

const ENVELOPE = 1

// The engine's view of the program, pushed at segment boundaries and on invite
// transitions (spec 10 §2.1). Optional fields absent = unknown, not "off".
export const ProgramStateSchema = z.object({
  kind: z.enum(['talk', 'music', 'gap']),
  nowPlaying: z.string().optional(),
  awaitingReply: z.boolean(),
  scene: z.string().optional(),
  activity: z.enum(ACTIVITIES).optional(),
})

export type ProgramState = z.infer<typeof ProgramStateSchema>

const v = z.literal(ENVELOPE)

// --- engine -> tui --------------------------------------------------------- //

export const EngineMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v,
    type: z.literal('hello'),
    protocol: z.number().int(),
    persona: z.string(),
    brain: z.string(),
    voice: z.string(),
    // Seconds since murmur last heard anything, so the pet can acknowledge the
    // absence (spec 10 §3.7.3). Absent = no history to go on (a first run).
    away: z.number().optional(),
  }),
  z.object({ v, type: z.literal('segment'), text: z.string() }),
  z.object({ v, type: z.literal('userLine'), text: z.string() }),
  // `microcopy` is the DJ's line for the status strip (§3.7.4), picked from the
  // authored pool in prompts.ts. Beside the state rather than inside it: it is
  // what the program SAYS it is doing, not part of what it is doing.
  z.object({
    v,
    type: z.literal('state'),
    state: ProgramStateSchema,
    microcopy: z.string().optional(),
  }),
  z.object({ v, type: z.literal('info'), text: z.string() }),
  z.object({ v, type: z.literal('viz'), bins: z.array(z.number()) }),
  z.object({ v, type: z.literal('bye') }),
])

export type EngineMessage = z.infer<typeof EngineMessageSchema>

// --- tui -> engine --------------------------------------------------------- //

export const TuiMessageSchema = z.discriminatedUnion('type', [
  z.object({ v, type: z.literal('attach'), protocol: z.number().int() }),
  z.object({ v, type: z.literal('line'), text: z.string() }),
  z.object({ v, type: z.literal('vizSub'), on: z.boolean(), fps: z.number().positive().optional() }),
])

export type TuiMessage = z.infer<typeof TuiMessageSchema>

// --- framing --------------------------------------------------------------- //

export function encode(message: EngineMessage | TuiMessage): string {
  return `${JSON.stringify(message)}\n`
}

function decode<T>(schema: z.ZodType<T>, line: string): T | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function decodeEngineMessage(line: string): EngineMessage | null {
  return decode(EngineMessageSchema, line)
}

export function decodeTuiMessage(line: string): TuiMessage | null {
  return decode(TuiMessageSchema, line)
}

// A socket delivers bytes, not messages. Reassemble ndjson lines across chunks,
// bounded: a peer that never sends a newline gets its runaway line dropped
// rather than growing our heap (the buffer resyncs at the next newline).
const MAX_LINE_BYTES = 1 << 20

export function ndjson(
  onLine: (line: string) => void,
  opts: { maxLineBytes?: number } = {},
): (chunk: string) => void {
  const max = opts.maxLineBytes ?? MAX_LINE_BYTES
  let buffer = ''
  let overflowed = false
  return (chunk: string) => {
    buffer += chunk
    let cut = buffer.indexOf('\n')
    while (cut !== -1) {
      const line = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      if (overflowed) overflowed = false
      else if (line !== '') onLine(line)
      cut = buffer.indexOf('\n')
    }
    if (buffer.length > max) {
      buffer = ''
      overflowed = true
    }
  }
}
