// In-process MemoryStore (spec 01 §2.4; spec 05 §2.1 extensions): a
// session-only store with in-memory tier-①/③ equivalents. The unit-layer fake
// and the store for stub runs — canned chatter never touches the real memory
// dir (spec 05 §3.7). The persistent three-tier store lives beside it here.

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import type { LedgerKind, MemoryStore, RecallHit, Turn } from './contracts.ts'
import { type IndexRow, RecallIndex, queryTokens } from './recall.ts'

export class InProcessMemoryStore implements MemoryStore {
  private turns: { ts: number; turn: Turn }[] = []
  private profileText = ''
  private topics: string[] = []
  private songs: string[] = []
  private anchors: string[] = []
  private setup: string[] = []
  private forgets: string[] = []
  private rwt: string[] = []

  private maxlen: number

  constructor(maxlen = 256) {
    this.maxlen = maxlen
  }

  record(turn: Turn): void {
    this.turns.push({ ts: Date.now() / 1000, turn })
    if (this.turns.length > this.maxlen) this.turns.splice(0, this.turns.length - this.maxlen)
  }

  recent(n: number): Turn[] {
    if (n <= 0) return []
    return this.turns.slice(-n).map((t) => t.turn)
  }

  profile(): string {
    return this.profileText
  }

  // A substring scan, not an index: this store is the session-only fake, and a
  // stub run never offers the recall tool anyway (spec 05-01 §2.1).
  recall(query: string, limit: number, excludeRecent = 0): RecallHit[] {
    const needle = query.trim().toLowerCase()
    if (needle === '' || limit <= 0) return []
    const searchable = excludeRecent > 0 ? this.turns.slice(0, -excludeRecent) : this.turns
    return searchable
      .filter((t) => t.turn.text.toLowerCase().includes(needle))
      .slice(-limit)
      .map((t) => ({ ts: t.ts, role: t.turn.role, text: t.turn.text, score: 1 }))
  }

