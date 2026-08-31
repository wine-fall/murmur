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
