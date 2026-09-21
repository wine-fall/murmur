// Familiarity and rotation (spec 14 §3.10 step 5).
//
// Whether the listener already knows a song is a FACT about their accounts
// and about murmur's own ledger, so it is decided here, in code — never asked
// of the model, which would only be asked to judge its own memory. And
// rotation is a shuffled deck rather than a coin per pick: a coin gives the
// listener a run of five familiar songs about once a fortnight, which is the
// exact evening the radio stops sounding like a discovery.

import type { Familiarity } from '../contracts.ts'
import { carries } from './sources/moment.ts'
import type { TasteItem } from './sources/taste.ts'

// ponytail: three in ten, a constant and not a setting. It is the shape of
// the program, and a listener who wants a jukebox has /sources and a request.
// Upgrade path if the by-ear pass asks for it: read it off the persona.
export const FAMILIAR_PER_10 = 3
const DECK = 10

// The artist ranking counts this far down: past ten a "hit" is an album
// track, and the whole label means "the one everybody already has".
export const HOT_SONGS = 10
const HOT_TTL_MS = 24 * 60 * 60 * 1000
// The ranking is read while the model waits on its search, so it gets a
// ceiling far below the client's own: two reads at the client's 15 s would
// be half a minute of a search the listener is sitting through. Past this
// the song is simply new, and the artist is not asked about again today.
export const RANKING_BUDGET_MS = 2500

const NEW: Familiarity = { label: 'new', familiar: false }

export type FamiliarDeps = {
  // Every row the mounted snapshots and ledgers carry — liked, playlist and
  // history, across every platform, including the watch rows §2.3's block
  // never shows.
  rows: () => readonly TasteItem[]
  // The artist's own top songs on a platform that ranks them, newest first.
  // Absent = that arm of the rule is off.
  hotSongs?: (artist: string) => Promise<readonly string[]>
  log?: (message: string) => void
}

// ponytail: trim, collapse, lowercase, and drop a trailing parenthetical --
// "(Remastered 2019)", "(Live)", "(feat. X)" -- which is what the catalogues
// disagree about. Simplified and traditional are NOT folded together; the
// miss that leaves is counted, never named (§3.6). Upgrade path: fold both
// sides through a converter.
const foldTitle = (title: string): string =>
  title
    // The bracket forms the catalogues disagree about. The CJK pair is
    // written escaped because committed source is English only.
    .replace(/[([\u3010][^)\]\u3011]*[)\]\u3011]\s*$/u, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

const foldName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase()

// Whoever the candidate names has to BE the row's artist -- word-boundary
// aware, so "Chen" does not match "Chen Li", and either way round, so a
// collaboration credit still counts as the band.
function sameArtist(a: string, b: string): boolean {
  const left = foldName(a)
  const right = foldName(b)
  if (left === '' || right === '') return false
  if (left === right) return true
  return carries(left, right) || carries(right, left)
}

export class Familiar {
  private deps: FamiliarDeps
  private hot = new Map<string, { at: number; songs: readonly string[] }>()

  constructor(deps: FamiliarDeps) {
    this.deps = deps
  }

  // `played` is what murmur itself has aired, as track labels (the ledger at
  // air time plus whatever the queue is holding). Passed in rather than read
  // here: the Director owns both.
  async label(title: string, artist: string, played: readonly string[]): Promise<Familiarity> {
    const wanted = foldTitle(title)
    if (wanted === '') return NEW
    for (const row of this.deps.rows()) {
      if (row.kind !== 'liked' && row.kind !== 'playlist' && row.kind !== 'history') continue
      if (foldTitle(row.title) !== wanted) continue
      if (row.artist === undefined || !sameArtist(row.artist, artist)) continue
      return { label: row.kind === 'history' ? 'watched' : 'kept', familiar: true }
    }
    for (const label of played) {
      const cut = label.lastIndexOf(' — ')
      if (cut === -1) continue
      if (foldTitle(label.slice(0, cut)) === wanted && sameArtist(label.slice(cut + 3), artist)) {
        return { label: 'played by murmur', familiar: true }
      }
    }
    const rank = (await this.ranking(artist)).findIndex((song) => foldTitle(song) === wanted)
    if (rank !== -1) return { label: `artist's #${rank + 1} hit`, familiar: true }
    // Not familiar -- but is the ARTIST theirs? That is where a spelling this
    // does not fold would hide, and counting it is the miss rate (§3.10).
    const known = this.deps.rows().some((row) => row.artist !== undefined && sameArtist(row.artist, artist))
    return known ? { ...NEW, artistKnown: true } : NEW
  }

  // One read per artist per day, and a ranking that will not answer is no
  // ranking: a pick may not wait on it, and calling an unknown song familiar
  // would silence the pool this section exists to open.
  private async ranking(artist: string): Promise<readonly string[]> {
    const name = foldName(artist)
    const read = this.deps.hotSongs
    if (name === '' || read === undefined) return []
    const held = this.hot.get(name)
    if (held !== undefined && Date.now() - held.at < HOT_TTL_MS) return held.songs
    try {
      const songs = await Promise.race([
        read(artist),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`ranking budget spent (${RANKING_BUDGET_MS}ms)`)), RANKING_BUDGET_MS).unref?.()),
      ])
      this.hot.set(name, { at: Date.now(), songs })
      return songs
    } catch (err) {
      this.deps.log?.(`music.familiar ranking failed: ${String(err)}`)
      // Cached as empty for the day too: a platform that is refusing will
      // refuse the next candidate as well, and the pick pays once.
      this.hot.set(name, { at: Date.now(), songs: [] })
      return []
    }
  }
}

// Which pick slots may play something the listener already knows: three of
// every ten, shuffled, so the count is exact over the deck and the streaks
// stay bounded. Independent dice would give neither.
export class SlotDeck {
  private random: () => number
  private per10: number
  private deck: boolean[] = []

  constructor({ familiarPer10 = FAMILIAR_PER_10, random = Math.random }: { familiarPer10?: number; random?: () => number } = {}) {
    this.per10 = familiarPer10
    this.random = random
  }

  draw(): boolean {
    if (this.deck.length === 0) this.deck = this.shuffled()
    return this.deck.pop()!
  }

  private shuffled(): boolean[] {
    const cards = Array.from({ length: DECK }, (_, i) => i < this.per10)
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1))
      ;[cards[i], cards[j]] = [cards[j]!, cards[i]!]
    }
    return cards
  }
}
