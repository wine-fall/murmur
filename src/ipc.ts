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
export const PROTOCOL = 2

// The slash commands the engine parses from the line stream (spec 10 §3.2-C:
// one grammar, engine-owned). The Director's parser and the front-ends' hints
// both read THIS list, so a new command lands everywhere at once.
export const COMMANDS = ['/quit', '/settings'] as const

const ENVELOPE = 1

// The engine's view of the program, pushed at segment boundaries and when a
// typed line refreshes presence (spec 10 §2.1). Optional fields absent =
// unknown, not "off".
export const ProgramStateSchema = z.object({
  kind: z.enum(['talk', 'music', 'gap']),
  nowPlaying: z.string().optional(),
  scene: z.string().optional(),
  activity: z.enum(ACTIVITIES).optional(),
})

export type ProgramState = z.infer<typeof ProgramStateSchema>

// The listener's knobs (spec 12 §1): exactly these eight, resolved — the live
// values the engine's SettingsStore holds. The schema doubles as the per-key
// validator for the settings FILE (spec 12 §2.1), so the file and the wire can
// never disagree on what a legal value is.
export const SettingsValuesSchema = z.object({
  anchorsEnabled: z.boolean(),
  musicEnabled: z.boolean(),
  cadenceMode: z.enum(['every_n', 'random', 'brain']),
  musicEveryN: z.number().int().positive(),
  gapSeconds: z.number().min(0),
  recentWindow: z.number().int().positive(),
  // The listener's mute (spec 12 §3.4): the engine's master output gain. The
  // program never notices — this is the radio's volume knob, not a provider
  // swap (`--voice stub` remains the dev-surface knob for not synthesizing).
  muted: z.boolean(),
  tuiPet: z.boolean(),
})

export type Settings = z.infer<typeof SettingsValuesSchema>

// A mutation (spec 12 §2.4): a partial over the same eight knobs.
export const SettingsPatchSchema = z.object({
  anchorsEnabled: z.boolean().optional(),
  musicEnabled: z.boolean().optional(),
  cadenceMode: z.enum(['every_n', 'random', 'brain']).optional(),
  musicEveryN: z.number().int().positive().optional(),
  gapSeconds: z.number().min(0).optional(),
  recentWindow: z.number().int().positive().optional(),
  muted: z.boolean().optional(),
  tuiPet: z.boolean().optional(),
})

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

// The read-only facts that ride the settings snapshot (spec 12 §2.5): where
// the home resolved, and whether the voice endpoint / music pipeline exist —
// never the key, never the URL.
export type SettingsSnapshot = {
  values: Settings
  home: string
  voiceConfigured: boolean
  musicAvailable: boolean
}

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
  // A question pinned beside the input (spec 10 §3.2-B): the guide's consents
  // and the first-run seeds, marked so the front-end can dock them instead of
  // guessing which info line wants an answer. Additive — an older client drops
  // it and keeps the info-line adjacency it already relies on.
  z.object({ v, type: z.literal('ask'), text: z.string(), kind: z.enum(['question', 'consent']) }),
  z.object({ v, type: z.literal('viz'), bins: z.array(z.number()) }),
  // The settings snapshot (spec 12 §2.5): sent after `hello` on attach and
  // after every settingsSet — the pane always renders truth, never local
  // optimism. The read-only facts ride along; no key, no URL. `open` marks the
  // one snapshot that answers a typed `/settings`, telling the client to show
  // the pane rather than just refresh it.
  z.object({
    v,
    type: z.literal('settings'),
    values: SettingsValuesSchema,
    home: z.string(),
    voiceConfigured: z.boolean(),
    musicAvailable: z.boolean(),
    open: z.literal(true).optional(),
  }),
  z.object({ v, type: z.literal('bye') }),
])

export type EngineMessage = z.infer<typeof EngineMessageSchema>

// --- tui -> engine --------------------------------------------------------- //

export const TuiMessageSchema = z.discriminatedUnion('type', [
  z.object({ v, type: z.literal('attach'), protocol: z.number().int() }),
  z.object({ v, type: z.literal('line'), text: z.string() }),
  z.object({ v, type: z.literal('vizSub'), on: z.boolean(), fps: z.number().positive().optional() }),
  z.object({ v, type: z.literal('settingsSet'), patch: SettingsPatchSchema }),
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
