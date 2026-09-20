// The taste digest (spec 14 §2.3): what the listener keeps on the platforms
// they opted in, rendered as one bounded markdown block the pick task and the
// context pack read. A pure function of the snapshots — same inputs, same
// text — so it is testable on fixtures and costs no model call. The reader
// beside it memoises the render on the snapshot files' mtimes.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import type { AuthFailure } from './auth.ts'
import { type Moment, type MomentCandidate, selectForMoment } from './moment.ts'

export const SOURCE_IDS = ['youtube', 'bilibili', 'netease', 'spotify', 'qishui', 'qqmusic'] as const
export type SourceId = (typeof SOURCE_IDS)[number]

// How a platform is named on screen and in the digest.
export const SOURCE_NAMES: Record<SourceId, string> = {
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  netease: 'NetEase',
  spotify: 'Spotify',
  qishui: 'Soda Music',
  qqmusic: 'QQ Music',
}

const KINDS = ['liked', 'history', 'top-track', 'top-artist', 'playlist', 'favourite', 'subscription', 'daily', 'follows', 'frequents'] as const
export type TasteKind = (typeof KINDS)[number]

export const TasteItemSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string(),
  artist: z.string().optional(),
  album: z.string().optional(),
  at: z.string().optional(),
  ref: z.string().optional(),
  // The platform's own category for a watched row (Bilibili's sub-zone), used
  // to float music above cooking in the watch layer.
  category: z.string().optional(),
})

export const TasteSnapshotSchema = z.object({
  source: z.enum(SOURCE_IDS),
  takenAt: z.string(),
  items: z.array(TasteItemSchema),
})

export type TasteItem = Readonly<z.infer<typeof TasteItemSchema>>
export type TasteSnapshot = Readonly<z.infer<typeof TasteSnapshotSchema>>

// One platform as murmur reads it (spec 14 §2.2): a cheap identity check
// whose `who` the mount conversation echoes back, and the bounded snapshot.
export type VerifyResult = { ok: true; who: string } | { ok: false; reason: AuthFailure }

export interface TasteSource {
  readonly id: SourceId
  // The lists this platform can be asked for, which is what the per-kind
  // clock schedules (spec 14 §3.4).
  readonly kinds: readonly TasteKind[]
  verify(): Promise<VerifyResult>
  // `kinds` narrows the read to the lists that are due; undefined is all of
  // them. A source free to ignore it returns everything -- correct, just not
  // cheaper. May throw SourceAuthError; any other failure is a plain error.
  snapshot(kinds?: readonly TasteKind[]): Promise<TasteSnapshot>
}

// Was this list asked for? Undefined means the whole source was.
export const asked = (kinds: readonly TasteKind[] | undefined, kind: TasteKind): boolean => kinds === undefined || kinds.includes(kind)

// A partial read (spec 14 §3.4): the kinds it carries replace their rows,
// every other kind keeps the rows it had, so the snapshot still means "the
// latest read of each list" rather than "the latest read".
export function mergeSnapshot(previous: TasteSnapshot | null, next: TasteSnapshot, readKinds: readonly TasteKind[] | undefined): TasteSnapshot {
  if (previous === null || readKinds === undefined) return next
  const kept = previous.items.filter((i) => !readKinds.includes(i.kind))
  return { ...next, items: [...next.items, ...kept] }
}

// The per-source bounds (spec 14 §3.5).
export const BOUNDS = { liked: 500, history: 200, playlist: 50, top: 50, subscription: 100, follows: 50 } as const

// A snapshot file past the byte cap is a bug in the adapter that wrote it,
// and is skipped rather than fed to a prompt. A ledger is allowed four times
// as much because accumulating is its job (spec 14 §2.11), and it sheds its
// oldest entries rather than growing past it.
export const SNAPSHOT_MAX_BYTES = 1024 * 1024
export const LEDGER_MAX_BYTES = 4 * 1024 * 1024

