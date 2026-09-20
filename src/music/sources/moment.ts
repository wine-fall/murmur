// The moment-matched half (spec 14 §2.12): which of the ledger's rows reach
// the pick's digest, chosen here — in code, before the situation string is
// assembled. No tool is offered to the brain and no model call is made: a
// pick's median is already 142 s and this step may not add to it. A local
// scan over a few thousand rows against at most 24 terms is microseconds,
// and the test holds it to 5 ms.

import { queryTokens } from '../../memory/recall.ts'
import { isMusicCategory, type TasteItem } from './taste.ts'

// The signals the Director already holds at pick time.
export type Moment = {
  // Local hour, 0-23.
  hour: number
  // The persona line as the model receives it.
  persona: string
  // The last talk beat's text.
  lastTalk: string
  // The artists of the last songs played: an exclusion, never a query term.
  avoidArtists: readonly string[]
}

// One ledger row as the selector sees it. `quiet` means the last read of
// this row's own list did not return it — the row is still kept, it has
// simply stopped being in the collection (§2.12's gone-quiet penalty).
export type MomentCandidate = {
  item: TasteItem
  lastSeen: string
  quiet: boolean
  // The ledger's own order, the last tie-break, so a selection is
  // reproducible for a given ledger and moment.
  order: number
}

// A long beat does not become a long scan.
const MAX_TERMS = 24
// The words that would match every row in the ledger equally, which is the
// same as matching nothing. Short and English-only by design: the CJK side
// is handled by bigrams, where a function word is not a whole token.
const STOP = new Set(
  'a an and are as at be been but by do for from had has have he her his i if in is it its me my not of on or our she so that the their them then there they this to too up us was we were what when which who will with would you your'.split(' '),
)

export function hourBucket(hour: number): string {
  if (hour < 5) return 'late night'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

// What the moment is asking for, as tokens. `queryTokens` is recall's
// (spec 05-01 §3.4) — it already lowercases, splits on non-word characters
// and shingles CJK runs into bigrams, which is the whole reason to reuse it.
export function momentTerms(moment: Moment): string[] {
  const bucket = hourBucket(moment.hour)
  const terms = [bucket, ...queryTokens(`${bucket} ${moment.lastTalk} ${moment.persona}`)]
  return [...new Set(terms.filter((t) => t.length >= 2 && !STOP.has(t)))].slice(0, MAX_TERMS)
}

const fold = (text: string | undefined): string => (text ?? '').trim().toLowerCase()

// A query term and whether it may match inside a word.
type Term = { word: string; loose: boolean }

// Han, kana and Hangul: a bigram term is a substring by construction, which
// is the same match `shingle()` makes on both sides, so it needs no word
// boundary. A latin term does -- "art" must not hit "heart".
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/
const isWordChar = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch)

// Does the row's text carry this term as a word? Scanned rather than
// tokenised: tokenising every row of the ledger on every pick was 4.3 ms of
// the 5 ms budget, and this is the same answer without the allocations.
function carries(text: string, term: string, loose: boolean): boolean {
  if (loose) return text.includes(term)
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) {
    const before = i === 0 ? ' ' : text[i - 1]!
    const after = i + term.length >= text.length ? ' ' : text[i + term.length]!
    if (!isWordChar(before) && !isWordChar(after)) return true
  }
  return false
}

// Highest wins (spec 14 §2.12). A name match is worth more than a body hit
// because "they said the band's name" is a far stronger signal than "a word
// of the talk appears in a title". This runs once per ledger row per pick,
// so it stays allocation-light: the 5 ms budget is the whole reason there is
// no index here.
function score(item: TasteItem, terms: readonly Term[], quiet: boolean): number {
  const name = fold(item.kind === 'top-artist' ? item.title : item.artist)
  let best = 0
  let text: string | null = null
  for (const { word, loose } of terms) {
    if (name !== '') {
      if (word === name) {
        best = 3
        break
      }
      if (name.startsWith(word) || word.startsWith(name)) {
        best = Math.max(best, 2)
        continue
      }
    }
    if (best >= 1) continue
    text ??= `${item.title} ${item.artist ?? ''} ${item.album ?? ''}`.toLowerCase()
    if (carries(text, word, loose)) best = 1
  }
  if (isMusicCategory(item.category)) best += 0.5
  return quiet ? best - 1 : best
}

// Newest lastSeen first, then the ledger's own order.
const byRecency = (a: MomentCandidate, b: MomentCandidate): number =>
  a.lastSeen === b.lastSeen ? a.order - b.order : a.lastSeen < b.lastSeen ? 1 : -1

// The songs and the watch rows the moment asks for, each in score order.
// With no terms every row scores 0 and the order is newest first, which is
// what the digest rendered before this existed — so an unmatched pick, a
// ledger-less source and a silent moment all degrade to today by the same
// path rather than by a special case.
export function selectForMoment(candidates: readonly MomentCandidate[], moment: Moment): { songs: TasteItem[]; lately: TasteItem[] } {
  // Classified once, not once per row.
  const terms: Term[] = momentTerms(moment).map((word) => ({ word, loose: CJK.test(word) }))
  // A credit, not a string: "Corin Vanterpool & Static Meadow" IS the band
  // the listener just heard, and an equality test would offer it right back.
  // Boundary-checked, so a short name cannot swallow an unrelated one.
  const avoid = moment.avoidArtists.map(fold).filter((a) => a !== '').map((word) => ({ word, loose: CJK.test(word) }))
  const played = (artist: string | undefined): boolean => {
    const name = fold(artist)
    return name !== '' && avoid.some(({ word, loose }) => carries(name, word, loose))
  }
  const scored = candidates
    .filter((c) => !played(c.item.artist))
    .map((c) => ({ c, score: score(c.item, terms, c.quiet) }))
    .sort((a, b) => b.score - a.score || byRecency(a.c, b.c))
  return {
    songs: scored.filter((s) => s.c.item.kind === 'liked').map((s) => s.c.item),
    lately: scored.filter((s) => s.c.item.kind === 'history').map((s) => s.c.item),
  }
}
