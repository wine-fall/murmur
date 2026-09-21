// Familiarity and rotation (spec 14 §3.10 step 5). Both are decided in CODE:
// what the listener already knows is a fact about their accounts and our own
// ledger, never a judgment the model is asked to make about itself.
import { describe, expect, it } from 'vitest'

import { Familiar, FAMILIAR_PER_10, RANKING_BUDGET_MS, SlotDeck } from '../src/music/familiar.ts'
import type { TasteItem } from '../src/music/sources/taste.ts'

const rows: TasteItem[] = [
  { kind: 'liked', title: 'The Harbour Song', artist: 'Paper Ferries' },
  { kind: 'liked', title: 'Kept With A Suffix (Remastered 2019)', artist: 'Paper Ferries' },
  { kind: 'history', title: 'Watched Once', artist: 'Night Tape' },
  { kind: 'playlist', title: 'a playlist name', artist: undefined },
]

function judge(over: Partial<{ hotSongs: (artist: string) => Promise<readonly string[]>; played: string[] }> = {}) {
  const asked: string[] = []
  const log: string[] = []
  const familiar = new Familiar({
    rows: () => rows,
    hotSongs: over.hotSongs ?? (async (artist) => (asked.push(artist), artist === 'Big Name' ? ['Their Biggest', 'Second Biggest'] : [])),
    log: (m) => log.push(m),
  })
  return { familiar, asked, log, played: over.played ?? [] }
}

describe('Familiar', () => {
  it('knows a song they keep, whatever the parenthetical says', async () => {
    const { familiar, played } = judge()
    expect(await familiar.label('The Harbour Song', 'Paper Ferries', played)).toMatchObject({ familiar: true, label: 'kept' })
    expect(await familiar.label('  the harbour song  ', 'PAPER FERRIES', played)).toMatchObject({ familiar: true })
    expect(await familiar.label('Kept With A Suffix', 'Paper Ferries', played)).toMatchObject({ familiar: true })
    expect(await familiar.label('The Harbour Song (Live at Home)', 'Paper Ferries', played)).toMatchObject({ familiar: true })
  })

  it('will not call a song kept because the title matched someone else\'s', async () => {
    const { familiar, played } = judge()
    expect(await familiar.label('The Harbour Song', 'Another Band', played)).toMatchObject({ familiar: false, label: 'new' })
  })

  // A collaboration credit IS the band; a name that merely contains another
  // name is not. "Chen" must not swallow "Chen Li", or a song they have never
  // heard is called theirs and a new-only slot refuses it for nothing.
  it('matches a credit, not a word inside a longer name', async () => {
    const familiar = new Familiar({
      rows: () => [
        { kind: 'liked', title: 'Same Title', artist: 'Chen' },
        { kind: 'liked', title: 'Another', artist: 'Corin Vanterpool & Static Meadow' },
        { kind: 'liked', title: 'Third', artist: 'Cheer Chen' },
      ],
    })
    expect(await familiar.label('Same Title', 'Chen Li', [])).toMatchObject({ label: 'new', familiar: false })
    expect(await familiar.label('Same Title', 'Chen', [])).toMatchObject({ label: 'kept' })
    // ...while the collaboration credit still counts as the band, and a
    // platform's own suffix does not break the name.
    expect(await familiar.label('Another', 'Static Meadow', [])).toMatchObject({ label: 'kept' })
    expect(await familiar.label('Third', 'Cheer Chen - Topic', [])).toMatchObject({ label: 'kept' })
  })

  it('counts a watch row, including the ones the digest never shows', async () => {
    const { familiar, played } = judge()
    expect(await familiar.label('Watched Once', 'Night Tape', played)).toMatchObject({ familiar: true, label: 'watched' })
  })

  it('counts what murmur itself has aired, from the labels it is given', async () => {
    const { familiar } = judge()
    expect(await familiar.label('Some Song', 'Some Band', ['Some Song — Some Band'])).toMatchObject({
      familiar: true,
      label: 'played by murmur',
    })
  })

  it('counts the artist\'s own top ten, and says which place', async () => {
    const { familiar, played } = judge()
    expect(await familiar.label('Their Biggest', 'Big Name', played)).toMatchObject({ familiar: true, label: "artist's #1 hit" })
    expect(await familiar.label('Second Biggest', 'Big Name', played)).toMatchObject({ label: "artist's #2 hit" })
    expect(await familiar.label('An Album Track', 'Big Name', played)).toMatchObject({ familiar: false, label: 'new' })
  })

  // A search answers with several songs by one artist, and every label is
  // judged at once: a cache written only when the read RESOLVES lets all of
  // them through, so one artist cost ten searches and ten rankings — and a
  // late failure then overwrote the good answer with an empty one.
  it('shares one ranking request across the candidates judged together', async () => {
    let reads = 0
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const familiar = new Familiar({
      rows: () => [],
      hotSongs: async () => {
        reads++
        await gate
        return ['Their Biggest']
      },
    })
    const all = Promise.all(Array.from({ length: 10 }, () => familiar.label('Their Biggest', 'Big Name', [])))
    release()
    for (const mark of await all) expect(mark).toMatchObject({ label: "artist's #1 hit" })
    expect(reads).toBe(1)
  })

  it('asks the ranking once per artist, not once per candidate', async () => {
    const { familiar, asked, played } = judge()
    await familiar.label('a', 'Big Name', played)
    await familiar.label('b', 'Big Name', played)
    expect(asked).toEqual(['Big Name'])
  })

  it('never asks the ranking for a song the cheaper checks already knew', async () => {
    const { familiar, asked, played } = judge()
    await familiar.label('The Harbour Song', 'Paper Ferries', played)
    expect(asked).toEqual([])
  })

  it('is new, not stuck, when the ranking will not answer', async () => {
    const { familiar, log } = judge({
      hotSongs: async () => {
        throw new Error('rate limited')
      },
    })
    expect(await familiar.label('Anything', 'Big Name', [])).toMatchObject({ familiar: false, label: 'new' })
    expect(log.join()).toMatch(/music\.familiar ranking failed/)
    expect(log.join()).not.toContain('Anything')
  })

  // Simplified and traditional are NOT folded together (§3.10), and neither
  // is anything else a catalogue spells its own way. A song called new whose
  // ARTIST is theirs is where such a miss hides, so it is flagged -- as a
  // count for the caller, never as a title.
  it('flags a new song by an artist they already keep, which is where a missed fold hides', async () => {
    const { familiar, log } = judge()
    expect(await familiar.label('Some Other Song', 'Paper Ferries', [])).toEqual({ label: 'new', familiar: false, artistKnown: true })
    expect(await familiar.label('Some Other Song', 'A Stranger', [])).toEqual({ label: 'new', familiar: false })
    expect(log.join()).not.toContain('Some Other Song')
  })

  it('strips the bracket forms the catalogues disagree about', async () => {
    const { familiar } = judge()
    expect(await familiar.label('The Harbour Song [Live]', 'Paper Ferries', [])).toMatchObject({ familiar: true })
    expect(await familiar.label('The Harbour Song \u3010Live\u3011', 'Paper Ferries', [])).toMatchObject({ familiar: true })
  })
})

