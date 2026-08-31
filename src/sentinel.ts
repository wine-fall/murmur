// The crash sentinel (spec 10 §3.2-C): how murmur notices, on the NEXT boot,
// that the last one never said goodbye. Most bugs go unreported not because
// filing one is hard but because nobody thinks to — so the radio remembers on
// the listener's behalf.
//
// One file per live instance, not one shared flag. Two radios can be on the air
// at once, and a single flag makes them lie to each other: one instance's clean
// exit clears the record of the other's crash, and a second boot reads the
// first's live flag as a crash that never happened. A sentinel names the pid
// that wrote it, so a boot can tell "still running" (another radio) from "gone"
// (last run died) by asking the OS.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { LOG_TAIL_LINES, parseLogLine, type LogTail } from './diagnostics.ts'
import { isYes, type QuitLatch } from './guide.ts'
import { ask, type Host } from './host.ts'
import type { ReportSession } from './report.ts'

// Only murmur's own sentinels; run/ also holds the front-end socket.
const SENTINEL = /^session-\d+\.json$/

// File content is a trust boundary — narrowed here, at the read.
const SentinelSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
})

export type CrashedSession = z.infer<typeof SentinelSchema>

// Arm this run. The returned disarm is idempotent and synchronous, so an exit
// handler can call it, and best-effort throughout: a sentinel that cannot be
// written or removed costs a spurious notice at worst, never the broadcast.
export function armSentinel(dir: string, pid = process.pid, now = new Date()): () => void {
  const path = join(dir, `session-${String(pid)}.json`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify({ pid, startedAt: now.toISOString() }))
  } catch {
    // an unwritable home costs the reminder, not the radio
  }
  return () => {
    try {
      rmSync(path, { force: true })
    } catch {
      // nothing left to do about it at exit time
    }
  }
}

// Probe a pid without signalling it. Anything but "the OS has never heard of
// this process" counts as alive: another user's process answers EPERM, and
// calling that dead would report a crash that never happened.
export function pidAlive(pid: number, probe: (pid: number) => void = signalZero): boolean {
  // 0 and negatives address the caller's own process group, never one process:
  // unprobeable, so treat them as alive and leave the sentinel be.
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    probe(pid)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function signalZero(pid: number): void {
  process.kill(pid, 0)
}

// Every sentinel whose process is gone — the runs that ended without saying
// goodbye — oldest first. Reporting and clearing are one act on purpose: a
// sentinel survives exactly until it has been reported, so the same crash is
// never mentioned twice. A live pid is another radio and is left untouched;
// unreadable junk is swept without claiming a crash it cannot prove.
//
// Call this BEFORE arming this run: the OS reuses pids, and a fresh sentinel
// written over a stale one of the same number would swallow its record.
export function collectCrashed(
  dir: string,
  alive: (pid: number) => boolean = pidAlive,
  self = process.pid,
): CrashedSession[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => SENTINEL.test(name))
  } catch {
    return []
  }
  const crashed: CrashedSession[] = []
  for (const name of names) {
    const path = join(dir, name)
    const record = readSentinel(path)
    // Our OWN pid on a sentinel we have not written yet means the OS handed us
    // the number of the run that died holding it — stale, however alive the
    // probe says the pid is. Any other live pid is a neighbour: hands off.
    if (record !== null && record.pid !== self && alive(record.pid)) continue
    // Claim it by rename before reporting: two radios booting at once would
    // otherwise both read it and both announce the same crash. Exactly one wins
    // the rename; the loser gets ENOENT and moves on.
    const claim = `${path}.claimed-${String(self)}`
    try {
      renameSync(path, claim)
    } catch {
      continue
    }
    try {
      rmSync(claim, { force: true })
    } catch {
      // a claim we could not clear is junk, never a second report
    }
    if (record !== null) crashed.push(record)
  }
  return crashed.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

