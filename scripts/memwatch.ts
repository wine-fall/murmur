// Live memory watch for a murmur process tree.
//
// murmur's memory spans a process tree — the main node loop plus its per-track
// ffmpeg decoders — so watching one pid tells you little. This samples `ps` for
// the tree structure, `top` for each process's real size, finds the murmur tree
// (or the tree under --pid), and prints one line per tick: total size, session
// peak, and a per-process breakdown.
//
//   node scripts/memwatch.ts                # auto-find the murmur tree
//   node scripts/memwatch.ts --pid 12345    # watch an explicit root
//   node scripts/memwatch.ts --interval 5   # sample every 5 s (default 2)
//   node scripts/memwatch.ts --once         # one snapshot, then exit
//
// Each process's size is its phys_footprint (macOS `top`'s MEM column — the
// same number Activity Monitor shows), which counts the Metal/GPU/compressed
// pages that `ps` RSS silently misses. Off macOS, or if `top` is unavailable,
// it falls back to `ps` RSS.
//
// Note: summing across processes still over-counts pages shared between them
// (framework, forked) — read totals as an upper bound and watch the TREND.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

export type Proc = { pid: number; ppid: number; rssKb: number; command: string }

// (total_mb, available_mb) for the whole machine.
export type SystemMemory = readonly [number, number]

// Parse `ps -axo pid=,ppid=,rss=,command=` output (macOS and Linux).
export function parsePs(text: string): Proc[] {
  const procs: Proc[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line)
    if (match) {
      procs.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKb: Number(match[3]),
        command: match[4]!,
      })
    }
  }
  return procs
}

export function snapshot(): Proc[] {
  return parsePs(execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }))
}

// -- real per-process size: phys_footprint via `top` -----------------------
//
// `ps` RSS reports resident_size, which excludes the Metal/GPU-mapped and
// compressed pages a model actually holds — a sidecar can read ~40 MB by RSS
// while truly costing ~1 GB. `top`'s MEM column is phys_footprint (Activity
// Monitor's "Memory"), which counts them. One `top -l1` sample gives it for
// every pid at once, so it is cheaper than per-pid `footprint`.

const MEM_UNITS: Record<string, number> = {
  B: 1 / 1024,
  K: 1,
  M: 1024,
  G: 1024 * 1024,
  T: 1024 ** 3,
}

// One `top` MEM token in KB: `227M` `8722K` `1G` `5M+` (top marks a changed
// value with a trailing sign). Null if it isn't a size.
export function memTokenKb(token: string): number | null {
  const trimmed = token.trim().replace(/[+*-]+$/, '')
  if (trimmed === '') return null
  const unit = MEM_UNITS[trimmed.at(-1)!]
  const value = Number(unit === undefined ? trimmed : trimmed.slice(0, -1))
  if (!Number.isFinite(value)) return null
  return unit === undefined ? Math.round(value / 1024) : Math.round(value * unit)
}

// Map pid -> phys_footprint (KB) from `top -l1 -stats pid,mem` output. Skips
// the preamble/header; keeps only `<int-pid> <mem-token>` rows.
export function parseTopMem(text: string): Map<number, number> {
  const sizes = new Map<number, number>()
  for (const line of text.split('\n')) {
    const [rawPid, rawMem] = line.trim().split(/\s+/)
    if (rawPid === undefined || rawMem === undefined || !/^\d+$/.test(rawPid)) continue
    const kb = memTokenKb(rawMem)
    if (kb !== null) sizes.set(Number(rawPid), kb)
  }
  return sizes
}

// pid -> phys_footprint (KB) for every process from one `top` sample. macOS
// only; empty map off-darwin or if `top` fails — callers fall back to `ps` RSS
// (accurate enough on Linux, which has no unified-memory blind spot).
export function topFootprints(): Map<number, number> {
  if (process.platform !== 'darwin') return new Map()
  try {
    return parseTopMem(execFileSync('top', ['-l', '1', '-stats', 'pid,mem'], { encoding: 'utf8' }))
  } catch {
    return new Map()
  }
}

// Replace each proc's `ps` RSS with its `top` phys_footprint where known. RSS
// is a floor (misses Metal/GPU/compressed); phys_footprint is honest. A pid
// absent from the `top` sample (a race) keeps its RSS.
export function applyFootprints(procs: Proc[], footprintsKb: Map<number, number>): Proc[] {
  if (footprintsKb.size === 0) return procs
  return procs.map((p) => ({ ...p, rssKb: footprintsKb.get(p.pid) ?? p.rssKb }))
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])

// True when the process IS the program (its executable is `needle`) — not
// merely mentions it in an argument (an editor open on murmur-notes.txt is not
// murmur).
function runsProgram(command: string, needle: string): boolean {
  const tokens = command.split(/\s+/)
  if (tokens.length === 0 || tokens[0] === undefined) return false
  // A shell running `-c <script>` is not the program even when the script
  // names it: `make dev`'s recipe shell backgrounds the recorder AND launches
  // murmur, so its command line can carry a bare `murmur` token. Matching it
  // would root the tree at the wrapper and pull the recorder itself into the
  // measured tree. Skip it; the app process (whose title is `murmur`) matches
  // on its own.
  if (SHELLS.has(basename(tokens[0])) && tokens.includes('-c')) return false
  return tokens.some((token) => basename(token) === needle)
}

// Top-of-tree murmur processes: the program matches, its parent doesn't (a
// child that matches too rides under main).
export function findRoots(procs: Proc[], needle = 'murmur'): Proc[] {
  const matching = new Map<number, Proc>()
  for (const p of procs) {
    if (p.pid !== process.pid && runsProgram(p.command, needle)) matching.set(p.pid, p)
  }
  return [...matching.values()].filter((p) => !matching.has(p.ppid))
}

