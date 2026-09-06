// The attachable bug report (spec 10 §3.5's feedback channel): one string a
// listener can paste into a GitHub issue.
//
// Two halves, deliberately split so the interesting one is testable: `render`
// is pure — every fact (version, platform, what the run actually wired up, the
// probe results, the log tail) is injected by the caller, so the same inputs
// always produce the same report. `readLogTail` is the one function here that
// touches the disk.
//
// The middle section copies the log VERBATIM. It is what a maintainer reads to
// locate a failure, so nothing in it is folded, summarized or restamped.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { DAILY_LOG, type LogEvidence } from './dev-log.ts'

// How much log a report carries. A module constant, not a knob: a listener
// filing a bug should not have to decide how much evidence is enough.
export const LOG_TAIL_LINES = 500

// Which lines the report marks as talk rather than diagnostics — the two names
// devLogMirror writes the program and the listener under (src/host/host.ts).
const CONVERSATION = new Set(['radio', 'user'])

const CONVERSATION_MARK = '> '
const DIAGNOSTIC_MARK = '  '

// --- reading the log ------------------------------------------------------ //

// One day's contribution to the tail, with the line numbers it came from so a
// maintainer can find the same lines in the file itself.
export interface LogSource {
  path: string
  from: number
  to: number
  count: number
}

export interface LogTail {
  // Oldest first, across days.
  lines: string[]
  sources: LogSource[]
}

// The run's own diagnostics, newest `maxLines` of them, oldest first.
//
// Takes the SHAPE the writer chose (src/support/dev-log.ts): the dated daily set, or
// the single file MURMUR_DEV_LOG names. Both are read here rather than at the
// call sites, so the report road and the crash road cannot drift apart about
// where evidence comes from. Missing or unreadable files are skipped rather
// than fatal: a report with a short tail still beats no report.
//
// ponytail: reads a whole file to take its last lines. A day's log is small;
// switch to a reverse chunked read if that ever stops being true.
export function readLogTail(source: LogEvidence, maxLines = LOG_TAIL_LINES): LogTail {
  if (source.kind === 'none') return { lines: [], sources: [] }
  if (source.kind === 'file') return tailOf(source.path, maxLines)
  const dir = source.dir
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => DAILY_LOG.test(name)).sort()
  } catch {
    return { lines: [], sources: [] }
  }
  const picked: { source: LogSource; lines: string[] }[] = []
  let budget = maxLines
  for (let i = names.length - 1; i >= 0 && budget > 0; i--) {
    const path = join(dir, names[i]!)
    let all: string[]
    try {
      all = readFileSync(path, 'utf8').split('\n')
    } catch {
      continue
    }
    if (all.at(-1) === '') all.pop()
    if (all.length === 0) continue
    const take = Math.min(budget, all.length)
    picked.push({
      source: { path, from: all.length - take + 1, to: all.length, count: take },
      lines: all.slice(all.length - take),
    })
    budget -= take
  }
  picked.reverse()
  return {
    lines: picked.flatMap((p) => p.lines),
    sources: picked.map((p) => p.source),
  }
}

// One file's last `maxLines`, in the same shape a day's contribution takes.
function tailOf(path: string, maxLines: number): LogTail {
  let all: string[]
  try {
    all = readFileSync(path, 'utf8').split('\n')
  } catch {
    return { lines: [], sources: [] }
  }
  if (all.at(-1) === '') all.pop()
  if (all.length === 0) return { lines: [], sources: [] }
  const take = Math.min(maxLines, all.length)
  const from = all.length - take + 1
  return {
    lines: all.slice(all.length - take),
    sources: [{ path, from, to: all.length, count: take }],
  }
}

// --- reading a line ------------------------------------------------------- //

export interface LogEvent {
  // The line exactly as it sits in the file — what the report prints.
  raw: string
  time: string
  level: string
  name: string
  message: string
  conversation: boolean
}

// "HH:MM:SS LEVEL name: message", the shape devLogMirror writes. A line that
// does not match (a stack trace, a wrapped write) is kept whole and counted as
// a diagnostic — the report never drops a line it failed to understand.
const MIRRORED = /^(\d{2}:\d{2}:\d{2}) (\w+) ([\w-]+): (.*)$/

// A whole tail, in order. Only this reading knows about continuation lines:
// devLogMirror stamps the FIRST physical line of a message (src/host/host.ts), so a
// multi-line radio segment arrives here as one parsed line followed by bare
// ones. They belong to the event above them — conversation and all, or dropping
// the conversation would leak half a segment.
export function parseLogLines(lines: string[]): LogEvent[] {
  const events: LogEvent[] = []
  for (const line of lines) {
    const event = parseLogLine(line)
    const inherited = event.name === '' ? (events.at(-1)?.conversation ?? false) : event.conversation
    events.push({ ...event, conversation: inherited })
  }
  return events
}

