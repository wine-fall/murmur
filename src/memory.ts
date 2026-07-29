// In-process MemoryStore (spec 01 §2.4; spec 05 §2.1 extensions): a
// session-only store with in-memory tier-①/③ equivalents. The unit-layer fake
// and the store for stub runs — canned chatter never touches the real memory
// dir (spec 05 §3.7). The persistent three-tier store lives beside it here.

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import type { LedgerKind, MemoryStore, Turn } from './contracts.ts'

export class InProcessMemoryStore implements MemoryStore {
  private turns: Turn[] = []
  private profileText = ''
  private topics: string[] = []
  private songs: string[] = []
  private anchors: string[] = []

  private maxlen: number

  constructor(maxlen = 256) {
    this.maxlen = maxlen
  }

  record(turn: Turn): void {
    this.turns.push(turn)
    if (this.turns.length > this.maxlen) this.turns.splice(0, this.turns.length - this.maxlen)
  }

  recent(n: number): Turn[] {
    if (n <= 0) return []
    return this.turns.slice(-n)
  }

  profile(): string {
    return this.profileText
  }

  recordEvent(kind: LedgerKind, key: string): void {
    this.ledger(kind).push(key)
  }

  recentTopics(n: number): string[] {
    return n > 0 ? this.topics.slice(-n) : []
  }

  recentSongs(n: number): string[] {
    return n > 0 ? this.songs.slice(-n) : []
  }

  recentAnchors(n: number): string[] {
    return n > 0 ? this.anchors.slice(-n) : []
  }

  private ledger(kind: LedgerKind): string[] {
    switch (kind) {
      case 'topic':
        return this.topics
      case 'song':
        return this.songs
      case 'anchor':
        return this.anchors
    }
  }
}

// Startup-prime freshness cutoff (spec 05 §3.4): only turns younger than this
// join the recent window on boot. Older continuity flows through the profile.
// By-feel tunable (spec 05 §6).
const RECENT_MAX_AGE_H = 48

// Compaction backlog threshold (spec 05 §3.6). By-feel tunable (spec 05 §6).
const COMPACT_EVERY_TURNS = 100

// In-memory ledger tail kept per kind — bounds boot memory, far above any
// realistic recentTopics/recentSongs(n).
const LEDGER_TAIL = 256

// The file-persistence boundary is untrusted (issue #54 rule): every row read
// back is zod-parsed, never cast. Rows are written by us but may be torn,
// hand-edited, or from another murmur version.
const historyRowSchema = z.object({
  ts: z.number(),
  role: z.enum(['radio', 'user']),
  text: z.string(),
})

const ledgerRowSchema = z.object({
  kind: z.string(),
  key: z.string(),
})

// On-disk snake_case matches the Python store — the same memory dir carries
// over at cutover with no migration.
const metaSchema = z.object({
  compacted_through: z.number(),
})

// Temp file + rename in the same directory — a reader never sees a torn
// profile/meta (spec 05 §3.1 write discipline).
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

export type PersistentMemoryOptions = {
  dir: string
  maxlen?: number
  // Unix seconds; injectable so freshness/watermark behavior tests never touch
  // the wall clock.
  now?: () => number
  compactEvery?: number
  log?: (message: string) => void
}

export class PersistentMemoryStore implements MemoryStore {
  private dir: string
  private historyPath: string
  private ledgerPath: string
  private profilePath: string
  private metaPath: string
  private now: () => number
  private compactEvery: number
  private log: (message: string) => void
  private session = randomUUID().slice(0, 8)

  private maxlen: number
  private turns: Turn[] = []
  private topics: string[] = []
  private songs: string[] = []
  private anchors: string[] = []
  private profileText = ''
  private watermark = 0
  private lastTs = 0
  // Turns recorded past the watermark — the next compaction slice.
  private backlog: { ts: number; turn: Turn }[] = []