// Only what the digest reads out of a ledger file; §2.11 owns the full
// shape, and parsing it here would tie the render to the writer.
const LedgerCountsSchema = z.object({
  source: z.enum(SOURCE_IDS),
  // `lastSeen` and `lastRead` are what §2.12 scores the gone-quiet penalty
  // from; the rest of a ledger's bookkeeping is the writer's business.
  entries: z.array(TasteItemSchema.extend({ lastSeen: z.string().optional() })),
  lastRead: z.record(z.string(), z.string()).optional(),
})
// Written out rather than inferred: the render only ever reads it, and a
// `z.infer` leaves the arrays mutable at the seam.
export type LedgerView = {
  readonly source: SourceId
  readonly entries: readonly (TasteItem & { lastSeen?: string | undefined })[]
  readonly lastRead?: Record<string, string> | undefined
}
export const DIGEST_BUDGET = 1500
// Sources + Artists + Playlists together: the listener's shape, the same on
// every pick of the day, held to a fifth of the block so the songs get the
// rest (spec 14 §2.3) -- 300 characters of the default 1500. A fraction
// rather than a constant, so a caller that asks for a different budget gets
// the same proportions. What the half does not spend rolls forward.
export const FIXED_SHARE = 0.2
const TOP_ARTISTS = 25
const SONG_ITEMS = 40
const WATCH_ITEMS = 8
const PLAYLIST_NAMES = 12
const PLATFORM_LIST = 10
const STALE_DAYS = 30

const day = (iso: string): string => iso.slice(0, 10)

// Code-unit order, not locale order: the digest must render the same on every
// machine, and a locale collation would not.
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const COUNT_ORDER: [TasteKind, (n: number) => string][] = [
  ['liked', (n) => `${n} liked`],
  ['history', (n) => `history ${n}`],
  ['follows', (n) => `${n} recently followed`],
  ['frequents', (n) => `${n} they go back to`],
  ['playlist', (n) => `${n} playlist${n === 1 ? '' : 's'}`],
  ['top-artist', (n) => `top ${n} artist${n === 1 ? '' : 's'}`],
  ['top-track', (n) => `top ${n} track${n === 1 ? '' : 's'}`],
  ['subscription', (n) => `${n} subscription${n === 1 ? '' : 's'}`],
  ['daily', (n) => `daily mix ${n}`],
]

function sourceSummary(snapshot: TasteSnapshot, items: readonly TasteItem[], now: Date): string {
  const counts = new Map<TasteKind, number>()
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  const parts = COUNT_ORDER.filter(([kind]) => counts.has(kind)).map(([kind, label]) => label(counts.get(kind)!))
  const age = (now.getTime() - new Date(snapshot.takenAt).getTime()) / 86_400_000
  const stale = Number.isFinite(age) && age > STALE_DAYS ? `; as of ${day(snapshot.takenAt)}` : ''
  return `${SOURCE_NAMES[snapshot.source]} (${parts.join(', ')}${stale})`
}

// Join until the character bound, cut at an item boundary with an ellipsis.
// A first part that does not fit on its own yields nothing: over-running the
// bound would cost the whole line at the block-level cut, and the room it
// leaves goes to the next layer instead.
function joinCapped(parts: readonly string[], sep: string, max: number): string {
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const next = out === '' ? parts[i]! : `${out}${sep}${parts[i]!}`
    // Every part but the last leaves room for the ellipsis a cut after it
    // would need, so the cut itself can never take the line past `max`.
    if (next.length + (i === parts.length - 1 ? 0 : sep.length + 1) > max) {
      return out === '' ? '' : `${out}${sep}\u2026`
    }
    out = next
  }
  return out
}

const quoted = (item: TasteItem): string =>
  item.artist === undefined || item.artist.trim() === '' ? `"${item.title}"` : `"${item.title}" ${item.artist.trim()}`

const watched = (item: TasteItem): string =>
  item.category === undefined || item.category.trim() === '' ? quoted(item) : `${quoted(item)} (${item.category.trim()})`

