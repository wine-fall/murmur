// Dev log + memory view for a running murmur (`make logs`).
//
// One window for debugging a `make dev` session: it follows the diagnostics
// logfile the app streams to (`.dev/dev.log` — harness steps, and the failures
// the UI keeps terse, with full stack traces) like `tail -f`, and every few
// seconds injects one line of the murmur process tree's RSS — reusing
// memwatch's sampling so memory and log sit in the same scrollback.
//
//   node scripts/devwatch.ts                       # .dev/dev.log, mem every 2s
//   node scripts/devwatch.ts --log path/to.log
//   node scripts/devwatch.ts --interval 5          # memory line cadence
//   node scripts/devwatch.ts --no-mem              # log tail only
//   node scripts/devwatch.ts --level DEBUG         # unmute the harness firehose
//
// By default only INFO+ shows: the readable talk/synth/music timeline +
// warnings. The DEBUG harness dump is still written to the file — `--level
// DEBUG` reveals it.
//
// Run it in a second terminal after `make dev`. It tolerates the logfile not
// existing yet (waits for it) and being truncated at the next `make dev` start.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { findRoots, formatTick, snapshot, subtree } from './memwatch.ts'

const DEFAULT_LOG = '.dev/dev.log'
const POLL_MS = 500 // how often we check the file for new lines

// Log-line levels, matching the logger's format: "HH:MM:SS LEVEL name: msg".
const LEVELS: Record<string, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 }

// Show only log lines at or above a minimum level. The default INFO view is the
// readable "what happened" timeline (talk/synth/music events + warnings); the
// harness DEBUG firehose is written to the file but hidden here unless --level
// DEBUG. A continuation line (a stack trace under a WARNING, a wrapped dump)
// carries no level token, so it inherits the previous line's decision — a shown
// warning keeps its whole trace, a hidden dump stays fully hidden.
export class LevelFilter {
  readonly #min: number
  #show = true // decision carried onto continuation lines

  constructor(minLevel = 'INFO') {
    this.#min = LEVELS[minLevel.toUpperCase()] ?? LEVELS.INFO!
  }

  show(line: string): boolean {
    // Trim first: an indented continuation line must not have its first word
    // read as the level token that only a real "HH:MM:SS LEVEL ..." line has.
    const level = LEVELS[line.trim().split(/\s+/)[1] ?? '']
    if (level !== undefined) this.#show = level >= this.#min
    return this.#show
  }
}

// Yield lines appended to a file, `tail -f` style. Tolerates the file not
// existing yet (returns nothing until it appears) and truncation/rotation —
// when the file shrinks below our read position (a new `make dev` truncated it)
// we reset to its start so we don't miss the fresh session.
export class LogFollower {
  readonly #path: string
  #pos = 0
  #buf = ''
  #decoder = new StringDecoder('utf8')

  constructor(path: string) {
    this.#path = path
  }

  // Complete lines appended since the last call — a trailing partial line is
  // buffered until its newline arrives, as is a split multi-byte character.
  readNew(): string[] {
    let size: number
    try {
      size = statSync(this.#path).size
    } catch {
      return [] // not created yet
    }
    if (size < this.#pos) {
      // truncated / rotated -> restart from the top
      this.#pos = 0
      this.#buf = ''
      this.#decoder = new StringDecoder('utf8')
    }
    if (size === this.#pos) return []

    const chunk = Buffer.alloc(size - this.#pos)
    const fd = openSync(this.#path, 'r')
    let read: number
    try {
      read = readSync(fd, chunk, 0, chunk.length, this.#pos)
    } finally {
      closeSync(fd)
    }
    this.#pos += read
    this.#buf += this.#decoder.write(chunk.subarray(0, read))

    const lines = this.#buf.split('\n')
    this.#buf = lines.pop() ?? ''
    return lines
  }
}

// One process-tree RSS summary via memwatch, plus the updated peak. The line is
// null when no murmur process is running.
function memoryLine(peakKb: number): { line: string | null; peakKb: number } {
  const procs = snapshot()
  const roots = findRoots(procs)
  if (roots.length === 0) return { line: null, peakKb }
  const members = roots.flatMap((root) => subtree(procs, root.pid))
  const total = members.reduce((sum, p) => sum + p.rssKb, 0)
  return { line: `  • mem  ${formatTick(members, peakKb)}`, peakKb: Math.max(peakKb, total) }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      log: { type: 'string' },
      interval: { type: 'string' }, // memory line cadence, seconds
      'no-mem': { type: 'boolean' }, // log tail only
      level: { type: 'string' }, // min level to show (DEBUG unmutes the harness)
    },
  })
  const logPath = values.log ?? DEFAULT_LOG
  const intervalMs = Number(values.interval ?? 2) * 1000
  const levelFilter = new LevelFilter(values.level ?? 'INFO')
  const follower = new LogFollower(logPath)

  console.log(`watching ${logPath}  (Ctrl-C to stop)`)
  if (!existsSync(logPath)) console.log('(log not created yet — run `make dev` in another terminal)')

  let peakKb = 0
  let lastMem = -Infinity // the first memory line lands immediately
  for (;;) {
    for (const line of follower.readNew()) {
      if (levelFilter.show(line)) console.log(line)
    }
    const now = performance.now()
    if (values['no-mem'] !== true && now - lastMem >= intervalMs) {
      const mem = memoryLine(peakKb)
      peakKb = mem.peakKb
      if (mem.line !== null) console.log(mem.line)
      lastMem = now
    }
    await sleep(POLL_MS)
  }
}

if (import.meta.main) await main()