  constructor(options: PersistentMemoryOptions) {
    this.dir = options.dir
    this.historyPath = join(this.dir, 'history.jsonl')
    this.ledgerPath = join(this.dir, 'ledger.jsonl')
    this.profilePath = join(this.dir, 'profile.md')
    this.metaPath = join(this.dir, 'meta.json')
    this.maxlen = options.maxlen ?? 256
    this.now = options.now ?? (() => Date.now() / 1000)
    this.compactEvery = options.compactEvery ?? COMPACT_EVERY_TURNS
    this.log = options.log ?? (() => {})
    mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  // --- MemoryStore ---------------------------------------------------------- //

  record(turn: Turn): void {
    const ts = this.stamp()
    this.append(this.historyPath, { ts, session: this.session, role: turn.role, text: turn.text })
    this.remember(turn)
    this.backlog.push({ ts, turn })
  }

  recent(n: number): Turn[] {
    if (n <= 0) return []
    return this.turns.slice(-n)
  }

  profile(): string {
    return this.profileText
  }

  recordEvent(kind: LedgerKind, key: string): void {
    this.append(this.ledgerPath, { ts: this.stamp(), session: this.session, kind, key })
    this.rememberEvent(kind, key)
  }

  recentTopics(n: number): string[] {
    return n > 0 ? this.topics.slice(-n) : []
  }

  recentSongs(n: number): string[] {
    return n > 0 ? this.songs.slice(-n) : []
  }

  recentAnchors(n: number): string[] {
    return n > 0 ? this.anchors.slice(-n) : []
  }

  // --- compaction surface (spec 05 §3.6 — driven by the Compactor) ---------- //

  compactionDue(): boolean {
    return this.backlog.length >= this.compactEvery
  }

  // --- profile write-through (spec 06 §2.4 — the slice-B bootstrap) --------- //

  // Replace the profile outright. Impl-level, deliberately NOT on the
  // MemoryStore contract: the Director never writes the profile. The watermark
  // is untouched — a bootstrap consumes no backlog, so turns already recorded
  // are still owed to the next fold.
  writeProfile(text: string): void {
    atomicWrite(this.profilePath, text)
    this.profileText = text
  }

  // Current profile + the un-compacted turns + the slice's last row timestamp.
  // The watermark travels with the slice: the fold races record(), so apply
  // advances exactly to throughTs — never "the latest row".
  compactionSlice(): { profile: string; turns: Turn[]; throughTs: number } {
    return {
      profile: this.profileText,
      turns: this.backlog.map((b) => b.turn),
      throughTs: this.backlog.at(-1)?.ts ?? this.watermark,
    }
  }

  applyCompaction(newProfile: string, throughTs: number): void {
    atomicWrite(this.profilePath, newProfile)
    atomicWrite(this.metaPath, JSON.stringify({ compacted_through: throughTs }))
    this.profileText = newProfile
    this.watermark = throughTs
    this.backlog = this.backlog.filter((b) => b.ts > throughTs)
  }

  // --- internals ------------------------------------------------------------ //

  // Strictly increasing stamps: the throughTs watermark then always separates
  // a compaction slice from turns recorded while the fold was in flight.
  private stamp(): number {
    this.lastTs = Math.max(this.now(), this.lastTs + 1e-6)
    return this.lastTs
  }

  private append(path: string, row: Record<string, unknown>): void {
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf-8')
  }

  private remember(turn: Turn): void {
    this.turns.push(turn)
    if (this.turns.length > this.maxlen) this.turns.splice(0, this.turns.length - this.maxlen)
  }

  // An unknown kind (a newer murmur's ledger) is skipped, not crashed on.
  private rememberEvent(kind: string, key: string): void {
    const target =
      kind === 'topic'
        ? this.topics
        : kind === 'song'
          ? this.songs
          : kind === 'anchor'
            ? this.anchors
            : null
    if (target === null) return
    target.push(key)
    if (target.length > LEDGER_TAIL) target.splice(0, target.length - LEDGER_TAIL)
  }

  // Parse a JSONL file's lines, zod-validating each against `schema`; skips
  // undecodable/malformed lines (the torn-tail crash case, spec 05 §3.8) — a
  // damaged memory degrades, it never prevents boot.
  private readJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      return []
    }
    const rows: T[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        this.log(`memory: skipping corrupt line in ${path.split('/').at(-1)}`)
        continue
      }
      const row = schema.safeParse(parsed)
      if (row.success) rows.push(row.data)
      else this.log(`memory: skipping malformed row in ${path.split('/').at(-1)}`)
    }
    return rows
  }

  private load(): void {
    try {
      this.profileText = readFileSync(this.profilePath, 'utf-8')
    } catch {
      this.profileText = ''
    }

    let metaRaw: string | null = null
    try {
      metaRaw = readFileSync(this.metaPath, 'utf-8')
    } catch {
      metaRaw = null
    }
    if (metaRaw !== null) {
      let meta: unknown = null
      try {
        meta = JSON.parse(metaRaw)
      } catch {
        meta = null
      }
      const parsed = metaSchema.safeParse(meta)
      if (parsed.success) this.watermark = parsed.data.compacted_through
      else this.log('memory: meta.json unreadable; treating as never compacted')
    }

    const cutoff = this.now() - RECENT_MAX_AGE_H * 3600
    for (const row of this.readJsonl(this.historyPath, historyRowSchema)) {
      this.lastTs = Math.max(this.lastTs, row.ts)
      const turn: Turn = { role: row.role, text: row.text }
      if (row.ts >= cutoff) this.remember(turn)
      if (row.ts > this.watermark) this.backlog.push({ ts: row.ts, turn })
    }

    for (const row of this.readJsonl(this.ledgerPath, ledgerRowSchema)) {
      this.rememberEvent(row.kind, row.key)
    }
  }
}
