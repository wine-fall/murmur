// The fold's input and the profile's clock (spec 05-01 §3.1-§3.3): what the
// compaction slice is allowed to see, which listener turns count, and how a
// fact acquires a date and eventually fades out of the prompts.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  FACT_FADE_DAYS,
  PersistentMemoryStore,
  admitsToFold,
  fadeFacts,
  stampDates,
} from '../src/memory.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'murmur-fold-'))

// Unix seconds for a UTC date, so every dated assertion is clock-injected.
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000

function clock(start: number) {
  let t = start
  return { now: () => t, advance: (s: number) => (t += s) }
}

describe('admission gate (spec 05-01 §3.2)', () => {
  it('drops slash commands, keeps ordinary speech', () => {
    expect(admitsToFold('/settings', false)).toBe(false)
    expect(admitsToFold('/done', false)).toBe(false)
    expect(admitsToFold('settings feel too loud lately', false)).toBe(true)
  })

  it('drops lines of two characters or less, and acknowledgements', () => {
    expect(admitsToFold('ok', false)).toBe(false)
    expect(admitsToFold('  a ', false)).toBe(false)
    expect(admitsToFold('thanks', false)).toBe(false)
    expect(admitsToFold('Continue', false)).toBe(false)
    expect(admitsToFold('thanks for the pick, it suited the hour', false)).toBe(true)
  })

  it('drops a short steered line but keeps a long one', () => {
    expect(admitsToFold('next song', true)).toBe(false)
    expect(admitsToFold("skip this, I can't do saxophone tonight", true)).toBe(true)
    // The same short line unsteered is just speech, and it stays.
    expect(admitsToFold('next song', false)).toBe(true)
  })
})

describe('compaction slice is listener-only (spec 05-01 §3.1)', () => {
  it('emits each admitted listener turn with the host line it answered', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    const store = new PersistentMemoryStore({ dir: path, now: c.now, compactEvery: 3 })
    for (let i = 0; i < 40; i++) {
      store.record({ role: 'radio', text: `beat ${i}` })
      if (i === 10 || i === 20 || i === 30) {
        store.record({ role: 'user', text: `a real thing I said, number ${i}` })
      }
    }
    const slice = store.compactionSlice()
    expect(slice.turns.map((t) => t.text)).toEqual([
      'beat 10',
      'a real thing I said, number 10',
      'beat 20',
      'a real thing I said, number 20',
      'beat 30',
      'a real thing I said, number 30',
    ])
    // The watermark still covers the whole tail, monologue included, so the
    // host rows after the last listener turn are never re-scanned.
    expect(slice.throughTs).toBeGreaterThan(0)
    const all = readFileSync(join(path, 'history.jsonl'), 'utf-8').trim().split('\n')
    const lastTs: number = JSON.parse(all.at(-1)!).ts
    expect(slice.throughTs).toBe(lastTs)
  })

  it('is empty, and never due, when the listener never typed', () => {
    const c = clock(at('2026-09-01'))
    const store = new PersistentMemoryStore({ dir: dir(), now: c.now, compactEvery: 1 })
    for (let i = 0; i < 50; i++) store.record({ role: 'radio', text: `beat ${i}` })
    expect(store.compactionSlice().turns).toEqual([])
    expect(store.compactionDue()).toBe(false)
  })

  it('counts admitted listener turns, not turns, towards the threshold', () => {
    const c = clock(at('2026-09-01'))
    const store = new PersistentMemoryStore({ dir: dir(), now: c.now, compactEvery: 2 })
    store.record({ role: 'user', text: 'ok' })
    store.record({ role: 'user', text: '/settings' })
    store.record({ role: 'user', text: 'the rain has not let up all week' })
    expect(store.compactionDue()).toBe(false)
    store.record({ role: 'user', text: 'I moved the desk under the window' })
    expect(store.compactionDue()).toBe(true)
    expect(store.compactionSlice().turns.map((t) => t.role)).toEqual(['user', 'user'])
  })

  it('excludes a listener turn the reply already acted on', () => {
    const c = clock(at('2026-09-01'))
    const store = new PersistentMemoryStore({ dir: dir(), now: c.now, compactEvery: 1 })
    store.record({ role: 'user', text: 'next song' })
    store.markSteered()
    expect(store.compactionDue()).toBe(false)
    expect(store.compactionSlice().turns).toEqual([])
    // The row is still on disk — the gate decides what the profile learns
    // from, not what is recorded.
    expect(store.recent(5).map((t) => t.text)).toEqual(['next song'])
  })

  it('marks every line of a merged turn, not just the last one', () => {
    // A line typed while the reply is composing is merged into the SAME turn,
    // so both lines drove the action the reply took. Flagging only the newest
    // would leave the acted-on line admitted to the fold.
    const c = clock(at('2026-09-01'))
    const store = new PersistentMemoryStore({ dir: dir(), now: c.now, compactEvery: 1 })
    store.record({ role: 'user', text: 'next song' })
    store.record({ role: 'user', text: 'jazz maybe' })
    store.markSteered()
    expect(store.compactionSlice().turns).toEqual([])
    // The run stops at the host line before it: an earlier listener turn the
    // radio never acted on stays admitted.
    const other = new PersistentMemoryStore({ dir: dir(), now: c.now, compactEvery: 1 })
    other.record({ role: 'user', text: 'the rain has not let up all week' })
    other.record({ role: 'radio', text: 'a beat' })
    other.record({ role: 'user', text: 'next song' })
    other.markSteered()
    expect(other.compactionSlice().turns.map((t) => t.text)).toEqual([
      'the rain has not let up all week',
    ])
  })

  it('reloads the steered flag from disk, and loads rows written without it', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    const first = new PersistentMemoryStore({ dir: path, now: c.now, compactEvery: 1 })
    first.record({ role: 'user', text: 'next song' })
    first.markSteered()
    const reopened = new PersistentMemoryStore({ dir: path, now: c.now, compactEvery: 1 })
    expect(reopened.compactionSlice().turns).toEqual([])

    // An older murmur's row has no `steered` field at all.
    writeFileSync(
      join(path, 'history.jsonl'),
      `${JSON.stringify({ ts: at('2026-08-31'), role: 'user', text: 'the desk faces the window now' })}\n`,
    )
    const old = new PersistentMemoryStore({ dir: path, now: c.now, compactEvery: 1 })
    expect(old.compactionSlice().turns.map((t) => t.text)).toEqual([
      'the desk faces the window now',
    ])
  })
})