  forget(what: string): { rows: number; lines: number } {
    const needle = what.trim().toLowerCase()
    if (needle === '') return { rows: 0, lines: 0 }
    const before = this.turns.length
    this.turns = this.turns.filter((t) => !t.turn.text.toLowerCase().includes(needle))
    const kept = this.profileText.split('\n').filter((l) => !l.toLowerCase().includes(needle))
    const lines = this.profileText.split('\n').length - kept.length
    this.profileText = kept.join('\n')
    return { rows: before - this.turns.length, lines }
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

  recentRwt(n: number): string[] {
    return n > 0 ? this.rwt.slice(-n) : []
  }

  recentEvents(kind: LedgerKind, n: number): string[] {
    return n > 0 ? this.ledger(kind).slice(-n) : []
  }

  private ledger(kind: LedgerKind): string[] {
    switch (kind) {
      case 'topic':
        return this.topics
      case 'song':
        return this.songs
      case 'anchor':
        return this.anchors
      case 'setup':
        return this.setup
      case 'forget':
        return this.forgets
      case 'rwt':
        return this.rwt
    }
  }
}

// Startup-prime freshness cutoff (spec 05 §3.4): only turns younger than this
// join the recent window on boot. Older continuity flows through the profile.
// By-feel tunable (spec 05 §6).
const RECENT_MAX_AGE_H = 48

// Compaction cadence (spec 05-01 §2.3): admitted LISTENER turns past the
// watermark, not turns. A session the listener never typed in has nothing to
// learn, so it never folds. By-feel tunable (spec 05-01 §6).
const COMPACT_EVERY_USER_TURNS = 8

// A fact unconfirmed this long fades out of the prompts (spec 05-01 §3.3).
export const FACT_FADE_DAYS = 90

// Acknowledgements that carry nothing to learn (spec 05-01 §3.2). English
// only: an acknowledgement in Chinese, Japanese or Korean is one or two
// characters, which the length rule below already covers — and no source file
// here holds CJK (DESIGN §0).
const ACK_LINES = new Set([
  'ok',
  'okay',
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'sure',
  'thanks',
  'thank you',
  'continue',
  'go on',
  'hmm',
  'hm',
  'right',
])

// Under this, a line the reply turn already acted on is a command, not a
// preference (spec 05-01 §3.2). Longer lines carry a fact even when steered:
// "skip this, I can't do saxophone tonight" says something durable.
const STEERED_MAX_CHARS = 12

// Whether a listener turn may teach the profile anything (spec 05-01 §3.2).
// Deterministic and model-free: code decides what enters the fold, the model
// only decides how to merge it. `steered` = the reply turn this line drove
// called an action tool.
export function admitsToFold(text: string, steered: boolean): boolean {
  const line = text.trim()
  if (line.startsWith('/')) return false
  if ([...line].length <= 2) return false
  if (ACK_LINES.has(line.toLowerCase())) return false
  if (steered && [...line].length < STEERED_MAX_CHARS) return false
  return true
}

// A fact is any line that is not a section header — a markdown bullet, or the
// plain prose the spec-06 bootstrap and a hand edit both produce. Matching only
// bullets left a bootstrapped profile permanently undated, which meant it never
// aged out either. Headers are the parenthesized labels; blank lines are not
// facts.
const FACT_LINE = /^\s*[^\s(]/
const SEEN_TAG = /\[seen (\d{4}-\d{2}-\d{2})\]/

// UTC, deliberately: a `[seen]` tag is only ever compared against another
// `[seen]` tag over a 90-day horizon, so one consistent day boundary matters
// and which one does not. Local days would make the same fact stamp differently
// on either side of midnight and put a timezone into every test.
const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10)

// When a faded fact was last confirmed, for its place in the recency ranking.
// An untagged line sorts as ancient, which is what it is.
const seenTs = (line: string): number => {
  const seen = SEEN_TAG.exec(line)
  return seen === null ? 0 : Date.parse(`${seen[1]}T00:00:00Z`) / 1000
}

// Words too common to identify anything on their own — without them, "forget
// about the coffee thing" would take every line containing "the".
const FORGET_STOPWORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'any',
  'anything',
  'for',
  'i',
  'it',
  'me',
  'my',
  'of',
  'on',
  'said',
  'that',
  'the',
  'thing',
  'to',
  'told',
  'we',
  'what',
  'you',
  'your',
])

const forgetTokens = (what: string): string[] =>
  queryTokens(what).filter((t) => !FORGET_STOPWORDS.has(t))

// The relevance floor (spec 05-01 §3.5): a line must carry two of the request's
// distinctive tokens, unless the request had only one — then that one IS the
// request. Keeps "forget the coffee thing" from taking the whole month.
// Whole tokens, never substrings: forgetting is irreversible, and "the ex thing"
// reduces to the single token "ex", which as a substring also names "next",
// "exhausted" and "exactly". The same tokenizer runs on both sides, so a CJK
// word still matches — shingling makes it a bigram on both.
// If by-ear says it over- or under-forgets, this floor is the knob.
function forgetMatches(tokens: readonly string[], text: string): boolean {
  const body = new Set(queryTokens(text))
  const found = tokens.filter((token) => body.has(token)).length
  return tokens.length === 1 ? found === 1 : found >= 2
}

// Every fact line carries a date (spec 05-01 §3.3). Undated lines — the spec-06
// bootstrap's output, a hand edit — are stamped with today, so they behave like
// a fresh fact instead of never expiring.
export function stampDates(profile: string, today: string): string {
  return profile
    .split('\n')
    .map((line) =>
      FACT_LINE.test(line) && !SEEN_TAG.test(line) ? `${line.trimEnd()} [seen ${today}]` : line,
    )
    .join('\n')
}

