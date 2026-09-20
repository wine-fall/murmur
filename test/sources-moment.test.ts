// The moment-matched half (spec 14 §2.12): which of the ledger's rows go
// into the pick's digest, chosen in code from signals the Director already
// holds. No tool, no model call, and a 5 ms budget.
import { describe, expect, it } from 'vitest'

import { type Moment, momentTerms, selectForMoment, type MomentCandidate } from '../src/music/sources/moment.ts'
import type { TasteItem } from '../src/music/sources/taste.ts'

const AFTERNOON: Moment = { hour: 16, persona: '', lastTalk: '', avoidArtists: [] }

let order = 0
const candidate = (item: TasteItem, over: Partial<MomentCandidate> = {}): MomentCandidate => ({
  item,
  lastSeen: '2026-09-20T00:00:00.000Z',
  quiet: false,
  order: order++,
  ...over,
})
const song = (title: string, artist: string): TasteItem => ({ kind: 'liked', title, artist })

describe('momentTerms', () => {
  it('turns the hour into a word the terms can match', () => {
    const at = (hour: number): string[] => momentTerms({ ...AFTERNOON, hour })
    expect(at(8)).toContain('morning')
    expect(at(16)).toContain('afternoon')
    expect(at(20)).toContain('evening')
    expect(at(23)).toContain('night')
    expect(at(2)).toContain('late night')
  })

  it('takes the content words of the last talk beat and the persona', () => {
    const terms = momentTerms({ hour: 16, persona: 'a warm late-night host with a jazz habit', lastTalk: 'I have been playing a lot of city pop lately', avoidArtists: [] })
    expect(terms).toContain('city')
    expect(terms).toContain('pop')
    expect(terms).toContain('jazz')
    // The function words are not query terms; matching on "the" would score
    // every row in the ledger equally and say nothing.
    for (const stop of ['a', 'of', 'i', 'have', 'been', 'with']) expect(terms).not.toContain(stop)
  })

  it('caps the query so a long beat does not become a long scan', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    expect(momentTerms({ ...AFTERNOON, lastTalk: long }).length).toBeLessThanOrEqual(24)
  })

  it('splits CJK into bigrams, the way recall does', () => {
    // "wan shang" (evening) as two characters: a unicode61 tokenizer would
    // make it one token and never match a row that spells it differently.
    const terms = momentTerms({ ...AFTERNOON, lastTalk: '\u4eca\u5929\u665a\u4e0a' })
    expect(terms).toContain('\u665a\u4e0a')
  })
})

describe('selectForMoment', () => {
  it('puts an exact artist match first, and a prefix match above a body hit', () => {
    const pool = [
      candidate(song('a track', 'Someone Else')),
      candidate(song('a song about the harbour', 'Nobody')),
      candidate(song('another track', 'Harbourlight')),
      candidate(song('one more', 'Harbour')),
    ]
    const picked = selectForMoment(pool, { ...AFTERNOON, lastTalk: 'harbour' })!.songs
    expect(picked.map((i) => i.artist)).toEqual(['Harbour', 'Harbourlight', 'Nobody', 'Someone Else'])
  })

  it('never chooses an artist that just played', () => {
    const pool = [candidate(song('a track', 'Harbour')), candidate(song('a harbour song', 'Low Antenna'))]
    const picked = selectForMoment(pool, { ...AFTERNOON, lastTalk: 'harbour', avoidArtists: ['harbour'] })!.songs
    expect(picked.map((i) => i.artist)).toEqual(['Low Antenna'])
  })

  it('counts a collaboration credit as the artist that just played', () => {
    const pool = [
      candidate(song('a duet', 'Corin Vanterpool & Harbour')),
      candidate(song('a feature', 'Harbour feat. Low Antenna')),
      candidate(song('unrelated', 'Harbourlight')),
    ]
    const picked = selectForMoment(pool, { ...AFTERNOON, lastTalk: 'harbourlight', avoidArtists: ['Harbour'] })!.songs
    // The two credits go; the band whose name merely starts the same stays.
    expect(picked.map((i) => i.title)).toEqual(['unrelated'])
  })

  it('pushes a row the last read of its own list no longer saw behind one it did', () => {
    const pool = [
      candidate(song('unliked since', 'Harbour'), { quiet: true }),
      candidate(song('still kept', 'Harbour')),
    ]
    const picked = selectForMoment(pool, { ...AFTERNOON, lastTalk: 'harbour' })!.songs
    expect(picked.map((i) => i.title)).toEqual(['still kept', 'unliked since'])
    // Behind, not gone: un-liking is usually tidying, so a strong match can
    // still surface (spec 14 §2.12).
    expect(picked).toHaveLength(2)
  })

  it('keeps the watch rows in their own list, and only from a songs-only source', () => {
    const pool = [
      candidate({ kind: 'history', title: 'a track just played', artist: 'Harbour' }),
      candidate(song('a kept song', 'Harbour')),
    ]
    const { songs, lately } = selectForMoment(pool, { ...AFTERNOON, lastTalk: 'harbour' })!
    expect(songs.map((i) => i.title)).toEqual(['a kept song'])
    expect(lately.map((i) => i.title)).toEqual(['a track just played'])
  })

  // codex review: this used to return the pool ordered by `lastSeen`, which
  // is a READ time -- every row of one refresh shares it, so ties fell to
  // insertion order and the block came out in an order the static render
  // would never produce. No match means no reordering at all.
  it('answers null when nothing matched, so the caller renders what it would have', () => {
    const pool = [
      candidate(song('older', 'A Band'), { lastSeen: '2026-09-01T00:00:00.000Z' }),
      candidate(song('newer', 'A Band'), { lastSeen: '2026-09-19T00:00:00.000Z' }),
    ]
    expect(selectForMoment(pool, AFTERNOON)).toBeNull()
    // A category bonus alone is not a match either: it ranks rows the terms
    // already reached, and on its own it is no reason to reorder the block.
    const zoned = [candidate({ kind: 'history', title: 'a set', category: '\u97f3\u4e50\u7efc\u5408' })]
    expect(selectForMoment(zoned, AFTERNOON)).toBeNull()
  })

  it('is deterministic: the same pool and moment select the same rows, in the same order', () => {
    const pool = Array.from({ length: 40 }, (_, i) => candidate(song(`song ${i}`, `Band ${i % 5}`)))
    const moment = { ...AFTERNOON, lastTalk: 'band 3 in the evening' }
    const once = selectForMoment(pool, moment)!.songs.map((i) => i.title)
    expect(selectForMoment(pool, moment)!.songs.map((i) => i.title)).toEqual(once)
  })
})
