import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory.ts'

describe('InProcessMemoryStore', () => {
  it('returns the last n turns oldest-first', () => {
    const store = new InProcessMemoryStore()
    store.record({ role: 'radio', text: 'a' })
    store.record({ role: 'user', text: 'b' })
    store.record({ role: 'radio', text: 'c' })
    expect(store.recent(2).map((t) => t.text)).toEqual(['b', 'c'])
    expect(store.recent(10).map((t) => t.text)).toEqual(['a', 'b', 'c'])
  })

  it('returns empty for non-positive n', () => {
    const store = new InProcessMemoryStore()
    store.record({ role: 'radio', text: 'a' })
    expect(store.recent(0)).toEqual([])
    expect(store.recent(-1)).toEqual([])
  })

  it('bounds retained history to maxlen', () => {
    const store = new InProcessMemoryStore(3)
    for (const text of ['1', '2', '3', '4', '5']) store.record({ role: 'radio', text })
    expect(store.recent(10).map((t) => t.text)).toEqual(['3', '4', '5'])
  })

  it('starts with an empty profile and empty ledger views', () => {
    const store = new InProcessMemoryStore()
    expect(store.profile()).toBe('')
    expect(store.recentTopics(5)).toEqual([])
    expect(store.recentSongs(5)).toEqual([])
  })

  it('routes ledger events by kind, tails in order', () => {
    const store = new InProcessMemoryStore()
    store.recordEvent('topic', 'night walks')
    store.recordEvent('song', 'A — B')
    store.recordEvent('topic', 'coffee')
    store.recordEvent('topic', 'rain')
    expect(store.recentTopics(2)).toEqual(['coffee', 'rain'])
    expect(store.recentTopics(9)).toEqual(['night walks', 'coffee', 'rain'])
    expect(store.recentSongs(9)).toEqual(['A — B'])
    expect(store.recentTopics(0)).toEqual([])
  })
})

const dir = () => mkdtempSync(join(tmpdir(), 'murmur-mem-'))

// An injectable, steppable clock (unix seconds) — tests never touch wall time.
function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (s: number) => (t += s),
  }
}

const opened = (path: string, c: { now: () => number }, extra: object = {}) =>
  new PersistentMemoryStore({ dir: path, now: c.now, ...extra })

describe('PersistentMemoryStore', () => {
  it('round-trips turns across instances, oldest-first, merging new records', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.record({ role: 'radio', text: 'one' })
    a.record({ role: 'user', text: 'two' })

    const b = opened(path, c)
    b.record({ role: 'radio', text: 'three' })
    expect(b.recent(10).map((t) => t.text)).toEqual(['one', 'two', 'three'])
    expect(b.recent(10)[1]).toEqual({ role: 'user', text: 'two' })
  })

  it('does not prime turns older than the freshness cutoff', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.record({ role: 'radio', text: 'stale' })
    c.advance(49 * 3600)
    const b = opened(path, c)
    b.record({ role: 'radio', text: 'fresh' })
    expect(b.recent(10).map((t) => t.text)).toEqual(['fresh'])
  })

  it('persists ledger events across instances, tails in order', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.recordEvent('topic', 'rain')
    a.recordEvent('song', 'X — Y')
    a.recordEvent('topic', 'coffee')

    const b = opened(path, c)
    expect(b.recentTopics(10)).toEqual(['rain', 'coffee'])
    expect(b.recentTopics(1)).toEqual(['coffee'])
    expect(b.recentSongs(10)).toEqual(['X — Y'])
  })

  it('skips corrupt jsonl lines and malformed rows, warns, and keeps booting', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.record({ role: 'radio', text: 'good' })
    a.recordEvent('topic', 'kept')
    appendFileSync(join(path, 'history.jsonl'), '{"ts": 1, "role": "radio", "te\n')
    appendFileSync(join(path, 'history.jsonl'), '{"ts": "nope", "role": "radio", "text": "bad"}\n')
    appendFileSync(join(path, 'ledger.jsonl'), 'garbage\n')

    const warnings: string[] = []
    const b = opened(path, c, { log: (m: string) => warnings.push(m) })
    expect(b.recent(10).map((t) => t.text)).toEqual(['good'])
    expect(b.recentTopics(10)).toEqual(['kept'])
    expect(warnings.length).toBe(3)
  })

  it('treats an unreadable meta.json as never compacted', () => {
    const c = clock()
    const path = dir()
    opened(path, c).record({ role: 'radio', text: 'a' })
    writeFileSync(join(path, 'meta.json'), 'not json')
    const warnings: string[] = []
    const b = opened(path, c, { log: (m: string) => warnings.push(m) })
    expect(b.compactionSlice().turns.map((t) => t.text)).toEqual(['a'])
    expect(warnings.length).toBe(1)
  })

  it('reads an existing profile and reports compaction due at the threshold', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c, { compactEvery: 3 })
    expect(a.profile()).toBe('')
    expect(a.compactionDue()).toBe(false)
    a.record({ role: 'radio', text: '1' })
    a.record({ role: 'user', text: '2' })
    expect(a.compactionDue()).toBe(false)
    a.record({ role: 'radio', text: '3' })
    expect(a.compactionDue()).toBe(true)
  })

  it('applyCompaction writes profile.md + advances the watermark exactly to throughTs', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c, { compactEvery: 2 })
    a.record({ role: 'radio', text: 'early-1' })
    a.record({ role: 'user', text: 'early-2' })
    const slice = a.compactionSlice()
    expect(slice.turns.map((t) => t.text)).toEqual(['early-1', 'early-2'])

    // The fold races record(): a turn lands while the Brain is folding.
    a.record({ role: 'radio', text: 'during-fold' })
    a.applyCompaction('the profile', slice.throughTs)

    expect(a.profile()).toBe('the profile')
    expect(readFileSync(join(path, 'profile.md'), 'utf-8')).toBe('the profile')
    // The mid-fold turn stays in the next backlog — on this instance and after
    // a reload (the watermark on disk is exactly throughTs).
    expect(a.compactionSlice().turns.map((t) => t.text)).toEqual(['during-fold'])
    const b = opened(path, c)
    expect(b.profile()).toBe('the profile')
    expect(b.compactionSlice().turns.map((t) => t.text)).toEqual(['during-fold'])
  })
})

// spec 06 §2.4: the profile write-through the bootstrap uses. Impl-level and
// deliberately off the MemoryStore contract — the Director never writes it.
describe('PersistentMemoryStore.writeProfile (spec 06 §2.4)', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'murmur-writeprofile-'))

  it('writes the profile atomically and serves it back, surviving a reload', () => {
    const dir = tmp()
    const store = new PersistentMemoryStore({ dir })
    expect(store.profile()).toBe('')
    store.writeProfile('(About the listener)\nships TypeScript at night')
    expect(store.profile()).toContain('ships TypeScript')
    expect(readFileSync(join(dir, 'profile.md'), 'utf-8')).toContain('ships TypeScript')
    expect(new PersistentMemoryStore({ dir }).profile()).toContain('ships TypeScript')
  })

  it('leaves the compaction watermark alone (it consumed no backlog)', () => {
    const dir = tmp()
    const store = new PersistentMemoryStore({ dir })
    store.record({ role: 'user', text: 'hello' })
    store.writeProfile('bootstrapped')
    // The turn is still owed to compaction: a bootstrap is not a fold.
    expect(store.compactionSlice().turns.map((t) => t.text)).toEqual(['hello'])
    expect(store.compactionSlice().profile).toBe('bootstrapped')
  })
})