describe('date post-pass (spec 05-01 §3.3)', () => {
  it('stamps every undated fact line and leaves dated ones alone', () => {
    const text = [
      '(About the listener)',
      '- Works on a personal radio project [seen 2026-08-15]',
      '- Prefers tea',
      '',
      '(Relationship & style)',
      '- Replies in short lines [seen 2026-07-01] [stable]',
    ].join('\n')
    const stamped = stampDates(text, '2026-09-01')
    expect(stamped).toContain('- Works on a personal radio project [seen 2026-08-15]')
    expect(stamped).toContain('- Prefers tea [seen 2026-09-01]')
    expect(stamped).toContain('- Replies in short lines [seen 2026-07-01] [stable]')
    // Section headers and blank lines are not facts.
    expect(stamped).toContain('(About the listener)\n')
    expect(stamped).not.toContain('(About the listener) [seen')
  })
})

describe('fade pass (spec 05-01 §3.3)', () => {
  const profile = [
    '(About the listener)',
    '- Drinks coffee at night [seen 2026-01-01]',
    '- Name they go by: Z [seen 2026-01-01] [stable]',
    '- Moved the desk under the window [seen 2026-08-30]',
  ].join('\n')

  it('moves a stale line out verbatim and keeps a stable one of the same age', () => {
    const { live, faded } = fadeFacts(profile, at('2026-09-01'))
    expect(faded).toEqual(['- Drinks coffee at night [seen 2026-01-01]'])
    expect(live).toContain('- Name they go by: Z [seen 2026-01-01] [stable]')
    expect(live).toContain('- Moved the desk under the window [seen 2026-08-30]')
    expect(live).not.toContain('Drinks coffee')
  })

  it('keeps a line that is one day short of the fade horizon', () => {
    const justInside = at('2026-01-01') + (FACT_FADE_DAYS - 1) * 86400
    expect(fadeFacts(profile, justInside).faded).toEqual([])
  })

  it('writes the faded line to profile-faded.md and drops it from the profile', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    writeFileSync(join(path, 'profile.md'), profile)
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(store.profile()).not.toContain('Drinks coffee')
    expect(store.profile()).toContain('Name they go by: Z')
    expect(readFileSync(join(path, 'profile.md'), 'utf-8')).not.toContain('Drinks coffee')
    expect(readFileSync(join(path, 'profile-faded.md'), 'utf-8')).toContain(
      '- Drinks coffee at night [seen 2026-01-01]',
    )
  })

  it('dates and fades what the fold returns, before the profile is served', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    store.record({ role: 'user', text: 'something durable about the week' })
    store.applyCompaction(
      ['(About the listener)', '- Prefers tea', '- An ancient fact [seen 2025-01-01]'].join('\n'),
      store.compactionSlice().throughTs,
    )
    expect(store.profile()).toContain('- Prefers tea [seen 2026-09-01]')
    expect(store.profile()).not.toContain('An ancient fact')
    expect(readFileSync(join(path, 'profile-faded.md'), 'utf-8')).toContain('An ancient fact')
  })
})

