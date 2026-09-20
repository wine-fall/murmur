// The taste ledger (spec 14 §2.11): the append-only half of a source's data,
// beside the snapshot that only ever holds the latest read. Pure merge, pure
// cap, and the per-kind read clock that rides in the same file.
import { describe, expect, it } from 'vitest'

import { capLedger, emptyLedger, ledgerKey, mergeLedger, type TasteLedger } from '../src/music/sources/ledger.ts'
import { LEDGER_MAX_BYTES, type TasteItem, type TasteSnapshot } from '../src/music/sources/taste.ts'

const read = (takenAt: string, items: TasteItem[]): TasteSnapshot => ({ source: 'netease', takenAt, items })
const DAY_1 = '2026-09-01T00:00:00.000Z'
const DAY_2 = '2026-09-02T00:00:00.000Z'
const DAY_3 = '2026-09-03T00:00:00.000Z'

const song = (title: string, ref?: string): TasteItem => ({ kind: 'liked', title, artist: 'a band', ...(ref !== undefined && { ref }) })

describe('ledgerKey', () => {
  it('is the ref when there is one, so a retitled row is still the same row', () => {
    expect(ledgerKey(song('old title', 'https://x/1'))).toBe('https://x/1')
    expect(ledgerKey(song('new title', 'https://x/1'))).toBe(ledgerKey(song('old title', 'https://x/1')))
  })

  it('falls back to kind, title and artist, trimmed', () => {
    expect(ledgerKey(song('  a song  '))).toBe('liked|a song|a band')
    expect(ledgerKey({ kind: 'playlist', title: 'late drive' })).toBe('playlist|late drive|')
  })
})

describe('mergeLedger', () => {
  it('appends what is new and keeps firstSeen while taking the new lastSeen', () => {
    const first = mergeLedger(emptyLedger('netease'), read(DAY_1, [song('one', 'r1'), song('two', 'r2')]), ['liked'])
    expect(first.entries.map((e) => e.key)).toEqual(['r1', 'r2'])
    expect(first.entries[0]).toMatchObject({ firstSeen: DAY_1, lastSeen: DAY_1, seen: 1 })

    const second = mergeLedger(first, read(DAY_2, [song('two', 'r2'), song('three', 'r3')]), ['liked'])
    expect(second.entries.map((e) => e.key)).toEqual(['r1', 'r2', 'r3'])
    // The one the second read did not see is still there, untouched: that is
    // the whole point of the ledger against the 200-row snapshot window.
    expect(second.entries[0]).toMatchObject({ key: 'r1', firstSeen: DAY_1, lastSeen: DAY_1, seen: 1 })
    expect(second.entries[1]).toMatchObject({ key: 'r2', firstSeen: DAY_1, lastSeen: DAY_2, seen: 2 })
    expect(second.entries[2]).toMatchObject({ key: 'r3', firstSeen: DAY_2, lastSeen: DAY_2, seen: 1 })
  })

  it('takes the newest reading of the fields a platform can change', () => {
    const first = mergeLedger(emptyLedger('netease'), read(DAY_1, [{ kind: 'history', title: 'old', artist: 'old band', ref: 'r' }]), ['history'])
    const second = mergeLedger(first, read(DAY_2, [{ kind: 'history', title: 'new', artist: 'new band', album: 'an album', category: 'a zone', ref: 'r' }]), ['history'])
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0]).toMatchObject({ title: 'new', artist: 'new band', album: 'an album', category: 'a zone', firstSeen: DAY_1, seen: 2 })
  })

  it('never removes an entry, whatever a read does not return', () => {
    const first = mergeLedger(emptyLedger('netease'), read(DAY_1, [song('one', 'r1'), song('two', 'r2'), song('three', 'r3')]), ['liked'])
    const emptied = mergeLedger(first, read(DAY_2, []), ['liked'])
    expect(emptied.entries).toHaveLength(3)
    expect(emptied.entries.every((e) => e.lastSeen === DAY_1)).toBe(true)
  })

  it('stamps lastRead for the kinds that were requested, not the kinds that came back', () => {
    // A list that is genuinely empty must not be re-read every three hours.
    const ledger = mergeLedger(emptyLedger('youtube'), read(DAY_1, []), ['history', 'subscription'])
    expect(ledger.lastRead).toEqual({ history: DAY_1, subscription: DAY_1 })
    const later = mergeLedger(ledger, read(DAY_2, []), ['history'])
    expect(later.lastRead).toEqual({ history: DAY_2, subscription: DAY_1 })
  })

  it('drops a row with no title, the way the digest does', () => {
    const ledger = mergeLedger(emptyLedger('netease'), read(DAY_1, [{ kind: 'liked', title: '  ' }, song('real')]), ['liked'])
    expect(ledger.entries).toHaveLength(1)
  })

  it('is pure: the ledger handed in is not mutated', () => {
    const first = mergeLedger(emptyLedger('netease'), read(DAY_1, [song('one', 'r1')]), ['liked'])
    const snapshot = JSON.stringify(first)
    mergeLedger(first, read(DAY_2, [song('one', 'r1'), song('two', 'r2')]), ['liked'])
    expect(JSON.stringify(first)).toBe(snapshot)
  })
})

describe('capLedger', () => {
  const big = (n: number): TasteLedger => ({
    source: 'netease',
    updatedAt: DAY_3,
    entries: Array.from({ length: n }, (_, i) => ({
      kind: 'liked' as const,
      title: `a song title of some length, number ${i}`,
      artist: `an artist with a reasonably long name ${i}`,
      key: `r${i}`,
      // Oldest first, so the ones dropped are the ones at the front.
      firstSeen: DAY_1,
      lastSeen: new Date(Date.parse(DAY_1) + i * 60_000).toISOString(),
      seen: 1,
    })),
  })

  it('leaves a ledger under the cap exactly as it was', () => {
    const ledger = big(10)
    expect(capLedger(ledger)).toEqual({ ledger, dropped: 0 })
  })

  it('sheds the oldest lastSeen first until the file fits, and says how many', () => {
    const ledger = big(400)
    const { ledger: capped, dropped } = capLedger(ledger, 8_000)
    expect(dropped).toBeGreaterThan(0)
    expect(capped.entries).toHaveLength(400 - dropped)
    expect(Buffer.byteLength(JSON.stringify(capped), 'utf-8')).toBeLessThanOrEqual(8_000)
    // What survives is the newest, and it survives in the ledger's own order.
    expect(capped.entries.map((e) => e.key)).toEqual(ledger.entries.slice(dropped).map((e) => e.key))
  })

  it('counts bytes, not characters, so a non-latin ledger is capped where the file is', () => {
    const wide: TasteLedger = {
      source: 'netease',
      updatedAt: DAY_3,
      // Three bytes per character in UTF-8, one UTF-16 unit each: a cap that
      // measured `.length` would let this file grow to three times the bound.
      entries: Array.from({ length: 50 }, (_, i) => ({ kind: 'liked' as const, title: '\u6b4c'.repeat(40), key: `k${i}`, firstSeen: DAY_1, lastSeen: DAY_1, seen: 1 })),
    }
    const { ledger: capped } = capLedger(wide, 3_000)
    expect(Buffer.byteLength(JSON.stringify(capped), 'utf-8')).toBeLessThanOrEqual(3_000)
  })

  it('caps at four megabytes by default, four times the snapshot bound', () => {
    expect(LEDGER_MAX_BYTES).toBe(4 * 1024 * 1024)
  })
})