// Bilibili's music sub-zones, escaped because committed sources hold no CJK
// (DESIGN §0). Romanised, in order: guo chan yuan chuang xiang guan (original
// music), fan chang (covers), VOCALOID-UTAU, yan zou (performance), yin yue
// xian chang (live), yin yue zong he (general), yue ping pan dian (reviews),
// yin yue jiao xue (teaching), dian yin (electronic), shuo chang (rap). Any
// zone whose name contains yin yue ("music") counts too, so a renamed or new
// music sub-zone still floats.
const MUSIC_ZONES = new Set([
  '\u56fd\u4ea7\u539f\u521b\u76f8\u5173',
  '\u7ffb\u5531',
  'VOCALOID\u00b7UTAU',
  '\u6f14\u594f',
  '\u97f3\u4e50\u73b0\u573a',
  '\u97f3\u4e50\u7efc\u5408',
  '\u4e50\u8bc4\u76d8\u70b9',
  '\u97f3\u4e50\u6559\u5b66',
  '\u7535\u97f3',
  '\u8bf4\u5531',
  'MV',
])
const MUSIC_WORD = '\u97f3\u4e50'

export function isMusicCategory(category: string | undefined): boolean {
  if (category === undefined) return false
  const name = category.trim()
  return MUSIC_ZONES.has(name) || name.includes(MUSIC_WORD)
}

// Only these rows are a musical taste: a watched video's uploader is not an
// artist, and neither is a channel the listener follows (spec 14 §2.3).
const MUSICAL: readonly TasteKind[] = ['liked', 'top-artist', 'top-track', 'daily']

// Platforms whose catalogue is songs: every row they return is music by
// construction, which is the guarantee spec 14 §2.3's invariant asks for.
// YouTube and Bilibili are video platforms and carry no such guarantee.
const SONGS_ONLY: readonly SourceId[] = ['netease', 'qqmusic', 'spotify', 'qishui']

// The only kinds a line of the block is ever built from. Everything else --
// a followed account, a subscription, a favourites folder's contents -- is
// retrieval material, and is not counted on the Sources line either: that
// line must not claim what the block cannot show.
const SHOWN: readonly TasteKind[] = ['liked', 'history', 'playlist', 'top-artist', 'top-track', 'daily']

// Every row in the block traces to a songs-only source or to an artist name
// (spec 14 §2.3). Measured on the listener's own snapshot: of 200 Bilibili
// history rows, 4 carried a music sub-zone and 3 of those were gossip clips
// their uploader had filed there, so the platform's own tag is not a
// guarantee. It survives as a scoring signal for the retrieval pool.
function shown(source: SourceId, item: TasteItem): boolean {
  if (item.title.trim() === '' || !SHOWN.includes(item.kind)) return false
  // A Bilibili playlist is a favourites folder, and YouTube's liked list is
  // collected rather than kept (the listener's decision, 2026-09-16).
  if (source === 'bilibili' && item.kind === 'playlist') return false
  if (source === 'youtube' && item.kind === 'liked') return false
  return item.kind !== 'history' || SONGS_ONLY.includes(source)
}

// One line of the block. `weight` is its claim on what is left of the half's
// budget when its turn comes; whatever it does not spend rolls to the next.
type Layer = { lead: string; parts: readonly string[]; sep: string; weight: number }

// Render the layers that have something to say, and answer with what they
// spent. Equal shares are the case where every weight is 1.
function emit(lines: string[], layers: readonly Layer[], budget: number): number {
  const pending = layers.filter((l) => l.parts.length > 0)
  let weightLeft = pending.reduce((n, l) => n + l.weight, 0)
  let used = 0
  for (const { lead, parts, sep, weight } of pending) {
    // lead + ': ' + the newline this line adds + the two the block-level cut
    // keeps for its own trailing ellipsis (codex review).
    const share = Math.floor(((budget - used) * weight) / weightLeft) - lead.length - 5
    weightLeft -= weight
    const text = joinCapped(parts, sep, Math.max(share, 0))
    if (text === '') continue
    const line = `${lead}: ${text}`
    lines.push(line)
    used += line.length + 1
  }
  return used
}

