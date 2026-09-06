// Recall over history (spec 05-01 §3.4): a derived FTS5 index beside the JSONL
// files, with CJK-aware tokenizing and a recency x source-weighted rerank.
//
// DERIVED AND DISPOSABLE. The JSONL/markdown files stay the source of truth;
// nothing lands here that is not also in one of them. Deleting index.db costs a
// rebuild, nothing else.
//
// `node:sqlite` rather than a dependency: it is the only zero-dep FTS5 on the
// Node we already require, and the API surface used is three calls. If a Node
// bump ever breaks it, better-sqlite3 is a drop-in with a native build cost.

import { rmSync } from 'node:fs'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { RecallHit, RecallRole } from '../contracts.ts'

// node:sqlite is fetched at first use, not imported: it is behind Node's
// experimental flag and warns the moment it LINKS, which is before any listener
// a static import could install. Deferring it puts the load after src/warnings.ts
// has run — and a run that never recalls does not load it at all.
const sqlite = () => process.getBuiltinModule('node:sqlite')

// bm25 top-k taken before the rerank runs (spec 05-01 §2.5).
export const RECALL_CANDIDATES = 40
// Recency decay: a memory is worth half as much after this long.
export const RECALL_HALF_LIFE_DAYS = 30
// What the listener said outranks what the host said about it.
export const RECALL_USER_BOOST = 3
// Floor under the decay, so an old exact hit still surfaces at all.
const RECENCY_FLOOR = 0.05

// Han, kana and Hangul runs. `unicode61` treats such a run as ONE token, so
// "coffee" inside a sentence would never match; every run is replaced by its
// character bigrams before insert AND before query. `trigram` was rejected: it
// cannot match two-character words, which are most Chinese words.
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]+/g

// Shingle both sides or nothing matches, silently — an index built with bigrams
// and a query without hits nothing at all.
export function shingle(text: string): string {
  return text.replace(CJK_RUN, (run) => {
    const chars = [...run]
    if (chars.length === 1) return run
    const grams = chars.slice(0, -1).map((c, i) => `${c}${chars[i + 1]}`)
    return ` ${grams.join(' ')} `
  })
}

// The distinct searchable tokens of a line: shingled, lowercased, split on
// anything that is not a letter or digit (which keeps a CJK bigram whole).
export function queryTokens(text: string): string[] {
  return [
    ...new Set(
      shingle(text)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 0),
    ),
  ]
}

export type IndexRow = { ts: number; role: RecallRole; text: string }

export type SearchOptions = {
  now: number
  limit: number
  // Rows at or after this timestamp are already in the transcript the model is
  // reading, so recalling them says nothing new (spec 05-01 §3.4). Compared by
  // ts, never by text.
  excludeFromTs: number
}

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0)
const asText = (value: unknown): string => (typeof value === 'string' ? value : '')
const asRole = (value: unknown): RecallRole =>
  value === 'user' || value === 'faded' ? value : 'radio'

export class RecallIndex {
  private db: DatabaseSync
  private insert: StatementSync

  constructor(path: string, log: (message: string) => void = () => {}) {
    this.db = this.open(path, log)
    this.db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS recall_rows USING ' +
        'fts5(body, ts UNINDEXED, role UNINDEXED, text UNINDEXED)',
    )
    this.insert = this.db.prepare('INSERT INTO recall_rows(body, ts, role, text) VALUES (?, ?, ?, ?)')
  }

  // A file that is not a database is not a crash: the index is derived, so the
  // repair is to throw it away and let the caller rebuild.
  private open(path: string, log: (message: string) => void): DatabaseSync {
    try {
      const db = new (sqlite().DatabaseSync)(path)
      db.exec('PRAGMA user_version')
      return db
    } catch (err) {
      log(`memory: recall index unreadable, rebuilding (${String(err)})`)
      rmSync(path, { force: true })
      return new (sqlite().DatabaseSync)(path)
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM recall_rows').get()
    return asNumber(row?.['n'])
  }

  add(row: IndexRow): void {
    this.insert.run(shingle(row.text), row.ts, row.role, row.text)
  }

  rebuild(rows: readonly IndexRow[]): void {
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM recall_rows')
      for (const row of rows) this.add(row)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }

  // One FTS match, one sort. The SQL stays a plain OR-of-tokens so the ranking
  // is readable — and testable — in TypeScript.
  search(query: string, opts: SearchOptions): RecallHit[] {
    const tokens = queryTokens(query)
    if (tokens.length === 0) return []
    const match = tokens.map((t) => `"${t.replaceAll('"', '')}"`).join(' OR ')
    // SQLite has no Infinity: an absent window means "nothing is excluded".
    const cutoff = Number.isFinite(opts.excludeFromTs) ? opts.excludeFromTs : Number.MAX_SAFE_INTEGER
    const rows = this.db
      .prepare(
        'SELECT ts, role, text, bm25(recall_rows) AS bm FROM recall_rows ' +
          'WHERE recall_rows MATCH ? AND ts < ? ORDER BY bm LIMIT ?',
      )
      // The exclusion belongs INSIDE the candidate cut: a listener who has just
      // been talking about the topic fills the whole bm25 budget with rows the
      // model can already see, and the older memory never surfaces.
      .all(match, cutoff, RECALL_CANDIDATES)
    return rows
      .map((row) => {
        const ts = asNumber(row['ts'])
        const role = asRole(row['role'])
        // bm25 is negative-is-better, so negate before weighting.
        const relevance = -asNumber(row['bm'])
        const source = role === 'user' ? RECALL_USER_BOOST : 1
        const ageDays = Math.max(0, (opts.now - ts) / 86400)
        const recency = Math.max(RECENCY_FLOOR, 0.5 ** (ageDays / RECALL_HALF_LIFE_DAYS))
        return { ts, role, text: asText(row['text']), score: relevance * source * recency }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit)
  }
}
