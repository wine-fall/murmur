// CLI Host (spec 01 §3.1): render program text and own keyboard input.
//
// Input is a peek/take queue rather than a consuming promise: the Director
// races "next typed line" against on-air audio, and a race the audio wins must
// NOT swallow the pending line. peekLine() resolves when a line is available
// without consuming it; the winner of the race calls takeLine() explicitly.
//
// EOF on stdin means "no more input will come" — NOT quit. The radio keeps
// broadcasting whether or not anyone types; only /quit or Ctrl-C stops it
// (spec 01 §3.6).

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { packageVersion } from './config.ts'
import type { ProgramState } from './ipc.ts'

export interface Host {
  start(): void
  peekLine(): Promise<string>
  takeLine(): string | undefined
  // Resolves once stdin has ended (no more input will EVER come). The Director
  // ignores it (the radio plays on); the guide races its consuming reads
  // against it so a non-interactive run declines instead of blocking forever.
  eof?(): Promise<void>
  onRadioSegment(text: string): void
  onUserLine(text: string): void
  // `tone` marks the rare state-transition line the listener must not miss
  // (a stopped flow, the going-off ack): a front-end with color renders it in
  // marked ink; the plain host prints it like any other line.
  info(message: string, tone?: InfoTone): void
  // A question that wants the user's next line (spec 10 §3.2-B): the guide's
  // consents, the first-run seeds, the free-reply prompt. A front-end with a
  // question surface pins it beside the input; absent, callers fall back to
  // info (the plain host's recency-adjacency). Route through ask() below.
  ask?(text: string, kind: AskKind): void
  // The listener's way out of a running flow without leaving (spec 03-03 §7 +
  // spec 10 §3.4): Esc in the TUI. A flow that can be stopped registers its
  // handler for its own duration (null to unregister); a host without the
  // seam — or an engine with no flow registered — treats Esc as noise.
  onInterrupt?(handler: (() => void) | null): void
  // Who holds the floor (spec 10 §3.4, the conversation-partner boundary):
  // the radio, or a foreground agent session (the setup guide). A front-end
  // with a face paints the switch; the plain host reads fine without one —
  // its transcript is serial anyway.
  setMode?(who: FloorMode): void
  // Dev-log-only diagnostics (spec 04 §3.3 look-ahead stages): never printed
  // over the program. Optional so bare hosts stay valid.
  debug?(message: string): void
  // What the program is doing right now (spec 10 §2.1): pushed at segment
  // boundaries and presence refreshes, never polled. Optional, like debug — a
  // host with no status region has nothing to do with it.
  onState?(state: ProgramState): void
  // A typed /settings wants the pane (spec 12 §3.6). Optional: a host without
  // one leaves it undefined and the Director points at the file instead.
  showSettings?(): void
  // `away` is seconds since murmur last heard anything (spec 10 §3.7.3), for a
  // front-end that greets the absence. Absent = no history to go on.
  banner(personaFirstLine: string, opts: { brain: string; voice: string; away?: number }): void
}

// 'consent' wants a y/N; 'question' wants a free line. The distinction is
// presentational (the dock's title), not semantic — the reader treats both as
// one line either way.
export type AskKind = 'question' | 'consent'

// At most one foreground agent session at a time (the boundary rule): 'guide'
// while the setup guide holds the floor, 'radio' otherwise.
export type FloorMode = 'radio' | 'guide'

export type InfoTone = 'flow'

// Every question the engine asks goes through here: hosts with a question
// surface get the marked ask, bare ones get the same text as info.
export function ask(host: Host, text: string, kind: AskKind): void {
  if (host.ask !== undefined) host.ask(text, kind)
  else host.info(text)
}

// Mirror a program line into the dev log (`make logs` tails it in a second
// terminal) in the "HH:MM:SS LEVEL name: msg" shape devwatch parses.
// Best-effort: a dev-log write failure must never take the radio down.
export function devLogMirror(devLog: string | undefined): (name: string, message: string) => void {
  if (devLog === undefined || devLog === '') return () => {}
  return (name, message) => {
    const stamp = new Date().toTimeString().slice(0, 8)
    try {
      appendFileSync(devLog, `${stamp} INFO ${name}: ${message}\n`)
    } catch {
      // e.g. the .dev dir vanished mid-run
    }
  }
}

export class LineQueue {
  private lines: string[] = []
  // The single shared wait-for-a-line promise. Memoized so that every race
  // loser holds the SAME pending promise — an always-on idle run must not
  // accumulate one abandoned waiter per segment/gap race (peek offers no
  // cancellation, so unbounded per-caller waiters would leak).
  private waiting: { promise: Promise<string>; resolve: (line: string) => void } | null = null

  push(line: string): void {
    this.lines.push(line)
    this.waiting?.resolve(this.lines[0]!)
    this.waiting = null
  }

  peek(): Promise<string> {
    if (this.lines.length > 0) return Promise.resolve(this.lines[0]!)
    if (this.waiting === null) {
      let resolve!: (line: string) => void
      const promise = new Promise<string>((r) => (resolve = r))
      this.waiting = { promise, resolve }
    }
    return this.waiting.promise
  }

  take(): string | undefined {
    return this.lines.shift()
  }
}

export class CliHost implements Host {
  private queue = new LineQueue()
  private started = false
  private markEof!: () => void
  private eofSeen: Promise<void>

  private input: NodeJS.ReadableStream
  private mirror: (name: string, message: string) => void

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    opts: { devLog?: string | undefined } = {},
  ) {
    this.input = input
    this.mirror = devLogMirror(opts.devLog)
    this.eofSeen = new Promise((resolve) => (this.markEof = resolve))
  }

  start(): void {
    if (this.started) return
    this.started = true
    // On EOF readline just stops emitting lines; the radio plays on.
    createInterface({ input: this.input })
      .on('line', (line) => this.queue.push(line))
      .on('close', () => this.markEof())
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

  banner(personaFirstLine: string, opts: { brain: string; voice: string }): void {
    console.log('┌─ murmur ─────────────────────────────────────────────────────')
    console.log(`│ brain: ${opts.brain}   voice: ${opts.voice}   v${packageVersion()}`)
    console.log(`│ persona: ${personaFirstLine}`)
    console.log('│ it speaks on its own. Type to talk back; /quit or Ctrl-C to stop.')
    console.log('│ something broken or missing? /bug or /feature-request opens the form.')
    console.log('└──────────────────────────────────────────────────────────────')
  }

  onRadioSegment(text: string): void {
    console.log(`\n🎙  ${text}`)
    this.mirror('radio', text)
  }

  onUserLine(text: string): void {
    console.log(`\n⌨   ${text}`)
    this.mirror('user', text)
  }

  // The plain host has one ink: a toned line prints like any other.
  info(message: string): void {
    console.log(`·  ${message}`)
    this.mirror('host', message)
  }

  debug(message: string): void {
    this.mirror('director', message)
  }
}