// The platforms' own rankings, kept apart from the merged view: a top list
// is the platform's word, not a count of anything. They ride the flexible
// half's budget like every other line -- appended after it was spent, they
// were dropped whole by the block-level cut while the Sources line went on
// counting them (codex review).
function platformLayers(kept: readonly { snapshot: TasteSnapshot; items: readonly TasteItem[] }[]): Layer[] {
  const layers: Layer[] = []
  for (const { snapshot, items } of kept) {
    const top = (kind: TasteKind): TasteItem[] => items.filter((i) => i.kind === kind).slice(0, PLATFORM_LIST)
    const topArtists = top('top-artist')
    const topTracks = top('top-track')
    if (topArtists.length + topTracks.length > 0) {
      layers.push({
        lead: `${SOURCE_NAMES[snapshot.source]} says (top, medium term)`,
        parts: [
          ...(topArtists.length > 0 ? [`artists \u2014 ${topArtists.map((i) => i.title.trim()).join(', ')}`] : []),
          ...(topTracks.length > 0 ? [`tracks \u2014 ${topTracks.map(quoted).join(', ')}`] : []),
        ],
        sep: '; ',
        weight: 1,
      })
    }
    const daily = top('daily')
    if (daily.length > 0) layers.push({ lead: `${SOURCE_NAMES[snapshot.source]} suggests today`, parts: daily.map(quoted), sep: ', ', weight: 1 })
  }
  return layers
}

