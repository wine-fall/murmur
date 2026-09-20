// The taste ledger (spec 14 §2.11): the half of a source's data that
// accumulates. A snapshot is the latest read and nothing more — `refreshOne`
// overwrites the whole file and `BOUNDS.history` is a 200-row window, so
// three months of listening would leave murmur knowing the last 200 plays.
// The ledger is append-only beside it: a row that falls out of the window
// stays, and the per-kind read clock (§3.4) rides in the same file because
// it is rebuildable bookkeeping and sources.json is the one holding secrets.

import { z } from 'zod'

import { LEDGER_MAX_BYTES, SOURCE_IDS, type SourceId, TasteItemSchema, type TasteItem, type TasteKind, type TasteSnapshot } from './taste.ts'

const LedgerEntrySchema = TasteItemSchema.extend({
  key: z.string(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  // How many reads saw this row. A liked song is seen by every read that
  // reaches it, so this says how long murmur has known the row — never how
  // often it was played, and nothing may present it as a play count.
  seen: z.number().int(),
})

export const TasteLedgerSchema = z.object({
  source: z.enum(SOURCE_IDS),
  updatedAt: z.string(),
  entries: z.array(LedgerEntrySchema),
  // When each of this source's lists was last asked for. Keys are kinds;
  // an absent one is due (§3.4).
  lastRead: z.record(z.string(), z.string()).optional(),
})

export type LedgerEntry = Readonly<z.infer<typeof LedgerEntrySchema>>
export type TasteLedger = Readonly<z.infer<typeof TasteLedgerSchema>>

export const emptyLedger = (source: SourceId): TasteLedger => ({ source, updatedAt: '', entries: [] })

// Same key, same row. A ref is the platform's own identity for it, so a
// retitled row is still the row murmur already knows.
export function ledgerKey(item: TasteItem): string {
  return item.ref ?? `${item.kind}|${item.title.trim()}|${(item.artist ?? '').trim()}`
}

// Fold one read into the ledger. Nothing is ever removed here: a partial
// refresh carries only the kinds it read, and the kinds it did not read must
// come out untouched rather than forgotten.
export function mergeLedger(ledger: TasteLedger, snapshot: TasteSnapshot, readKinds: readonly TasteKind[]): TasteLedger {
  const at = snapshot.takenAt
  const byKey = new Map(ledger.entries.map((e) => [e.key, e]))
  const entries = [...ledger.entries]
  for (const item of snapshot.items) {
    if (item.title.trim() === '') continue
    const key = ledgerKey(item)
    const known = byKey.get(key)
    // The platform can retitle a row or fill in an album it had not filled
    // in before, so the newest reading of those fields wins.
    const next: LedgerEntry = known === undefined
      ? { ...item, key, firstSeen: at, lastSeen: at, seen: 1 }
      : { ...known, ...item, key, firstSeen: known.firstSeen, lastSeen: at, seen: known.seen + 1 }
    if (known === undefined) entries.push(next)
    else entries[entries.indexOf(known)] = next
    byKey.set(key, next)
  }
  // The kinds that were REQUESTED, not the kinds that came back: a list that
  // is genuinely empty must not be asked for again in three hours.
  const lastRead = { ...ledger.lastRead }
  for (const kind of readKinds) lastRead[kind] = at
  return { source: ledger.source, updatedAt: at, entries, lastRead }
}

// Past the byte cap, shed the oldest `lastSeen` first until the file fits.
// Byte length, not string length: a CJK ledger is three times its character
// count on disk, and the bound is about the file.
export function capLedger(ledger: TasteLedger, maxBytes: number = LEDGER_MAX_BYTES): { ledger: TasteLedger; dropped: number } {
  if (Buffer.byteLength(JSON.stringify(ledger), 'utf-8') <= maxBytes) return { ledger, dropped: 0 }
  const envelope = Buffer.byteLength(JSON.stringify({ ...ledger, entries: [] }), 'utf-8')
  const keep = new Set<string>()
  let used = envelope
  for (const entry of [...ledger.entries].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0))) {
    // The comma this entry adds to the array is the +1.
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf-8') + 1
    if (used + size > maxBytes) break
    used += size
    keep.add(entry.key)
  }
  // Filtered rather than re-ordered: §2.12 breaks a score tie on the
  // ledger's own order, so surviving entries keep the places they had.
  const entries = ledger.entries.filter((e) => keep.has(e.key))
  return { ledger: { ...ledger, entries }, dropped: ledger.entries.length - entries.length }
}