function readSentinel(path: string): CrashedSession | null {
  try {
    const parsed = SentinelSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// What the radio says about it — one line, however many runs were lost. The
// asking (report it? not now?) waits on the report flow; this piece only makes
// murmur notice out loud.
export function uncleanExitNotice(crashed: CrashedSession[]): string | null {
  if (crashed.length === 0) return null
  if (crashed.length === 1) return 'last time I went off the air without saying goodbye.'
  return `my last ${String(crashed.length)} times on the air ended without a goodbye.`
}

// --- what the crashed run left in the log --------------------------------- //
//
// A crash report is murmur's own account, not the listener's: they were asleep,
// or in another window, and by the next boot they have no memory of the run
// that died. So the description below is written from what the sentinel and the
// log can actually show, and the evidence is THAT RUN's window — the tail of
// the log would be this boot's first few lines, which say nothing about it.

// A run that spans midnight keeps writing to the day it started (src/dev-log.ts),
// so a run's whole window lives in one dated file.
function dayStamp(at: Date): string {
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

function clock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// The lines the dead run wrote, from its own start up to the boot that found
// it. `until` is required and carries no default: the window has to be the
// caller's decided "now", not a fresh clock read inside a pure lookup.
//
// ponytail: an intervening run that exited cleanly leaves no sentinel and no
// marker, so its lines fall inside this window too. Bounded, honest about
// itself in the description, and the alternative is a boot marker in the log
// format — worth it only if a report ever comes back muddled.
export function readCrashWindow(
  logDir: string,
  session: CrashedSession,
  until: Date,
  maxLines = LOG_TAIL_LINES,
): LogTail {
  const start = new Date(session.startedAt)
  const path = join(logDir, `murmur-${dayStamp(start)}.log`)
  let all: string[]
  try {
    all = readFileSync(path, 'utf8').split('\n')
  } catch {
    return { lines: [], sources: [] }
  }
  if (all.at(-1) === '') all.pop()
  const from = clock(start)
  // An upper bound only when this boot is the same day: on a later day the
  // dead run's file ends where the day did.
  const to = dayStamp(until) === dayStamp(start) ? clock(until) : null

  let begin = -1
  let end = all.length
  // Continuation lines carry no stamp of their own; they belong to the message
  // above them, so the last stamp seen is what places them.
  let at = ''
  for (let i = 0; i < all.length; i++) {
    const stamped = parseLogLine(all[i]!).time
    if (stamped !== '') at = stamped
    if (begin === -1) {
      if (at !== '' && at >= from) begin = i
      continue
    }
    if (to !== null && i > begin && at >= to) {
      end = i
      break
    }
  }
  if (begin === -1) return { lines: [], sources: [] }

  // Too long to carry: keep the END, the lines nearest the failure.
  const window = all.slice(begin, end)
  const kept = window.length > maxLines ? window.slice(window.length - maxLines) : window
  const first = begin + (window.length - kept.length) + 1
  return {
    lines: kept,
    sources: [{ path, from: first, to: first + kept.length - 1, count: kept.length }],
  }
}

// The description murmur writes for a report the listener did not start.
// Deliberately narrow: a sentinel proves the run took none of its own exits,
// and nothing more. Why it ended is not visible from here, so this does not
// guess — the listener edits the draft if they remember more.
export function crashDescription(session: CrashedSession, window: LogTail): string {
  const started = new Date(session.startedAt)
  const parts = [
    'murmur did not end its last run itself.',
    '',
    `That run started at ${dayStamp(started)} ${clock(started)} (pid ${String(session.pid)}) and left its sentinel file behind. ` +
      'A run removes that file on every exit it chooses — /quit, Ctrl-C, or a bounded run reaching its end — ' +
      'so this one ended some other way. What that way was, murmur cannot see from here.',
  ]
  const last = window.lines.at(-1)
  if (last === undefined) {
    parts.push('', 'There is nothing from that run in the log: it died before it wrote a line.')
  } else {
    parts.push(
      '',
      `The diagnostics below are that run's own window — ${String(window.lines.length)} line${window.lines.length === 1 ? '' : 's'}, not this boot's. The last thing it wrote was:`,
      '',
      `    ${last}`,
    )
  }
  parts.push('', 'Written by murmur on the next boot, not by the listener — edit it if you remember more.')
  return parts.join('\n')
}

// --- the offer ------------------------------------------------------------ //

export interface CrashOffer {
  host: Host
  crashed: CrashedSession[]
  // The consent read. Injected because only the caller knows what else is
  // reading the keyboard in this stretch of the boot.
  read: () => Promise<string>
  // The listener leaving. Both an input and an output here: it ends a draft
  // that has nobody left to answer it, and a `/quit` typed INTO the draft
  // fires it, so leaving still works from inside the flow.
  quit: QuitLatch
  // Opens the report. Required and defaulted to nothing: a test must never be
  // able to reach a real draft, an editor or a browser through here.
  startSession: () => ReportSession
}

const OFFER = 'want me to write that up as a bug report? [y/N]'

// Notice the lost run out loud, then ask. A no is answered once and dropped —
// the sentinel was already cleared when it was collected, so this run is never
// raised again either way (the report-once contract).
export async function offerCrashReport(offer: CrashOffer): Promise<void> {
  const notice = uncleanExitNotice(offer.crashed)
  if (notice === null) return
  const { host } = offer
  host.info(notice)
  ask(host, OFFER, 'consent')
  if (!isYes(await offer.read())) {
    host.info('alright — back to the program.')
    return
  }
  const session = offer.startSession()
  // The report owns the keyboard now. Peek to WAIT and take only what is
  // actually delivered: a race lost on a consuming read would swallow the line
  // it was racing for.
  //
  // Three ways out besides the draft finishing, all of them ending it rather
  // than leaving the boot waiting on a prompt nobody will answer: a typed
  // /quit (which the draft's own menu would otherwise read as a typo), the
  // quit latch fired from elsewhere, and EOF — a closed stdin or a front-end
  // that detached means no line is ever coming.
  const gone = host.eof?.() ?? new Promise<void>(() => {})
  let ended = false
  for (;;) {
    const winner = await Promise.race([
      host.peekLine().then(() => 'line' as const),
      session.done.then(() => 'done' as const),
      offer.quit.seen.then(() => 'quit' as const),
      gone.then(() => 'gone' as const),
    ])
    if (winner === 'done') break
    if (winner !== 'line') {
      ended = true
      break
    }
    const line = host.takeLine()
    if (line === undefined) continue
    if (line.trim() === QUIT) {
      offer.quit.fire()
      ended = true
      break
    }
    session.deliver(line)
  }
  if (ended) session.cancel()
  await session.done
}

const QUIT = '/quit'