describe('PersistentMemoryStore.recall (spec 05-01 §3.4)', () => {
  it('builds the index from the files, and rebuilds it after it is deleted', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    const first = new PersistentMemoryStore({ dir: path, now: c.now })
    first.record({ role: 'user', text: 'the lantern on the balcony finally works' })
    c.advance(40 * 86400)

    const before = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(before.recall('lantern', 5).map((h) => h.text)).toEqual([
      'the lantern on the balcony finally works',
    ])
    rmSync(join(path, 'index.db'))
    const after = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(after.recall('lantern', 5).map((h) => h.text)).toEqual([
      'the lantern on the balcony finally works',
    ])
  })

  it('rebuilds when the index disagrees with the source, and excludes the recent window', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    const first = new PersistentMemoryStore({ dir: path, now: c.now })
    first.record({ role: 'user', text: 'the lantern on the balcony finally works' })
    first.recall('anything', 5) // builds index.db at one row

    // A second run appends without ever touching the index, then a third finds
    // the count disagreeing and rebuilds from the JSONL.
    const second = new PersistentMemoryStore({ dir: path, now: c.now })
    second.record({ role: 'user', text: 'the second lantern is brighter' })
    c.advance(40 * 86400)
    const third = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(third.recall('lantern', 5).length).toBe(2)

    // A row the transcript already shows is not a memory.
    third.record({ role: 'user', text: 'a third lantern, just now' })
    expect(third.recall('lantern', 5, 1).length).toBe(2)
  })

  it('recalls a faded profile fact, labelled as faded', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    writeFileSync(
      join(path, 'profile.md'),
      '(About the listener)\n- Drinks coffee at night [seen 2026-01-01]',
    )
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    const hits = store.recall('coffee', 5)
    expect(hits.length).toBe(1)
    expect(hits[0]!.role).toBe('faded')
    expect(hits[0]!.text).toContain('Drinks coffee at night')
  })
})

