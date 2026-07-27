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

import { createInterface } from 'node:readline'

export interface Host {
  start(): void
  peekLine(): Promise<string>
  takeLine(): string | undefined
  onRadioSegment(text: string): void
  onUserLine(text: string): void
  info(message: string): void
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

  private input: NodeJS.ReadableStream

  constructor(input: NodeJS.ReadableStream = process.stdin) {
    this.input = input
  }

  start(): void {
    if (this.started) return
    this.started = true
    // On EOF readline just stops emitting lines; the radio plays on.
    createInterface({ input: this.input }).on('line', (line) => this.queue.push(line))
  }

  peekLine(): Promise<string> {
    return this.queue.peek()
  }

  takeLine(): string | undefined {
    return this.queue.take()
  }

  banner(personaFirstLine: string, opts: { brain: string; voice: string }): void {
    console.log('┌─ murmur · ts (issue #54 phase 3) ────────────────────────────')
    console.log(`│ brain: ${opts.brain}   voice: ${opts.voice}`)
    console.log(`│ persona: ${personaFirstLine}`)
    console.log('│ it speaks on its own. Type to talk back; /quit or Ctrl-C to stop.')
    console.log('└──────────────────────────────────────────────────────────────')
  }

  onRadioSegment(text: string): void {
    console.log(`\n🎙  ${text}`)
  }

  onUserLine(text: string): void {
    console.log(`\n⌨   ${text}`)
  }

  info(message: string): void {
    console.log(`·  ${message}`)
  }
}