export function renderTasteDigest(
  snapshots: readonly TasteSnapshot[],
  now: Date,
  budget = DIGEST_BUDGET,
  // "They return to" is a claim about months. A snapshot is one read inside
  // a rolling window, so the count comes from the source's ledger when there
  // is one (spec 14 §2.3, §2.11) and from the snapshot when there is not.
  ledgers: readonly LedgerView[] = [],
  // The pick's moment (spec 14 §2.12). Given one, the flexible half's rows are
  // chosen against the ledger for the pick that is happening instead of
  // rendered newest first. The context pack passes none and keeps today's
  // memoised render.
  moment?: Moment,
): string {
  if (snapshots.length === 0) return ''
  // The render holds the invariant on ANY snapshot, not only a freshly read
  // one: a returning listener keeps yesterday's file until the next refresh,
  // and that file must not paint what it painted yesterday.
  const kept = snapshots
    .map((s) => ({ snapshot: s, items: s.items.filter((i) => shown(s.source, i)) }))
    // A snapshot left with nothing to say is not a source line.
    .filter((k) => k.items.length > 0)
  if (kept.length === 0) return ''
  const newest = kept.map((k) => k.snapshot.takenAt).sort().at(-1)!
  const lines: string[] = [`## What the listener keeps (as of ${day(newest)})`]

  // Artists merge across sources by exact string after trim; a top-artist row
  // names the artist in its title.
  const artists = new Map<string, number>()
  const byLedger = new Map(ledgers.map((l) => [l.source, l]))
  const countArtist = (item: TasteItem): void => {
    if (!MUSICAL.includes(item.kind)) return
    const name = (item.kind === 'top-artist' ? item.title : (item.artist ?? '')).trim()
    if (name !== '') artists.set(name, (artists.get(name) ?? 0) + 1)
  }
  for (const [source, ledger] of byLedger) {
    // The invariant holds over the ledger too: it carries every row that was
    // ever read, including the watch rows the block never shows.
    for (const item of ledger.entries) if (shown(source, item)) countArtist(item)
  }
  const lately: { item: TasteItem; order: number }[] = []
  const songs: { item: TasteItem; order: number }[] = []
  const playlists: string[] = []
  let order = 0
  for (const { snapshot, items } of kept) {
    for (const item of items) {
      order++
      // Only when this source has no ledger: otherwise the ledger already
      // counted it, and counting both would double every current row.
      if (!byLedger.has(snapshot.source)) countArtist(item)
      if (item.kind === 'history') lately.push({ item, order })
      if (item.kind === 'liked') songs.push({ item, order })
      if (item.kind === 'playlist') playlists.push(item.title.trim())
    }
  }

  // Newest first by the platform's own date; undated rows after, in the order
  // the snapshots listed them.
  const byDate = (a: { item: TasteItem; order: number }, b: { item: TasteItem; order: number }): number => {
    const at = (x: { item: TasteItem }): string => x.item.at ?? ''
    if (at(a) !== at(b)) return at(a) === '' ? 1 : at(b) === '' ? -1 : byName(at(b), at(a))
    return a.order - b.order
  }

  lately.sort(byDate)
  songs.sort(byDate)
  // The moment-matched half. Per source: a source with a usable ledger is
  // chosen from it, and a source whose ledger is missing, unreadable or
  // empty keeps the rows its snapshot already has -- otherwise the pick
  // silently loses a whole account while the Sources line goes on counting
  // it. `quiet` is "the last read of this row's own list did not return
  // it", per kind, because a partial refresh moves one list's clock and not
  // the others'.
  const matched =
    moment === undefined
      ? null
      : selectForMoment(
          kept.flatMap(({ snapshot, items }): MomentCandidate[] => {
            const ledger = byLedger.get(snapshot.source)
            if (ledger === undefined || ledger.entries.length === 0) {
              return items.map((item, order) => ({ item, lastSeen: snapshot.takenAt, quiet: false, order }))
            }
            return ledger.entries
              .filter((item) => shown(snapshot.source, item))
              .map((item, order) => ({
                item,
                lastSeen: item.lastSeen ?? '',
                quiet: item.lastSeen !== undefined && (ledger.lastRead?.[item.kind] ?? '') > item.lastSeen,
                order,
              }))
          }),
          moment,
        )

  // The fixed half: who this listener is, in the fewest words, the same on
  // every pick of the day. Sources is served first, out of half the half --
  // an equal third would starve it (it is one phrase per mounted source and
  // cannot be shortened by dropping items), and the whole half would starve
  // the other two, which is what six verbose summaries did in review.
  const sources: Layer[] = [{ lead: 'Sources', parts: kept.map((k) => sourceSummary(k.snapshot, k.items, now)), sep: ', ', weight: 1 }]
  const shape: Layer[] = [
    { lead: 'Artists they return to', parts: [...artists.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0])).slice(0, TOP_ARTISTS).map(([name, n]) => `${name} (${n})`), sep: ', ', weight: 1 },
    { lead: 'Playlists', parts: playlists.slice(0, PLAYLIST_NAMES), sep: ', ', weight: 1 },
  ]
  // The flexible half. For choosing a song the kept songs ARE the signal and
  // the watch rows are context, so the weights run 3 to 1. Measured with the
  // watch rows leading instead: 14 of 186 kept songs reached the page.
  const flexible: Layer[] = [
    { lead: 'Songs they keep', parts: (matched?.songs ?? songs.map((r) => r.item)).slice(0, SONG_ITEMS).map(quoted), sep: ' \u00b7 ', weight: 3 },
    { lead: 'Lately they have been listening to', parts: (matched?.lately ?? lately.map((r) => r.item)).slice(0, WATCH_ITEMS).map(watched), sep: ' \u00b7 ', weight: 1 },
  ]
  let used = lines[0]!.length
  const fixedBudget = Math.max(Math.min(Math.floor(budget * FIXED_SHARE), budget - used), 0)
  const onSources = emit(lines, sources, Math.floor(fixedBudget / 2))
  used += onSources + emit(lines, shape, Math.max(fixedBudget - onSources, 0))
  used += emit(lines, [...flexible, ...platformLayers(kept)], Math.max(budget - used, 0))

  // Cut at a line boundary with a trailing ellipsis (spec 14 §2.3).
  let out = ''
  for (const line of lines) {
    const next = out === '' ? line : `${out}\n${line}`
    if (next.length + 2 > budget) return `${out}\n…`
    out = next
  }
  return out
}

export type TasteReaderDeps = {
  dir: string
  // What is mounted right now (spec 14 §5.1): a snapshot file can outlive
  // its mount — a corrupt sources.json, a process that died between the
  // unmount and the delete — and a leftover file must not keep sending an
  // account's titles to the brain. Absent = render whatever is on disk.
  mounted?: () => readonly SourceId[]
  log?: (message: string) => void
  now?: () => Date
}

// Reads data/taste/*.json at pack time (spec 14 §3.2): the files are small and
// few, so a stat per call is the whole cost; the render runs only when a file
// appeared, vanished or changed.
export class TasteReader {
  private deps: TasteReaderDeps
  private key = ''
  private cached = ''
  private parsed: { snapshots: TasteSnapshot[]; ledgers: LedgerView[] } = { snapshots: [], ledgers: [] }
  private warned = new Set<string>()
  // How many static renders ran, and how many times the files were parsed;
  // the memoisation's own evidence. A moment renders every time by design
  // (it is a different question each pick) but must never re-read.
  renders = 0
  parses = 0