describe('SlotDeck', () => {
  it('deals exactly three familiar slots in every ten, whatever the shuffle', () => {
    const deck = new SlotDeck({ random: () => 0.5 })
    const drawn = Array.from({ length: 30 }, () => deck.draw())
    for (const start of [0, 10, 20]) {
      expect(drawn.slice(start, start + 10).filter(Boolean)).toHaveLength(FAMILIAR_PER_10)
    }
  })

  it('shuffles, so the familiar slots are not always the same three', () => {
    const rolls = [0.9, 0.1, 0.7, 0.2, 0.8, 0.3, 0.6, 0.4, 0.5, 0.05]
    let i = 0
    const deck = new SlotDeck({ random: () => rolls[i++ % rolls.length]! })
    const first = Array.from({ length: 10 }, () => deck.draw())
    const second = Array.from({ length: 10 }, () => deck.draw())
    expect(first).not.toEqual(second)
  })

  it('bounds the streak: ten slots can never be familiar in a row', () => {
    const deck = new SlotDeck({ random: () => 0.99 })
    const drawn = Array.from({ length: 40 }, () => deck.draw())
    let run = 0
    let longest = 0
    for (const familiar of drawn) {
      run = familiar ? run + 1 : 0
      longest = Math.max(longest, run)
    }
    // Worst case is the tail of one deck meeting the head of the next.
    expect(longest).toBeLessThanOrEqual(FAMILIAR_PER_10 * 2)
  })
})

// The ranking is read on the pick's own path, so it needs a ceiling of its
// own: the client's 15 s timeout twice over would be half a minute of a
// search the listener is waiting through.
describe('the ranking has a budget', () => {
  it('gives up on a slow ranking and calls the song new', async () => {
    const familiar = new Familiar({
      rows: () => [],
      hotSongs: () => new Promise(() => {}),
      log: () => {},
    })
    const started = Date.now()
    expect(await familiar.label('Anything', 'Big Name', [])).toMatchObject({ label: 'new', familiar: false })
    expect(Date.now() - started).toBeLessThan(RANKING_BUDGET_MS * 3)
  })
})
