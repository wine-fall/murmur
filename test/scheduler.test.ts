import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory.ts'
import { anchorDay, LedgerScheduler } from '../src/scheduler.ts'

// Local wall-clock literals (no Z): the windows are local-hour buckets.
const at = (iso: string) => new Date(iso)

describe('anchorDay — the midnight rule (spec 07 §2.3)', () => {
  it('keys a wrapping night window by the date it OPENED', () => {
    expect(anchorDay('night', at('2026-07-03T23:10:00'))).toBe('2026-07-03')
    expect(anchorDay('night', at('2026-07-04T00:30:00'))).toBe('2026-07-03')
    expect(anchorDay('night', at('2026-07-04T22:05:00'))).toBe('2026-07-04')
  })

  it('is the plain local date for non-wrapping anchors', () => {
    expect(anchorDay('morning', at('2026-07-04T00:30:00'))).toBe('2026-07-04')
    expect(anchorDay('morning', at('2026-07-03T07:00:00'))).toBe('2026-07-03')
    expect(anchorDay('midday', at('2026-07-03T12:00:00'))).toBe('2026-07-03')
  })
})

describe('LedgerScheduler — windows (spec 07 §2.3, acceptance 8)', () => {
  const fresh = () => new LedgerScheduler(new InProcessMemoryStore())

  it('returns each anchor inside its window and null outside', () => {
    const s = fresh()
    expect(s.due(at('2026-07-03T06:00:00'))).toBe('morning')
    expect(s.due(at('2026-07-03T09:59:00'))).toBe('morning')
    expect(s.due(at('2026-07-03T11:30:00'))).toBe('midday')
    expect(s.due(at('2026-07-03T13:59:00'))).toBe('midday')
    expect(s.due(at('2026-07-03T22:00:00'))).toBe('night')
    expect(s.due(at('2026-07-04T00:59:00'))).toBe('night')
  })

  it('the window edges are exclusive at the top', () => {
    const s = fresh()
    expect(s.due(at('2026-07-03T05:59:00'))).toBeNull()
    expect(s.due(at('2026-07-03T10:00:00'))).toBeNull()
    expect(s.due(at('2026-07-03T11:29:00'))).toBeNull()
    expect(s.due(at('2026-07-03T14:00:00'))).toBeNull()
    expect(s.due(at('2026-07-03T21:59:00'))).toBeNull()
    expect(s.due(at('2026-07-04T01:00:00'))).toBeNull()
  })
})

describe('LedgerScheduler — fire once per anchor day (acceptance 8/9)', () => {
  it('a second boundary inside the same window airs nothing', () => {
    const s = new LedgerScheduler(new InProcessMemoryStore())
    expect(s.due(at('2026-07-03T06:10:00'))).toBe('morning')
    s.markFired('morning', at('2026-07-03T06:10:00'))
    expect(s.due(at('2026-07-03T06:40:00'))).toBeNull()
    expect(s.due(at('2026-07-04T06:40:00'))).toBe('morning') // next day fires again
  })

  it('no midnight re-fire: 23:10 fires, 00:30 the next date does not', () => {
    const s = new LedgerScheduler(new InProcessMemoryStore())
    expect(s.due(at('2026-07-03T23:10:00'))).toBe('night')
    s.markFired('night', at('2026-07-03T23:10:00'))
    // A new calendar day, still the SAME window — the naive per-calendar-day
    // key would air a second good-night eighty minutes later.
    expect(s.due(at('2026-07-04T00:30:00'))).toBeNull()
    // The occurrence does come back the following evening.
    expect(s.due(at('2026-07-04T22:05:00'))).toBe('night')
  })

  it('a missed window is dropped, never replayed', () => {
    const s = new LedgerScheduler(new InProcessMemoryStore())
    expect(s.due(at('2026-07-03T15:00:00'))).toBeNull() // radio was off all morning
  })

  it('an anchor recorded before a restart is not re-fired by a fresh scheduler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-anchor-'))
    const before = new PersistentMemoryStore({ dir })
    const fired = at('2026-07-03T23:10:00')
    new LedgerScheduler(before).markFired('night', fired)

    // Restart at 00:30 — a new calendar date inside the same night window.
    const after = new LedgerScheduler(new PersistentMemoryStore({ dir }))
    expect(after.due(at('2026-07-04T00:30:00'))).toBeNull()
    expect(after.due(at('2026-07-04T22:05:00'))).toBe('night')
  })

  it('markFired writes the window-opening date, not the air date', () => {
    const store = new InProcessMemoryStore()
    new LedgerScheduler(store).markFired('night', at('2026-07-04T00:30:00'))
    expect(store.recentAnchors(4)).toEqual(['night@2026-07-03'])
  })
})
