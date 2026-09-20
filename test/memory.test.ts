import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory/memory.ts'

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

  // spec 13 §3.7: a real-world item told on air is a ledger footprint of its
  // own kind — the pool forgets in 48 h, the ledger does not.
  it('keeps real-world topics as their own kind', () => {
    const store = new InProcessMemoryStore()
    store.recordEvent('rwt', 'Typhoon season opens early')
    store.recordEvent('topic', 'rain')
    store.recordEvent('rwt', 'A late equaliser at Anfield')
    expect(store.recentRwt(1)).toEqual(['A late equaliser at Anfield'])
    expect(store.recentRwt(9)).toEqual(['Typhoon season opens early', 'A late equaliser at Anfield'])
    expect(store.recentTopics(9)).toEqual(['rain'])
    expect(store.recentRwt(0)).toEqual([])
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

  // spec 05 §3.4: a boot inside the same sitting carries on from the turns on
  // disk; past the sitting gap the program is coming back on and the window
  // starts empty, so the first line cannot finish the last one's sentence.
  it('primes the turns on disk when the boot is inside the same sitting', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.record({ role: 'radio', text: 'before' })
    c.advance(10 * 60)
    const b = opened(path, c)
    expect(b.recent(10).map((t) => t.text)).toEqual(['before'])
    expect(b.lastOnAir()).toBeUndefined()
  })

  it('primes nothing once the sitting gap has passed, and reports the last airing', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.recordEvent('topic', 'the first one')
    a.recordEvent('topic', 'rain')
    a.recordEvent('topic', 'night walks')
    a.recordEvent('topic', 'coffee')
    a.record({ role: 'radio', text: 'stale' })
    const lastTs = c.now()

    c.advance(2 * 3600)
    const b = opened(path, c)
    expect(b.recent(10)).toEqual([])
    // The row stamps drift a millisecond apart so each append sorts after the
    // last; the fact is the moment, not the exact stamp.
    expect(b.lastOnAir()?.ts).toBeCloseTo(lastTs, 1)
    expect(b.lastOnAir()?.topics).toEqual(['rain', 'night walks', 'coffee'])
    // What the session records afterwards does not move the fact it opened with.
    b.record({ role: 'radio', text: 'fresh' })
    b.recordEvent('topic', 'the new one')
    expect(b.lastOnAir()?.topics).toEqual(['rain', 'night walks', 'coffee'])
    expect(b.recent(10).map((t) => t.text)).toEqual(['fresh'])
  })

  // codex review: a boot inside the sitting gap used to prime the WHOLE file.
  // One line aired after a week away, then a restart ten minutes later, and the
  // week-old sitting came back as "the program so far" — the bug this change
  // exists to kill, wearing a short gap.
  it('primes the last sitting only, never the one before the gap', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.record({ role: 'radio', text: 'a week ago' })

    c.advance(7 * 86_400)
    const b = opened(path, c)
    b.record({ role: 'radio', text: 'the one line tonight' })

    c.advance(10 * 60)
    const back = opened(path, c)
    expect(back.recent(10).map((t) => t.text)).toEqual(['the one line tonight'])
    expect(back.lastOnAir()).toBeUndefined()
  })

  // codex review: the topics are what the LAST sitting touched. A ledger tail
  // reaching back past the gap would report a month-old topic as yesterday's.
  it('reports only the topics of the sitting it came back from', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.recordEvent('topic', 'a month ago')
    a.record({ role: 'radio', text: 'long gone' })

    c.advance(30 * 86_400)
    const b = opened(path, c)
    b.recordEvent('topic', 'last night')
    b.record({ role: 'radio', text: 'yesterday' })

    c.advance(22 * 3600)
    expect(opened(path, c).lastOnAir()?.topics).toEqual(['last night'])
  })

  // codex review: the opening fact is a COPY of the ledger keys, so a forget
  // that cleaned the store alone would hand the deleted words back to the model.
  it('drops forgotten words from the opening fact it is already holding', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.recordEvent('topic', 'the hospital week')
    a.recordEvent('topic', 'rain')
    a.record({ role: 'radio', text: 'about the hospital week' })

    c.advance(2 * 3600)
    const back = opened(path, c)
    expect(back.lastOnAir()?.topics).toEqual(['the hospital week', 'rain'])
    back.forget('hospital')
    expect(back.lastOnAir()?.topics).toEqual(['rain'])
  })

  it('has no last airing to report on a memory dir with no history', () => {
    expect(opened(dir(), clock()).lastOnAir()).toBeUndefined()
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

  it('persists real-world topics across instances and sessions (spec 13 §3.7)', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c)
    a.recordEvent('rwt', 'Typhoon season opens early')
    a.recordEvent('topic', 'rain')
    const b = opened(path, c)
    expect(b.recentRwt(10)).toEqual(['Typhoon season opens early'])
    expect(b.recentTopics(10)).toEqual(['rain'])
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
    opened(path, c).record({ role: 'user', text: 'a thing worth folding' })
    writeFileSync(join(path, 'meta.json'), 'not json')
    const warnings: string[] = []
    const b = opened(path, c, { log: (m: string) => warnings.push(m) })
    expect(b.compactionSlice().turns.map((t) => t.text)).toEqual(['a thing worth folding'])
    expect(warnings.length).toBe(1)
  })

  it('reads an existing profile and reports compaction due at the threshold', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c, { compactEvery: 3 })
    expect(a.profile()).toBe('')
    expect(a.compactionDue()).toBe(false)
    a.record({ role: 'radio', text: 'a beat nobody answered' })
    a.record({ role: 'user', text: 'the first thing I said' })
    expect(a.compactionDue()).toBe(false)
    a.record({ role: 'user', text: 'the second thing I said' })
    a.record({ role: 'user', text: 'the third thing I said' })
    expect(a.compactionDue()).toBe(true)
  })

  it('applyCompaction writes profile.md + advances the watermark exactly to throughTs', () => {
    const c = clock()
    const path = dir()
    const a = opened(path, c, { compactEvery: 2 })
    a.record({ role: 'radio', text: 'early-1' })
    a.record({ role: 'user', text: 'early-2, said by the listener' })
    const slice = a.compactionSlice()
    expect(slice.turns.map((t) => t.text)).toEqual(['early-1', 'early-2, said by the listener'])

    // The fold races record(): a turn lands while the Brain is folding.
    a.record({ role: 'user', text: 'during-fold' })
    const cite = slice.turns.find((t) => t.cite !== undefined)!.cite
    const folded = [
      '(About the listener)',
      `- the profile [src ${cite}]`,
      '',
      '(Relationship & style)',
    ].join('\n')
    expect(a.applyCompaction(folded, slice.throughTs)).toBe(true)

    // The fold's output is dated on the way in from the line it cites
    // (spec 05-01 §3.3), so the text round-trips tagged rather than verbatim.
    expect(a.profile()).toMatch(/- the profile \[src \d+\] \[seen \d{4}-\d{2}-\d{2}\]/)
    expect(readFileSync(join(path, 'profile.md'), 'utf-8')).toContain('- the profile [src ')
    // The mid-fold turn stays in the next backlog — on this instance and after
    // a reload (the watermark on disk is exactly throughTs).
    expect(a.compactionSlice().turns.map((t) => t.text)).toEqual(['during-fold'])
    const b = opened(path, c)
    expect(b.profile()).toContain('- the profile [src ')
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
    expect(store.compactionSlice().profile).toContain('bootstrapped [src bootstrap] [seen ')
  })
})

