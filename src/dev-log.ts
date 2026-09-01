// Where the diagnostics go (spec 05 §2.3). `make dev` points MURMUR_DEV_LOG at
// the repo's .dev/dev.log; an installed murmur has no such env, so the default
// is a dated file under the one murmur home — a listener who hits a bug has a
// log to attach without having known to turn one on.

import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { z } from 'zod'

import { expandUser, logRoot } from './paths.ts'

// ponytail: one file per day, swept at startup — no size cap, no mid-run
// rotation. A run that spans midnight keeps writing to the day it started.
// Add size-based rotation only if a single day's log ever gets unwieldy.
const RETENTION_DAYS = 14
// Exported because the bug report reads the same dated set (src/diagnostics.ts).
export const DAILY_LOG = /^murmur-(\d{4}-\d{2}-\d{2})\.log$/

function stamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

// Where a report goes looking for the run's own diagnostics. The two shapes are
// the two the writer can produce, and they are NOT interchangeable: the default
// is a dated SET that rotates by day, while an override is one file that never
// rotates. Every reader of log evidence takes this rather than a bare directory
// (src/diagnostics.ts, src/sentinel.ts), so the two roads into a report cannot
// disagree about where the evidence lives.
export const LogEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), dir: z.string() }),
  z.object({ kind: z.literal('file'), path: z.string() }),
  // MURMUR_DEV_LOG was set to nothing: this run keeps no diagnostics, so there
  // is no evidence to read. A named state, so a reader answers "none" instead
  // of scanning whatever directory a fallback would have invented.
  z.object({ kind: z.literal('none') }),
])

export type LogEvidence = z.infer<typeof LogEvidenceSchema>

// The one branch. `path` is where the mirror appends; `evidence` is what a
// reader must walk to find it again — decided HERE, by the code that chose the
// path, rather than by an upper layer comparing a string against a default.
export function resolveLogSource(
  env: NodeJS.ProcessEnv = process.env,
  at: Date = new Date(),
): { path: string; evidence: LogEvidence } {
  // The knob is read for its PRESENCE, not its truthiness: an explicitly empty
  // MURMUR_DEV_LOG is the way to ask for no log at all (devLogMirror's no-op).
  const override = env.MURMUR_DEV_LOG
  if (override === undefined) {
    const dir = logRoot(env)
    return { path: join(dir, `murmur-${stamp(at)}.log`), evidence: { kind: 'daily', dir } }
  }
  if (override === '') return { path: '', evidence: { kind: 'none' } }
  const path = expandUser(override)
  return { path, evidence: { kind: 'file', path } }
}

export function resolveDevLog(env: NodeJS.ProcessEnv = process.env, at: Date = new Date()): string {
  return resolveLogSource(env, at).path
}

// Make the directory the mirror is about to append to, and drop the dated logs
// that have aged out. Best-effort like every other dev-log write: a read-only
// or occupied location costs diagnostics, never the radio.
export function prepareDevLog(path: string, at: Date = new Date()): void {
  if (path === '') return
  const dir = dirname(path)
  try {
    mkdirSync(dir, { recursive: true })
    // Sweep only a directory of dated daily logs — i.e. one murmur names. A
    // listener who points MURMUR_DEV_LOG at a file of their own keeps whatever
    // else lives beside it, and their own target is never the thing swept.
    const target = basename(path)
    if (!DAILY_LOG.test(target)) return
    const cutoff = stamp(new Date(at.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000))
    for (const name of readdirSync(dir)) {
      const dated = DAILY_LOG.exec(name)
      if (dated === null || dated[1]! >= cutoff || name === target) continue
      rmSync(join(dir, name), { force: true })
    }
  } catch {
    // e.g. an unwritable home, or a file sitting where the directory should be
  }
}