export function parseLogLine(raw: string): LogEvent {
  const match = MIRRORED.exec(raw)
  if (match === null) {
    return { raw, time: '', level: '', name: '', message: raw, conversation: false }
  }
  const name = match[3]!
  return {
    raw,
    time: match[1]!,
    level: match[2]!,
    name,
    message: match[4]!,
    conversation: CONVERSATION.has(name),
  }
}

// --- the report ----------------------------------------------------------- //

// What a run ended up with, beside what it was asked for: a voice that fell
// back to silence or a front-end that fell back to plain is the first thing a
// bug report has to say out loud.
export interface Selection {
  actual: string
  requested: string
}

export interface ProbeReport {
  name: string
  ok: boolean
  reason: string
}

export interface DiagnosticsInput {
  version: string
  platform: string
  brain: Selection
  voice: Selection
  frontEnd: Selection
  probes: ProbeReport[]
  events: LogEvent[]
  sources: LogSource[]
  generatedAt: Date
}

export interface RenderOptions {
  // Conversation lines are the listener's own words. Kept by default (they are
  // usually what the bug is about), droppable for a report the listener wants
  // clean of them.
  includeConversation?: boolean
}

// The known failure signatures — a small table, one entry per shape we have
// actually seen, matched against the probes and the log tail. Not a guess
// engine: an unmatched report says so rather than inventing a diagnosis.
interface Signature {
  note: string
  hit: (input: DiagnosticsInput) => boolean
}

// A clean exit is the front-end quitting with the radio, not a failure.
const FRONT_END_GONE = /front-end (?:failed to start|exited \(code (?!0\)))/
const TTS_REJECTED = /TTS request failed \(4\d\d\)/

function probeFailed(input: DiagnosticsInput, name: string): boolean {
  return input.probes.some((probe) => probe.name === name && !probe.ok)
}

const SIGNATURES: Signature[] = [
  {
    note: 'the terminal front-end is not up — bun is missing, or the client never started or died mid-run; the radio broadcasts on without a face.',
    hit: (input) =>
      probeFailed(input, 'bun') ||
      input.events.some((event) => event.name === 'tui' && FRONT_END_GONE.test(event.message)),
  },
  {
    note: 'ffmpeg is not usable — music and the background bed cannot decode without it.',
    hit: (input) => probeFailed(input, 'ffmpeg'),
  },
  {
    note: 'the voice endpoint refused the request (4xx) — a bad key, a wrong model header, or rate limiting; /setup re-enters the credentials.',
    // Diagnostics only: a listener or the radio quoting the error in a line of
    // talk is not the endpoint failing.
    hit: (input) =>
      input.events.some((event) => !event.conversation && TTS_REJECTED.test(event.message)),
  },
]

function selectionLine(label: string, selection: Selection): string {
  const asked = selection.actual === selection.requested ? '' : ` (requested ${selection.requested})`
  return `${label}: ${selection.actual}${asked}`
}

function logHeader(shown: number, conversation: number, included: boolean): string {
  if (conversation === 0) return `--- log: ${String(shown)} lines ---`
  const note = included
    ? `${String(conversation)} of them conversation (marked "${CONVERSATION_MARK.trim()}")`
    : `${String(conversation)} conversation lines removed`
  return `--- log: ${String(shown)} lines, ${note} ---`
}

export function render(input: DiagnosticsInput, opts: RenderOptions = {}): string {
  const included = opts.includeConversation ?? true
  const out: string[] = [
    'murmur diagnostics',
    `generated ${input.generatedAt.toISOString()}`,
    `version ${input.version}`,
    `platform ${input.platform}`,
    '',
    selectionLine('brain', input.brain),
    selectionLine('voice', input.voice),
    selectionLine('front-end', input.frontEnd),
    '',
  ]

  if (input.probes.length === 0) out.push('probes: none run')
  else {
    out.push('probes:')
    for (const probe of input.probes) {
      out.push(`  ${probe.ok ? 'ok  ' : 'FAIL'} ${probe.name}${probe.ok ? '' : ` — ${probe.reason}`}`)
    }
  }
  out.push('')

  const notes = SIGNATURES.filter((signature) => signature.hit(input)).map((s) => s.note)
  if (notes.length === 0) out.push('signals: none of the known failure signatures matched')
  else {
    out.push('signals:')
    for (const note of notes) out.push(`  ${note}`)
  }
  out.push('')

  const conversation = input.events.filter((event) => event.conversation).length
  const shown = included ? input.events : input.events.filter((event) => !event.conversation)
  out.push(logHeader(shown.length, conversation, included))
  for (const event of shown) {
    out.push(`${event.conversation ? CONVERSATION_MARK : DIAGNOSTIC_MARK}${event.raw}`)
  }
  out.push('--- end of log ---', '')

  if (input.sources.length === 0) out.push('log files: none')
  else {
    out.push('log files:')
    for (const source of input.sources) {
      out.push(
        `  ${source.path} lines ${String(source.from)}-${String(source.to)} (${String(source.count)} lines)`,
      )
    }
    out.push(`total ${String(input.events.length)} lines`)
  }

  return out.join('\n') + '\n'
}