  constructor(deps: TasteReaderDeps) {
    this.deps = deps
  }

  // With no moment: the memoised render the context pack reads. With one:
  // the flexible half chosen against the ledger for this pick (spec 14
  // §2.12), off the same parsed files.
  digest(moment?: Moment): string {
    const mounted = this.deps.mounted?.()
    let names: string[]
    try {
      // `<source>.ledger.json` sits in the same directory and is read
      // below, never here: parsed as a snapshot it would fail and warn.
      names = readdirSync(this.deps.dir)
        .filter((n) => n.endsWith('.json') && !n.endsWith('.ledger.json'))
        .filter((n) => mounted === undefined || mounted.includes(n.slice(0, -'.json'.length) as SourceId))
        .sort()
    } catch {
      return ''
    }
    if (names.length === 0) {
      this.key = ''
      this.cached = ''
      this.parsed = { snapshots: [], ledgers: [] }
      return ''
    }
    const stamp = (name: string): { path: string; key: string; size: number } | null => {
      const path = join(this.deps.dir, name)
      try {
        const stat = statSync(path)
        return { path, key: `${name}:${stat.mtimeMs}:${stat.size}`, size: stat.size }
      } catch {
        return null
      }
    }
    const files = names.map(stamp)
    // The ledgers ride the same memoisation: an artist count that moved is a
    // digest that changed, even when no snapshot did.
    const ledgerFiles = names.map((n) => stamp(`${n.slice(0, -'.json'.length)}.ledger.json`))
    const key = [...files, ...ledgerFiles].map((f) => f?.key ?? '').join('|')
    if (key !== this.key) {
      const snapshots: TasteSnapshot[] = []
      for (const file of files) {
        if (file === null) continue
        const parsed = this.readSnapshot(file)
        if (parsed !== null) snapshots.push(parsed)
      }
      // A fixed order, so the digest never depends on directory listing order.
      snapshots.sort((a, b) => SOURCE_IDS.indexOf(a.source) - SOURCE_IDS.indexOf(b.source))
      const ledgers = ledgerFiles.flatMap((file) => {
        const parsed = file === null ? null : this.readLedger(file)
        return parsed === null ? [] : [parsed]
      })
      this.parses++
      this.parsed = { snapshots, ledgers }
      this.key = key
      this.cached = this.render()
      this.renders++
    }
    // A moment is a different question every pick, so it is never cached --
    // but it costs the render alone, never a re-read.
    return moment === undefined ? this.cached : this.render(moment)
  }

  private render(moment?: Moment): string {
    const { snapshots, ledgers } = this.parsed
    return renderTasteDigest(snapshots, (this.deps.now ?? (() => new Date()))(), DIGEST_BUDGET, ledgers, moment)
  }

  // Only what the digest needs from a ledger: the source and its rows. A
  // ledger that will not parse is skipped in silence -- the refresher owns
  // repairing it (spec 14 §2.11), and the digest still has the snapshot.
  private readLedger(file: { path: string; key: string; size: number }): LedgerView | null {
    if (file.size > LEDGER_MAX_BYTES) return null
    try {
      const parsed = LedgerCountsSchema.safeParse(JSON.parse(readFileSync(file.path, 'utf-8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  private readSnapshot(file: { path: string; key: string; size: number }): TasteSnapshot | null {
    const warn = (why: string): null => {
      if (!this.warned.has(file.key)) {
        this.warned.add(file.key)
        this.deps.log?.(`taste: skipping ${file.path} (${why})`)
      }
      return null
    }
    if (file.size > SNAPSHOT_MAX_BYTES) return warn('over the size bound')
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file.path, 'utf-8'))
    } catch {
      return warn('not JSON')
    }
    const parsed = TasteSnapshotSchema.safeParse(raw)
    return parsed.success ? parsed.data : warn('not a snapshot')
  }
}