// The root and all its descendants (ffmpeg, sidecar, their helpers).
export function subtree(procs: Proc[], rootPid: number): Proc[] {
  const children = new Map<number, Proc[]>()
  for (const p of procs) {
    const siblings = children.get(p.ppid)
    if (siblings) siblings.push(p)
    else children.set(p.ppid, [p])
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const members: Proc[] = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.pop()!
    const proc = byPid.get(pid)
    if (proc) members.push(proc)
    queue.push(...(children.get(pid) ?? []).map((c) => c.pid))
  }
  return members
}

export function label(proc: Proc): string {
  const executable = basename(proc.command.split(/\s+/)[0] ?? '')
  if (executable.endsWith('ffmpeg')) return 'ffmpeg'
  if (proc.command.includes('murmur')) return 'main'
  return 'child'
}

const mb = (kb: number): string => (kb / 1024).toFixed(1)

// -- system-wide memory (the whole machine, not just the murmur tree) -------

// `MemAvailable` from Linux /proc/meminfo text, in MB (null if absent).
// MemAvailable is the kernel's own estimate of reclaimable memory — the right
// "how much headroom" number.
export function parseMeminfoAvailableMb(text: string): number | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('MemAvailable:')) {
      const kb = Number(line.split(/\s+/)[1])
      return Number.isFinite(kb) ? kb / 1024 : null
    }
  }
  return null
}

// Approx available RAM from macOS `vm_stat` text, in MB: the reclaimable page
// buckets (free + inactive + speculative + purgeable) x page size. A coarse
// pressure gauge — watch the trend, not the exact byte.
export function parseVmStatAvailableMb(text: string): number {
  let page = 4096
  const buckets = ['free', 'inactive', 'speculative', 'purgeable']
  let pages = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const pageSize = /page size of (\d+) bytes/.exec(line)
    if (pageSize) {
      page = Number(pageSize[1])
      continue
    }
    for (const bucket of buckets) {
      if (line.startsWith(`Pages ${bucket}:`)) {
        const count = Number(line.split(':')[1]?.trim().replace(/\.$/, ''))
        if (Number.isFinite(count)) pages += count
      }
    }
  }
  return (pages * page) / 1024 / 1024
}

// (total_mb, available_mb) for the whole machine. Total is exact; available is
// the OS reclaimable estimate — and equals total when we cannot read one.
export function systemMemory(): SystemMemory {
  const total = totalmem() / 1024 / 1024
  let avail: number | null = null
  if (process.platform === 'linux') {
    try {
      avail = parseMeminfoAvailableMb(readFileSync('/proc/meminfo', 'utf8'))
    } catch {
      avail = null
    }
  } else if (process.platform === 'darwin') {
    try {
      avail = parseVmStatAvailableMb(execFileSync('vm_stat', [], { encoding: 'utf8' }))
    } catch {
      avail = null
    }
  }
  return [total, avail ?? total]
}

// The `  |  sys used U / total T MB (avail A)` tail — the whole-machine
// memory, shared by the tick line and the no-murmur line so both carry it.
function sysSuffix(sysMem: SystemMemory | null): string {
  if (sysMem === null) return ''
  const [total, avail] = sysMem
  return `  |  sys used ${(total - avail).toFixed(0)} / ${total.toFixed(0)} MB (avail ${avail.toFixed(0)})`
}

const stamp = (): string => new Date().toTimeString().slice(0, 8)

export function formatTick(members: Proc[], peakKb: number, sysMem: SystemMemory | null = null): string {
  const total = members.reduce((sum, p) => sum + p.rssKb, 0)
  const parts = [...members]
    .sort((a, b) => b.rssKb - a.rssKb)
    .map((p) => `${label(p)} ${mb(p.rssKb)}`)
    .join(', ')
  return `${stamp()}  total ${mb(total)} MB  (peak ${mb(Math.max(peakKb, total))} MB)  [${parts}]${sysSuffix(sysMem)}`
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pid: { type: 'string' }, // explicit tree root
      interval: { type: 'string' }, // seconds between samples
      once: { type: 'boolean' }, // one snapshot, then exit
      out: { type: 'string' }, // also append each tick here (the `make dev` recorder)
    },
  })
  const rootPid = values.pid === undefined ? null : Number(values.pid)
  const intervalMs = Number(values.interval ?? 2) * 1000

  const emit = (text: string): void => {
    console.log(text)
    if (values.out !== undefined) appendFileSync(values.out, `${text}\n`)
  }

  let peakKb = 0
  for (;;) {
    // A recorder must survive its own errors: a bad `ps`/`top` sample or a
    // parse bug logs one line and the loop goes on, never dying silently
    // mid-run (and never — it is a separate process — touching murmur).
    try {
      const procs = applyFootprints(snapshot(), topFootprints())
      const roots = rootPid === null ? findRoots(procs) : procs.filter((p) => p.pid === rootPid)
      if (roots.length === 0) {
        // Still report the machine's memory — just flag that murmur isn't up
        // yet (e.g. the recorder started before the app).
        emit(`${stamp()}  (no murmur running)${sysSuffix(systemMemory())}`)
      }
      for (const root of roots) {
        const members = subtree(procs, root.pid)
        emit(formatTick(members, peakKb, systemMemory()))
        peakKb = Math.max(peakKb, members.reduce((sum, p) => sum + p.rssKb, 0))
      }
    } catch (error) {
      emit(`${stamp()}  ERROR sampling: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    }
    if (values.once === true) return 0
    await sleep(intervalMs)
  }
}

if (import.meta.main) process.exit(await main())