// Split a dated profile into what still speaks and what has gone quiet
// (spec 05-01 §3.3). A `[stable]` fact — name, language, what they do — never
// fades; a faded line leaves verbatim, so recall can still answer for it.
export function fadeFacts(profile: string, nowSeconds: number): { live: string; faded: string[] } {
  const horizon = nowSeconds - FACT_FADE_DAYS * 86400
  const live: string[] = []
  const faded: string[] = []
  for (const line of profile.split('\n')) {
    const seen = SEEN_TAG.exec(line)
    const stale = seen !== null && Date.parse(`${seen[1]}T00:00:00Z`) / 1000 < horizon
    if (FACT_LINE.test(line) && stale && !line.includes('[stable]')) faded.push(line)
    else live.push(line)
  }
  return { live: live.join('\n'), faded }
}

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
  // Set by the Director on a listener turn the reply already acted on
  // (spec 05-01 §3.2). Defaulted, so a file written before v1.5 still loads.
  steered: z.boolean().default(false),
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

// A history row as it sits on disk, for the rewrite path: our own JSON, with
// whatever fields the writing version put there kept intact.
type RawRow = { ts?: number; role?: string; text?: string } & Record<string, unknown>

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
  private fadedPath: string
  private metaPath: string
  private now: () => number
  private compactEvery: number
  private log: (message: string) => void
  private session = randomUUID().slice(0, 8)

  private maxlen: number
  private turns: { ts: number; turn: Turn }[] = []
  private topics: string[] = []
  private songs: string[] = []
  private anchors: string[] = []
  private setup: string[] = []
  private forgets: string[] = []
  private rwt: string[] = []
  private profileText = ''
  // Built on first recall/forget, not at boot (spec 05-01 §3.4).
  private recallIndex: RecallIndex | null = null
  private watermark = 0
  // Bumped by every forget. A fold reads its slice, then waits on a model call;
  // if the listener erases something in that window the fold is holding
  // pre-forget text, and applying it would write the erased fact straight back
  // into profile.md (spec 05-01 §3.5).
  private forgetEpoch = 0
  private sliceEpoch = 0
  private lastTs = 0
  // The gap this session opened across, measured once at load and then frozen
  // (spec 10 §3.7.3). undefined = no history on disk to measure from.
  private away: number | undefined
  // Turns recorded past the watermark — the next compaction slice.
  private backlog: { ts: number; turn: Turn; steered: boolean }[] = []

  constructor(options: PersistentMemoryOptions) {
    this.dir = options.dir
    this.historyPath = join(this.dir, 'history.jsonl')
    this.ledgerPath = join(this.dir, 'ledger.jsonl')
    this.profilePath = join(this.dir, 'profile.md')
    this.fadedPath = join(this.dir, 'profile-faded.md')
    this.metaPath = join(this.dir, 'meta.json')
    this.maxlen = options.maxlen ?? 256
    this.now = options.now ?? (() => Date.now() / 1000)
    this.compactEvery = options.compactEvery ?? COMPACT_EVERY_USER_TURNS
    this.log = options.log ?? (() => {})
    mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  // --- MemoryStore ---------------------------------------------------------- //

  record(turn: Turn): void {
    const ts = this.stamp()
    this.append(this.historyPath, { ts, session: this.session, role: turn.role, text: turn.text })
    this.remember(ts, turn)
    this.backlog.push({ ts, turn, steered: false })
    this.recallIndex?.add({ ts, role: turn.role, text: turn.text })
  }

  recent(n: number): Turn[] {
    if (n <= 0) return []
    return this.turns.slice(-n).map((t) => t.turn)
  }

  profile(): string {
    return this.profileText
  }

  // Everything on record, past the recent window (spec 05-01 §3.4). The index
  // is built on first use rather than at boot: recall rides a reply turn that
  // is already waiting on a model call, so the radio never waits for it.
  recall(query: string, limit: number, excludeRecent = 0): RecallHit[] {
    if (limit <= 0) return []
    // `excludeRecent` is how many trailing turns the MODEL can already see —
    // the reply prompt's transcript window, not the (much wider) window the
    // store keeps in memory. Excluding the latter would hide up to two days of
    // turns the model was never shown.
    // When fewer turns exist than the transcript renders, "the oldest of the
    // last N" does not exist — fall back to the oldest turn there is, or the
    // listener's own question comes back as a memory of itself.
    const seen =
      excludeRecent > 0 ? (this.turns.at(-excludeRecent)?.ts ?? this.turns[0]?.ts) : undefined
    return this.index().search(query, {
      now: this.now(),
      limit,
      excludeFromTs: seen ?? Infinity,
    })
  }

  // Physical removal, no backup (spec 05-01 §3.5): history rows, profile lines
  // and faded lines go, the index is rebuilt, and the in-memory window is
  // filtered so the very next pack no longer carries what went.
  forget(what: string, askedIn = 0): { rows: number; lines: number } {
    const tokens = forgetTokens(what)
    if (tokens.length === 0) return { rows: 0, lines: 0 }
    const hit = (text: string) => forgetMatches(tokens, text)
    // `askedIn` is how many trailing listener turns ARE the asking: the request
    // was recorded before the reply turn ran, and it always carries its own
    // words. Those rows still go — the asking can hold the very detail being
    // erased — but they are not COUNTED, or the radio would claim to have
    // forgotten something every single time it was asked.
    // slice(-0) would be the whole array, which would silently count nothing.
    const asked = new Set(
      askedIn > 0
        ? this.turns
            .filter((t) => t.turn.role === 'user')
            .slice(-askedIn)
            .map((t) => t.ts)
        : [],
    )

    let rows = 0
    let dropped = 0
    this.rewriteHistory((row) => {
      if (typeof row.text !== 'string' || !hit(row.text)) return row
      dropped++
      if (row.ts === undefined || !asked.has(row.ts)) rows++
      return null
    })
    const lines = this.forgetLines(this.profilePath, hit) + this.forgetLines(this.fadedPath, hit)
    if (dropped === 0 && lines === 0) return { rows: 0, lines: 0 }

    this.profileText = this.readText(this.profilePath)
    this.turns = this.turns.filter((t) => !hit(t.turn.text))
    this.backlog = this.backlog.filter((b) => !hit(b.turn.text))
    // The index holds every row's text verbatim, so a stale index.db is a copy
    // of exactly what was asked to be destroyed. A DELETE is not enough — the
    // row's bytes stay on SQLite's freelist and the words are still in the
    // file. Close it and unlink it; the next recall rebuilds from the cleaned
    // sources. (A row-count check would not have caught this either: record as
    // many new turns as were forgotten and the counts agree again.)
    this.dropIndex()
    this.forgetEpoch++
    if (rows === 0 && lines === 0) return { rows: 0, lines: 0 }
    // The time only: an event that kept what was forgotten would defeat the
    // point of asking.
    this.recordEvent('forget', new Date(this.now() * 1000).toISOString())
    return { rows, lines }
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

  recentRwt(n: number): string[] {
    return n > 0 ? this.rwt.slice(-n) : []
  }

  // Any ledger kind, by name. Impl-level and deliberately NOT on the MemoryStore
  // contract: the setup offer reads its own standing answer (spec 03-03 §7.1),
  // and the Director has no business in that tier.
  recentEvents(kind: LedgerKind, n: number): string[] {
    if (n <= 0) return []
    switch (kind) {
      case 'topic':
        return this.topics.slice(-n)
      case 'song':
        return this.songs.slice(-n)
      case 'anchor':
        return this.anchors.slice(-n)
      case 'setup':
        return this.setup.slice(-n)
      case 'forget':
        return this.forgets.slice(-n)
      case 'rwt':
        return this.rwt.slice(-n)
    }
  }

  // --- compaction surface (spec 05 §3.6 — driven by the Compactor) ---------- //

  compactionDue(): boolean {
    return this.admitted().length >= this.compactEvery
  }

  // The reply turn just acted on the newest listener line (spec 05-01 §3.2):
  // an acted-on request is not a preference, so the fold never sees it. The
  // flag is per row and only the Director knows it, so it arrives after the
  // record — which is why the row on disk is rewritten rather than inferred.
  // ponytail: a full rewrite per steered turn; history stays small by design
  // (spec 05 non-goals), and it is off the audio path.
  markSteered(): void {
    // The trailing run of listener rows, not just the newest: a line typed while
    // the reply was composing is merged into the SAME turn, so every line in
    // that run drove the action the reply took. The run ends at the host line
    // before it, which is what keeps an earlier, unacted-on turn admitted.
    const run: number[] = []
    for (let i = this.backlog.length - 1; i >= 0; i--) {
      const entry = this.backlog[i]!
      if (entry.turn.role !== 'user') break
      if (!entry.steered) {
        entry.steered = true
        run.push(entry.ts)
      }
    }
    if (run.length === 0) return
    const marked = new Set(run)
    this.rewriteHistory((row) =>
      typeof row.ts === 'number' && marked.has(row.ts) ? { ...row, steered: true } : row,
    )
  }

  // --- absence (spec 10 §3.7.3 — the pet acknowledges elapsed time) --------- //

  // Seconds between the newest row already on disk and the moment this session
  // opened: the size of the GAP the listener came back across. Frozen, not live
  // — the absence the pet greets is one fact about the return, and a number that
  // crept upward all session would not be that fact.
  // undefined = nothing on record: a first run has no absence to acknowledge.
  awaySeconds(): number | undefined {
    return this.away
  }

  // --- profile write-through (spec 06 §2.4 — the slice-B bootstrap) --------- //

  // Replace the profile outright. Impl-level, deliberately NOT on the
  // MemoryStore contract: the Director never writes the profile. The watermark
  // is untouched — a bootstrap consumes no backlog, so turns already recorded
  // are still owed to the next fold.
  writeProfile(text: string): void {
    this.refreshProfile(text)
  }

  // The listener's own turns and, for each, the host line it answered — never
  // the monologue stream (spec 05-01 §3.1). A fold cannot attribute the host's
  // musings to the listener because it never sees them. `throughTs` still
  // covers every row past the watermark, host rows included, so the monologue
  // after the last listener turn is not re-scanned forever.
  compactionSlice(): { profile: string; turns: Turn[]; throughTs: number } {
    const turns: Turn[] = []
    let emitted = -1
    this.backlog.forEach((entry, i) => {
      if (!this.admits(entry)) return
      for (let j = i - 1; j > emitted; j--) {
        if (this.backlog[j]!.turn.role === 'radio') {
          turns.push(this.backlog[j]!.turn)
          emitted = j
          break
        }
      }
      turns.push(entry.turn)
      emitted = i
    })
    this.sliceEpoch = this.forgetEpoch
    return {
      profile: this.profileText,
      turns,
      throughTs: this.backlog.at(-1)?.ts ?? this.watermark,
    }
  }

  applyCompaction(newProfile: string, throughTs: number): void {
    if (this.sliceEpoch !== this.forgetEpoch) {
      // Dropping the fold costs nothing: the watermark did not move, so the
      // turns are folded again next time — from sources the forget has cleaned.
      this.log('memory: dropping a fold that predates a forget')
      return
    }
    this.refreshProfile(newProfile)
    atomicWrite(this.metaPath, JSON.stringify({ compacted_through: throughTs }))
    this.watermark = throughTs
    this.backlog = this.backlog.filter((b) => b.ts > throughTs)
  }

  // --- internals ------------------------------------------------------------ //

  // The derived index, built on first use and rebuilt whenever its row count
  // disagrees with the files it is derived from (spec 05-01 §3.4).
  // Close and unlink the derived index and anything SQLite left beside it.
  private dropIndex(): void {
    this.recallIndex?.close()
    this.recallIndex = null
    const db = join(this.dir, 'index.db')
    for (const path of [db, `${db}-journal`, `${db}-wal`, `${db}-shm`]) {
      rmSync(path, { force: true })
    }
  }

  private index(): RecallIndex {
    if (this.recallIndex === null) {
      this.recallIndex = new RecallIndex(join(this.dir, 'index.db'), this.log)
      const rows = this.indexRows()
      if (this.recallIndex.count() !== rows.length) this.recallIndex.rebuild(rows)
    }
    return this.recallIndex
  }

  // Everything searchable, read back from the sources of truth: the whole turn
  // log plus the faded facts, which are gone from the prompts but still
  // answerable when the listener asks about one.
  private indexRows(): IndexRow[] {
    const rows: IndexRow[] = this.readJsonl(this.historyPath, historyRowSchema).map((row) => ({
      ts: row.ts,
      role: row.role,
      text: row.text,
    }))
    for (const line of this.readText(this.fadedPath).split('\n')) {
      if (FACT_LINE.test(line)) rows.push({ ts: seenTs(line), role: 'faded', text: line })
    }
    return rows
  }

  private readText(path: string): string {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return ''
    }
  }

  // Drop matching lines from a profile file atomically; returns how many went.
  private forgetLines(path: string, hit: (text: string) => boolean): number {
    const text = this.readText(path)
    if (text === '') return 0
    const lines = text.split('\n')
    const kept = lines.filter((line) => !hit(line))
    if (kept.length === lines.length) return 0
    atomicWrite(path, kept.join('\n'))
    return lines.length - kept.length
  }

  private admits(entry: { turn: Turn; steered: boolean }): boolean {
    return entry.turn.role === 'user' && admitsToFold(entry.turn.text, entry.steered)
  }

  private admitted(): { ts: number; turn: Turn }[] {
    return this.backlog.filter((b) => this.admits(b))
  }

  // Date post-pass then fade pass, then the files (spec 05-01 §3.3). Fade runs
  // before the profile is ever served or capped, so old facts make room rather
  // than the model being asked to cut live ones to fit them.
  private refreshProfile(text: string): void {
    const now = this.now()
    const stamped = stampDates(text, isoDay(now))
    const { live, faded } = fadeFacts(stamped, now)
    if (live !== this.profileText) atomicWrite(this.profilePath, live)
    if (faded.length > 0) {
      appendFileSync(this.fadedPath, `${faded.join('\n')}\n`, 'utf-8')
      for (const line of faded) this.recallIndex?.add({ ts: seenTs(line), role: 'faded', text: line })
    }
    this.profileText = live
  }

  // Rewrite history.jsonl through `map` — the only non-append write to it
  // (spec 05-01 §3.2/§3.5), atomic so a reader never sees a torn file. A row
  // the mapper drops is gone; an unparseable line is kept verbatim rather than
  // silently deleted by a repair the listener did not ask for.
  private rewriteHistory(map: (row: RawRow) => RawRow | null): void {
    let text: string
    try {
      text = readFileSync(this.historyPath, 'utf-8')
    } catch {
      return
    }
    const kept: string[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        kept.push(line)
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) {
        kept.push(line)
        continue
      }
      const next = map(parsed as RawRow)
      if (next !== null) kept.push(JSON.stringify(next))
    }
    const rewritten = kept.length === 0 ? '' : `${kept.join('\n')}\n`
    // A request that matched nothing must not touch the file at all.
    if (rewritten !== text) atomicWrite(this.historyPath, rewritten)
  }

  // Strictly increasing stamps: the throughTs watermark then always separates
  // a compaction slice from turns recorded while the fold was in flight.
  private stamp(): number {
    this.lastTs = Math.max(this.now(), this.lastTs + 1e-6)
    return this.lastTs
  }

  private append(path: string, row: Record<string, unknown>): void {
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf-8')
  }

  private remember(ts: number, turn: Turn): void {
    this.turns.push({ ts, turn })
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
            : kind === 'setup'
              ? this.setup
              : kind === 'forget'
                ? this.forgets
                : kind === 'rwt'
                  ? this.rwt
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
    let profileRaw = ''
    try {
      profileRaw = readFileSync(this.profilePath, 'utf-8')
    } catch {
      profileRaw = ''
    }
    this.profileText = profileRaw
    if (profileRaw !== '') this.refreshProfile(profileRaw)

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
      if (row.ts >= cutoff) this.remember(row.ts, turn)
      if (row.ts > this.watermark) this.backlog.push({ ts: row.ts, turn, steered: row.steered })
    }

    if (this.lastTs > 0) this.away = Math.max(0, Math.round(this.now() - this.lastTs))

    for (const row of this.readJsonl(this.ledgerPath, ledgerRowSchema)) {
      this.rememberEvent(row.kind, row.key)
    }
  }
}
