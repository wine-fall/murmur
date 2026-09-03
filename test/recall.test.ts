// The derived recall index (spec 05-01 §3.4): CJK-aware shingling so a
// two-character word is findable at all, a plain FTS5 match, and the rerank
// that decides which of the matches is worth handing the model.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RecallIndex, shingle } from '../src/recall.ts'

// CJK fixtures are written as escapes, not characters: DESIGN §0 bars CJK from
// every source file, and a tokenizer test needs the codepoints themselves.
const COFFEE = '\u5496\u5561' // two Han characters, one word
const EVENING_SKY = '\u508d\u665a\u7684\u5929\u7a7a' // five Han characters

const dir = () => mkdtempSync(join(tmpdir(), 'murmur-recall-'))
const DAY = 86400
const NOW = Date.parse('2026-09-01T12:00:00Z') / 1000

const index = (path = dir()) => new RecallIndex(join(path, 'index.db'), () => {})

describe('shingle (spec 05-01 §3.4)', () => {
  it('leaves Latin text untouched', () => {
    expect(shingle('a quiet evening')).toBe('a quiet evening')
  })

  it('turns a run of Han characters into its character bigrams', () => {
    const chars = [...EVENING_SKY]
    expect(shingle(EVENING_SKY).trim().split(/\s+/)).toEqual(
      chars.slice(0, -1).map((c, i) => c + chars[i + 1]),
    )
  })

  it('leaves a single character alone and keeps the Latin half of a mixed line', () => {
    expect(shingle('ok \u597d').trim()).toBe('ok \u597d')
    expect(shingle(`I drink ${COFFEE} daily`)).toContain('I drink ')
    expect(shingle(`I drink ${COFFEE} daily`)).toContain('daily')
  })
})

describe('RecallIndex search (spec 05-01 §3.4)', () => {
  const rows = [
    { ts: NOW - 30 * DAY, role: 'user' as const, text: `I stopped drinking ${COFFEE} at night` },
    { ts: NOW - 20 * DAY, role: 'radio' as const, text: `the ${EVENING_SKY} went orange tonight` },
    { ts: NOW - 10 * DAY, role: 'user' as const, text: 'the radio project is nearly done' },
  ]

  const built = () => {
    const ix = index()
    ix.rebuild(rows)
    return ix
  }

  it('finds a row by a two-character CJK word', () => {
    const hits = built().search(COFFEE, { now: NOW, limit: 5, excludeFromTs: Infinity })
    expect(hits.map((h) => h.text)).toEqual([rows[0]!.text])
    expect(hits[0]!.role).toBe('user')
    expect(hits[0]!.ts).toBe(rows[0]!.ts)
  })

  it('finds a row by a Latin word, and ranks the row itself first for its own text', () => {
    const ix = built()
    expect(ix.search('project', { now: NOW, limit: 5, excludeFromTs: Infinity })[0]!.text).toBe(
      rows[2]!.text,
    )
    const self = ix.search(rows[1]!.text, { now: NOW, limit: 5, excludeFromTs: Infinity })
    expect(self[0]!.text).toBe(rows[1]!.text)
  })

  it('returns nothing for a query with no tokens, and nothing for a miss', () => {
    const ix = built()
    expect(ix.search('   ', { now: NOW, limit: 5, excludeFromTs: Infinity })).toEqual([])
    expect(ix.search('trombone', { now: NOW, limit: 5, excludeFromTs: Infinity })).toEqual([])
  })

  it('excludes rows already inside the recent window', () => {
    const ix = built()
    const hits = ix.search('project', { now: NOW, limit: 5, excludeFromTs: NOW - 11 * DAY })
    expect(hits).toEqual([])
  })

  it('excludes before the candidate cut, so a fresh flurry cannot crowd out the memory', () => {
    // The listener has just been talking about the lantern: those rows score
    // best and would fill the whole bm25 candidate budget on their own.
    const ix = index()
    const old = { ts: NOW - 200 * DAY, role: 'user' as const, text: 'the lantern on the balcony' }
    ix.rebuild([
      old,
      ...Array.from({ length: 60 }, (_, i) => ({
        ts: NOW - i,
        role: 'user' as const,
        text: 'lantern',
      })),
    ])
    const hits = ix.search('lantern', { now: NOW, limit: 5, excludeFromTs: NOW - 100 * DAY })
    expect(hits.map((h) => h.text)).toEqual([old.text])
  })
})

describe('RecallIndex rerank (spec 05-01 §3.4)', () => {
  it('prefers the listener over the host when relevance ties', () => {
    const ix = index()
    ix.rebuild([
      { ts: NOW - DAY, role: 'radio', text: 'lantern' },
      { ts: NOW - DAY, role: 'user', text: 'lantern' },
    ])
    const hits = ix.search('lantern', { now: NOW, limit: 5, excludeFromTs: Infinity })
    expect(hits.map((h) => h.role)).toEqual(['user', 'radio'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('prefers the fresher of two equally relevant rows', () => {
    const ix = index()
    ix.rebuild([
      { ts: NOW - 60 * DAY, role: 'user', text: 'lantern' },
      { ts: NOW - DAY, role: 'user', text: 'lantern' },
    ])
    const hits = ix.search('lantern', { now: NOW, limit: 5, excludeFromTs: Infinity })
    expect(hits.map((h) => h.ts)).toEqual([NOW - DAY, NOW - 60 * DAY])
  })

  it('keeps a year-old exact hit in the result (the recency floor)', () => {
    const ix = index()
    ix.rebuild([{ ts: NOW - 365 * DAY, role: 'user', text: 'the lantern on the balcony' }])
    const hits = ix.search('lantern', { now: NOW, limit: 5, excludeFromTs: Infinity })
    expect(hits.length).toBe(1)
    expect(hits[0]!.score).toBeGreaterThan(0)
  })

  it('honours the limit', () => {
    const ix = index()
    ix.rebuild(
      Array.from({ length: 9 }, (_, i) => ({
        ts: NOW - i * DAY,
        role: 'user' as const,
        text: `lantern number ${i}`,
      })),
    )
    expect(ix.search('lantern', { now: NOW, limit: 3, excludeFromTs: Infinity }).length).toBe(3)
  })
})

describe('RecallIndex is derived and disposable (spec 05-01 §3.4)', () => {
  it('reopens an existing db without rebuilding, and reports its row count', () => {
    const path = dir()
    const first = index(path)
    first.rebuild([{ ts: NOW, role: 'user', text: 'a lantern' }])
    first.close()
    const second = index(path)
    expect(second.count()).toBe(1)
    expect(second.search('lantern', { now: NOW, limit: 5, excludeFromTs: Infinity }).length).toBe(1)
  })

  it('starts empty again when the file is deleted', () => {
    const path = dir()
    const first = index(path)
    first.rebuild([{ ts: NOW, role: 'user', text: 'a lantern' }])
    first.close()
    rmSync(join(path, 'index.db'))
    expect(index(path).count()).toBe(0)
  })

  it('replaces a corrupt db instead of failing to open, with one log line', () => {
    const path = dir()
    writeFileSync(join(path, 'index.db'), 'this is not a database')
    const logged: string[] = []
    const ix = new RecallIndex(join(path, 'index.db'), (m) => logged.push(m))
    ix.rebuild([{ ts: NOW, role: 'user', text: 'a lantern' }])
    expect(ix.count()).toBe(1)
    expect(logged.length).toBe(1)
  })
})