describe('PersistentMemoryStore.awaySeconds (spec 10 §3.7.3)', () => {
  it('reports how long since the last session, not since this one started', () => {
    const c = clock()
    const path = dir()
    const first = opened(path, c)
    first.record({ role: 'radio', text: 'goodnight' })

    c.advance(6 * 3600)
    const second = opened(path, c)
    expect(second.awaySeconds()).toBe(6 * 3600)
    // Recording inside the session must not move the absence it opened with:
    // "the pet acknowledges elapsed time" is a fact about the gap, once.
    c.advance(120)
    second.record({ role: 'radio', text: 'good morning' })
    expect(second.awaySeconds()).toBe(6 * 3600)
  })

  it('has no absence to report on a memory dir with no history', () => {
    expect(opened(dir(), clock()).awaySeconds()).toBeUndefined()
  })

  it('never reports a negative gap when the clock has moved backwards', () => {
    const c = clock()
    const path = dir()
    opened(path, c).record({ role: 'radio', text: 'from the future' })
    c.advance(-5000)
    expect(opened(path, c).awaySeconds()).toBe(0)
  })
})

// The avoid-list window (spec 05 §3.5): a listener hears repetition in time,
// not in track counts, so the ledger is read by age with a cap that only
// bounds the prompt. Real corpus: a song played on one afternoon came back the
// next day because 33 songs — one more than the old depth of 32 — sat between.
describe('recentSongsSince — the time-windowed avoid list', () => {
  const DAY = 86_400

  it('keeps what is inside the window and drops what fell out of it (in process)', () => {
    vi.useFakeTimers()
    try {
      const store = new InProcessMemoryStore()
      const now = 1_800_000_000
      vi.setSystemTime((now - 8 * DAY) * 1000)
      store.recordEvent('song', 'Eight Days Ago — Someone')
      vi.setSystemTime((now - 6 * DAY) * 1000)
      store.recordEvent('song', 'Six Days Ago — Someone')
      vi.setSystemTime(now * 1000)
      store.recordEvent('song', 'Today — Someone')

      expect(store.recentSongsSince(now - 7 * DAY, 256)).toEqual(['Six Days Ago — Someone', 'Today — Someone'])
      expect(store.recentSongs(9)).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the window at the newest entries, and returns nothing for a non-positive cap', () => {
    vi.useFakeTimers()
    try {
      const store = new InProcessMemoryStore()
      const now = 1_800_000_000
      vi.setSystemTime((now - DAY) * 1000)
      for (let i = 0; i < 5; i++) store.recordEvent('song', `Song ${String(i)}`)
      vi.setSystemTime(now * 1000)
      expect(store.recentSongsSince(now - 7 * DAY, 2)).toEqual(['Song 3', 'Song 4'])
      expect(store.recentSongsSince(now - 7 * DAY, 0)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads each row back at the time it was written, across instances', () => {
    const c = clock(1_800_000_000 - 9 * DAY)
    const path = dir()
    const a = opened(path, c)
    a.recordEvent('song', '\u534a\u58f6\u7eb1 — \u5218\u73c2\u77e3')
    c.advance(4 * DAY)
    a.recordEvent('song', 'Five Days Ago — Someone')
    c.advance(5 * DAY)

    // Reopened: the ages must survive the ledger round-trip, not restart at
    // load time — otherwise every song looks like it played just now.
    const b = opened(path, c)
    const now = c.now()
    expect(b.recentSongsSince(now - 7 * DAY, 256)).toEqual(['Five Days Ago — Someone'])
    expect(b.recentSongsSince(now - 10 * DAY, 256)).toEqual([
      '\u534a\u58f6\u7eb1 — \u5218\u73c2\u77e3',
      'Five Days Ago — Someone',
    ])
  })
})