describe('PersistentMemoryStore.forget (spec 05-01 §3.5)', () => {
  const build = () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    writeFileSync(
      join(path, 'profile.md'),
      [
        '(About the listener)',
        '- Drinks coffee at night [seen 2026-08-30]',
        '- Moved the desk under the window [seen 2026-08-30]',
      ].join('\n'),
    )
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    store.record({ role: 'user', text: 'I drink coffee until far too late' })
    store.record({ role: 'radio', text: 'the desk under the window sounds good' })
    return { store, path, c }
  }

  it('removes the rows and the lines, physically, and stops recalling them', () => {
    const { store, path, c } = build()
    const removed = store.forget('coffee')
    expect(removed.rows).toBe(1)
    expect(removed.lines).toBe(1)
    expect(readFileSync(join(path, 'history.jsonl'), 'utf-8')).not.toContain('coffee')
    expect(readFileSync(join(path, 'profile.md'), 'utf-8')).not.toContain('coffee')
    expect(store.profile()).not.toContain('coffee')
    expect(store.profile()).toContain('desk under the window')
    expect(store.recall('coffee', 5)).toEqual([])
    // The in-memory window is filtered too, so the very next pack is clean.
    expect(store.recent(10).map((t) => t.text)).toEqual([
      'the desk under the window sounds good',
    ])
    // A survivor is still there after a reload. The reopen reads the same clock
    // the rows were written on: on the real one, the 48h recent window drops
    // them for age, and the test goes red on a calendar day, not a regression.
    const reopened = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(reopened.recent(10).length).toBe(1)
  })

  it('notes one forget in the ledger, carrying no text', () => {
    const { store, path } = build()
    store.forget('coffee')
    const ledger = readFileSync(join(path, 'ledger.jsonl'), 'utf-8')
    expect(ledger).toContain('"kind":"forget"')
    expect(ledger).not.toContain('coffee')
  })

  it('changes nothing, and reports zeros, when there is nothing to forget', () => {
    const { store, path } = build()
    const history = readFileSync(join(path, 'history.jsonl'), 'utf-8')
    expect(store.forget('zzz')).toEqual({ rows: 0, lines: 0 })
    expect(readFileSync(join(path, 'history.jsonl'), 'utf-8')).toBe(history)
    expect(store.profile()).toContain('coffee')
  })

  it('needs more than one common word to match, so a phrase does not over-forget', () => {
    const { store } = build()
    // "the" and "about" are stop words; "coffee" is the only real token, and a
    // single-token request is honoured.
    expect(store.forget('the coffee thing').rows).toBe(1)
  })
})

// Findings from the closing review, each pinned so it cannot come back.
describe('forget is actually forgetting (spec 05-01 §3.5)', () => {
  const seeded = (rows: string[]) => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    for (const text of rows) store.record({ role: 'user', text })
    return { store, path, c }
  }

  it('takes the erased text out of the derived index too, even when it was never built', () => {
    // Session 1 recalls, so index.db exists on disk carrying the row verbatim.
    const { store, path, c } = seeded(['my friend Sarah moved to Lisbon last spring'])
    expect(store.recall('Sarah', 5).length).toBe(1)
    expect(existsSync(join(path, 'index.db'))).toBe(true)

    // Session 2 forgets without ever recalling — the index is not open here.
    const later = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(later.forget('Sarah').rows).toBe(1)
    const raw = existsSync(join(path, 'index.db'))
      ? readFileSync(join(path, 'index.db')).toString('latin1')
      : ''
    expect(raw).not.toContain('Sarah')

    // Refilling to the same row count must not resurrect it either: a bare
    // count check would see the numbers agree and skip the rebuild.
    later.record({ role: 'user', text: 'the kettle is on' })
    expect(later.recall('Sarah', 5)).toEqual([])
  })

  it('matches whole words, not substrings, so one token cannot take the room with it', () => {
    const { store } = seeded([
      'my ex still has the good saucepan',
      'I am exhausted, that meeting ran long',
      'the next street over has a bakery',
      'that is exactly the sound I meant',
    ])
    expect(store.forget('the ex thing')).toEqual({ rows: 1, lines: 0 })
    expect(store.recent(10).map((t) => t.text)).toEqual([
      'I am exhausted, that meeting ran long',
      'the next street over has a bakery',
      'that is exactly the sound I meant',
    ])
  })

  it('does not count the asking itself, so "nothing to forget" can actually happen', () => {
    // The listener's request is recorded as a turn before the reply turn runs,
    // and it always carries its own words. Counting it would make the radio
    // claim it forgot something every single time.
    const { store } = seeded(['the kettle is on', 'please forget everything about kayaking'])
    expect(store.forget('everything about kayaking', 1)).toEqual({ rows: 0, lines: 0 })
    // It is still removed — the asking can carry the very detail being erased.
    expect(store.recent(10).map((t) => t.text)).toEqual(['the kettle is on'])
  })
})

describe('recall excludes what the model can already see (spec 05-01 §3.4)', () => {
  it('excludes only the trailing turns the transcript renders, not the whole window', () => {
    const c = clock(at('2026-09-01'))
    const store = new PersistentMemoryStore({ dir: dir(), now: c.now })
    for (let i = 0; i < 30; i++) {
      c.advance(600)
      store.record({ role: 'user', text: `the coffee roastery, note ${i}` })
    }
    // The reply prompt renders 12 turns; everything older is a memory.
    expect(store.recall('roastery', 5, 12).length).toBe(5)
    expect(store.recall('roastery', 50, 12).length).toBe(18)
    // No transcript at all -> nothing is excluded.
    expect(store.recall('roastery', 50, 0).length).toBe(30)
  })
})

