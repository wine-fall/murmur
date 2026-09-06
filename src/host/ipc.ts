// The murmur wire protocol (spec 10 §2.3): the single source of truth for what
// the engine and the TUI client say to each other.
//
// ndjson over a unix socket — one JSON object per line, `{ v: 1, type, ... }`.
// Both ends import THIS module and validate at the trust boundary: a message
// that does not parse is dropped (with a dev-log line), never coerced and never
// a crash. Unknown types decode to null too, which is exactly the forward
// compatibility rule — a newer peer's additions are ignored, not fatal.

import { z } from 'zod'

import { ACTIVITIES } from '../director/activity.ts'

// Bumped only by a breaking change; additive message types do not touch it.
export const PROTOCOL = 2

// The slash commands the engine parses from the line stream (spec 10 §3.2-C:
// one grammar, engine-owned). The Director's parser and the front-ends' menu
// both read THIS list, so a new command lands everywhere at once. Order is
// presentation only (the menu's rows, harmless-first — a stray Enter on the
// fresh menu must never quit); the parser binds meanings to its own literals.
export const COMMANDS = [
  { name: '/settings', blurb: 'open the settings pane' },
  { name: '/setup', blurb: 'call the setup guide' },
  { name: '/bug', blurb: 'write up a bug, log attached' },
  { name: '/feature-request', blurb: 'write up something you wish it did' },
  { name: '/update', blurb: 'check npm for a newer murmur' },
  { name: '/quit', blurb: 'end the broadcast' },
] as const

const ENVELOPE = 1

// The engine's view of the program, pushed at segment boundaries and when a
// typed line refreshes presence (spec 10 §2.1). Optional fields absent =
// unknown, not "off".
export const ProgramStateSchema = z.object({
  kind: z.enum(['talk', 'music', 'gap']),
  nowPlaying: z.string().optional(),
  // The playing track's length and the epoch ms it went on air (spec 10 §3.3):
  // together they are a progress bar a front-end can advance on its own clock,
  // with no per-second traffic. `startedAt` rides the state rather than being
  // read off arrival, so a re-emit — or a fresh attach replaying it mid-song —
  // lands on the same origin instead of restarting the bar. `durationS` absent
  // = the source never knew the length (a live stream): no bar, just the title.
  durationS: z.number().optional(),
  startedAt: z.number().optional(),
  scene: z.string().optional(),
  activity: z.enum(ACTIVITIES).optional(),
})

export type ProgramState = z.infer<typeof ProgramStateSchema>

// The listener's knobs (spec 12 §1): exactly these nine, resolved — the live
// values the engine's SettingsStore holds. The schema doubles as the per-key
// validator for the settings FILE (spec 12 §2.1), so the file and the wire can
// never disagree on what a legal value is.
// A language NAME as a person would say it ("Japanese", "Traditional Chinese").
// One line, bounded — enough to keep a runaway model or a mangled file out of
// every system prompt, without pretending a closed list could cover everyone.
// The mix gear (spec 12 §3.5) as INTENT — the vocabulary both ways into the
// settings layer translate from (§2.6). It lives here, shared, so the pane's
// keypress and the reply turn's tool cannot drift into different numbers.
export const MIX_NAMES = ['more music', 'balanced', 'more talk'] as const
export type MixName = (typeof MIX_NAMES)[number]
export const MIX_EVERY_N: Record<MixName, number> = {
  'more music': 1,
  balanced: 2,
  'more talk': 4,
}

export const LANGUAGE_MAX = 40
const LanguageSchema = z.string().trim().min(1).max(LANGUAGE_MAX).regex(/^[^\n\r]+$/)

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
  // Whether the host is offered real-world material at all (spec 13 §2.6).
  rwtEnabled: z.boolean(),
  // The one OPTIONAL knob (spec 12 §3.9). Absent means the listener never said,
  // and the persona decides; set is an override applied as a directive on top
  // of the persona, never an edit to persona.md. Free text — a language name as
  // a person says it — so the bound is a shape, not a vocabulary.
  language: LanguageSchema.optional(),
})

export type Settings = z.infer<typeof SettingsValuesSchema>

// A mutation (spec 12 §2.4): a partial over the same nine knobs.
export const SettingsPatchSchema = z.object({
  anchorsEnabled: z.boolean().optional(),
  musicEnabled: z.boolean().optional(),
  cadenceMode: z.enum(['every_n', 'random', 'brain']).optional(),
  musicEveryN: z.number().int().positive().optional(),
  gapSeconds: z.number().min(0).optional(),
  recentWindow: z.number().int().positive().optional(),
  muted: z.boolean().optional(),
  tuiPet: z.boolean().optional(),
  rwtEnabled: z.boolean().optional(),
  // Empty string is legal HERE and only here: it is how the listener clears the
  // override and hands the language back to the persona (spec 12 §3.9).
  language: z.union([LanguageSchema, z.literal('')]).optional(),
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
    // Who holds the floor right now (§3.4): an attach mid-setup or mid-report
    // opens on that flow's face. Absent = radio (additive).
    mode: z.enum(['radio', 'guide', 'report']).optional(),
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
  // `tone: 'flow'` marks a state-transition line (a stopped flow, the
  // going-off ack) for marked ink client-side. Additive.
  z.object({ v, type: z.literal('info'), text: z.string(), tone: z.enum(['flow']).optional() }),
  // A question pinned beside the input (spec 10 §3.2-B): the guide's consents
  // and the first-run seeds, marked so the front-end can dock them instead of
  // guessing which info line wants an answer. Additive — an older client drops
  // it and keeps the info-line adjacency it already relies on.
  z.object({ v, type: z.literal('ask'), text: z.string(), kind: z.enum(['question', 'consent']) }),
  // Every pending ask just died with its flow (the listener's Esc stopped it):
  // the client drops its cards. Additive, like `ask`.
  z.object({ v, type: z.literal('askDrop') }),
  // Who holds the floor (spec 10 §3.4, the conversation-partner boundary):
  // the client paints the switch — strip, identity line, input. Stateful, not
  // replayed: the host resends the current mode on every attach.
  z.object({ v, type: z.literal('mode'), who: z.enum(['radio', 'guide', 'report']) }),
  // The floor-holder is working rather than waiting on the keyboard (§3.4):
  // the client shows a live sign for as long as it is true, so a model turn
  // that takes seconds is visibly a turn and not a freeze. Stateful like
  // `mode`, and NOT replayed — a backlog handed to a fresh attach must never
  // start it under a busy sign for a turn that has already ended.
  z.object({ v, type: z.literal('busy'), on: z.boolean() }),
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
  // Esc with nothing client-local to close: stop the running engine flow (the
  // setup/guide conversation) without ending the broadcast. An engine with no
  // stoppable flow ignores it.
  z.object({ v, type: z.literal('interrupt') }),
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