// Findings from the codex peer review (PR #196), each pinned.
describe('forget beats a fold that is already in flight (spec 05-01 §3.5)', () => {
  it('refuses a compaction whose slice predates the forget', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    writeFileSync(join(path, 'profile.md'), '(About the listener)\n- Likes the quiet hour [seen 2026-08-30]')
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    store.record({ role: 'user', text: 'my friend Sarah moved to Lisbon last spring' })

    // The fold reads its slice, then waits on the model...
    const slice = store.compactionSlice()
    // ...and the listener asks to forget while it waits.
    expect(store.forget('Sarah').rows).toBe(1)
    // The fold comes back holding a profile derived from what is now erased.
    store.applyCompaction('(About the listener)\n- Friend Sarah, in Lisbon', slice.throughTs)

    expect(store.profile()).not.toContain('Sarah')
    expect(readFileSync(join(path, 'profile.md'), 'utf-8')).not.toContain('Sarah')
    // A fold started AFTER the forget still applies normally.
    const fresh = store.compactionSlice()
    store.applyCompaction('(About the listener)\n- Likes tea', fresh.throughTs)
    expect(store.profile()).toContain('Likes tea')
  })
})

describe('forget leaves nothing behind in the index (spec 05-01 §3.5)', () => {
  it('erases the bytes, not just the rows, when the index is open', () => {
    const c = clock(at('2026-09-01'))
    const path = dir()
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    store.record({ role: 'user', text: 'my friend Sarah moved to Lisbon last spring' })
    expect(store.recall('Sarah', 5).length).toBe(1)

    expect(store.forget('Sarah').rows).toBe(1)
    // A DELETE leaves the row's bytes on SQLite's freelist, so the text is
    // still in the file — a physical-delete promise that only removes the
    // index entry is not one.
    const raw = existsSync(join(path, 'index.db'))
      ? readFileSync(join(path, 'index.db')).toString('latin1')
      : ''
    expect(raw).not.toContain('Sarah')
    expect(raw).not.toContain('Lisbon')
    expect(store.recall('Sarah', 5)).toEqual([])
    // And the index still works afterwards.
    store.record({ role: 'user', text: 'the kettle is on' })
    expect(store.recall('kettle', 5).length).toBe(1)
  })
})

describe('recall on a short history (spec 05-01 §3.4)', () => {
  it('excludes every visible turn when the window is not full yet', () => {
    // A fresh install: fewer turns exist than the transcript renders, so
    // "the oldest of the last 12" does not exist. Excluding nothing would hand
    // the listener their own question back as a memory.
    const c = clock(at('2026-09-01'))
    const store = new PersistentMemoryStore({ dir: dir(), now: c.now })
    store.record({ role: 'radio', text: 'a quiet hour' })
    store.record({ role: 'user', text: 'do you remember the lantern?' })
    expect(store.recall('lantern', 5, 12)).toEqual([])
  })
})

describe('dating covers prose profiles, not only bullets (spec 05-01 §3.3)', () => {
  const prose = ['(About the listener)', 'A night owl who codes late.', '', '(Relationship & style)', 'Short replies land best.'].join('\n')

  it('stamps a bootstrapped profile written as plain prose', () => {
    const stamped = stampDates(prose, '2026-09-01')
    expect(stamped).toContain('A night owl who codes late. [seen 2026-09-01]')
    expect(stamped).toContain('Short replies land best. [seen 2026-09-01]')
    // Section headers are still not facts.
    expect(stamped).toContain('(About the listener)\n')
    expect(stamped).not.toContain('(About the listener) [seen')
    expect(stamped).not.toContain('(Relationship & style) [seen')
  })

  it('fades a prose fact like any other', () => {
    const old = '(About the listener)\nDrinks coffee at night [seen 2026-01-01]'
    expect(fadeFacts(old, at('2026-09-01')).faded).toEqual([
      'Drinks coffee at night [seen 2026-01-01]',
    ])
  })
})
