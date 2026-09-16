// The taste digest (spec 14 §2.3): what the listener keeps on the platforms
// they opted in, rendered as one bounded markdown block the pick task and the
// context pack read. A pure function of the snapshots — same inputs, same
// text — so it is testable on fixtures and costs no model call. The reader
// beside it memoises the render on the snapshot files' mtimes.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import type { AuthFailure } from './auth.ts'

export const SOURCE_IDS = ['youtube', 'bilibili', 'netease', 'spotify', 'qishui'] as const
export type SourceId = (typeof SOURCE_IDS)[number]

// How a platform is named on screen and in the digest.
export const SOURCE_NAMES: Record<SourceId, string> = {
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  netease: 'NetEase',
  spotify: 'Spotify',
  qishui: 'Soda Music',
}

const KINDS = ['liked', 'history', 'top-track', 'top-artist', 'playlist', 'favourite', 'subscription', 'daily', 'follows', 'frequents'] as const
export type TasteKind = (typeof KINDS)[number]

const TasteItemSchema = z.object({
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
  verify(): Promise<VerifyResult>
  // May throw SourceAuthError; any other failure is a plain error.
  snapshot(): Promise<TasteSnapshot>
}

// The per-source bounds (spec 14 §3.5).
export const BOUNDS = { liked: 500, history: 200, playlist: 50, top: 50, subscription: 100, follows: 50 } as const

// A snapshot file past the byte cap is a bug in the adapter that wrote it,
// and is skipped rather than fed to a prompt.
export const SNAPSHOT_MAX_BYTES = 1024 * 1024
export const DIGEST_BUDGET = 1500
const TOP_ARTISTS = 25
const RECENT_ITEMS = 20
const CHANNEL_NAMES = 12
const PLAYLIST_NAMES = 12
// Every layer gets an equal share of what is left when its turn comes, and
// whatever it does not use rolls forward to the next. Found on a real
// snapshot: 200 watched rows with long titles filled the whole block by
// themselves and the musical source beside them never reached the page.
const PLATFORM_LIST = 10
const STALE_DAYS = 30

const day = (iso: string): string => iso.slice(0, 10)

// Code-unit order, not locale order: the digest must render the same on every
// machine, and a locale collation would not.
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const COUNT_ORDER: [TasteKind, (n: number) => string][] = [
  ['liked', (n) => `${n} liked`],
  ['favourite', (n) => `${n} favourite${n === 1 ? '' : 's'}`],
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
function joinCapped(parts: readonly string[], sep: string, max: number): string {
  let out = ''
  for (const part of parts) {
    const next = out === '' ? part : `${out}${sep}${part}`
    if (next.length > max) return out === '' ? part : `${out}${sep}\u2026`
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
const MUSICAL: readonly TasteKind[] = ['liked', 'favourite', 'top-artist', 'top-track', 'daily']

export function renderTasteDigest(snapshots: readonly TasteSnapshot[], now: Date, budget = DIGEST_BUDGET): string {
  if (snapshots.length === 0) return ''
  // Items whose title is empty are dropped everywhere, counts included.
  const kept = snapshots.map((s) => ({ snapshot: s, items: s.items.filter((i) => i.title.trim() !== '') }))
  const newest = kept.map((k) => k.snapshot.takenAt).sort().at(-1)!
  const lines: string[] = [
    `## What the listener keeps (as of ${day(newest)})`,
    `Sources: ${kept.map((k) => sourceSummary(k.snapshot, k.items, now)).join(', ')}`,
  ]

  // Artists merge across sources by exact string after trim; a top-artist row
  // names the artist in its title.
  const artists = new Map<string, number>()
  const lately: { item: TasteItem; order: number }[] = []
  const songs: { item: TasteItem; order: number }[] = []
  const follows: { item: TasteItem; order: number }[] = []
  const frequents: string[] = []
  const playlists: string[] = []
  let order = 0
  for (const { items } of kept) {
    for (const item of items) {
      order++
      if (MUSICAL.includes(item.kind)) {
        const name = (item.kind === 'top-artist' ? item.title : (item.artist ?? '')).trim()
        if (name !== '') artists.set(name, (artists.get(name) ?? 0) + 1)
      }
      if (item.kind === 'history') lately.push({ item, order })
      if (item.kind === 'liked' || item.kind === 'favourite') songs.push({ item, order })
      if (item.kind === 'follows') follows.push({ item, order })
      if (item.kind === 'frequents') frequents.push(item.title.trim())
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

  // What they have been listening to and watching leads the digest, and a
  // music-zone row outranks a cooking one inside it (spec 14 §2.3).
  lately.sort((a, b) => {
    const rank = (x: { item: TasteItem }): number => (isMusicCategory(x.item.category) ? 0 : 1)
    return rank(a) - rank(b) || byDate(a, b)
  })
  follows.sort(byDate)
  songs.sort(byDate)
  const layers: [string, readonly string[], string][] = [
    ['Lately they have been listening to / watching', lately.slice(0, RECENT_ITEMS).map((r) => watched(r.item)), ' \u00b7 '],
    ['Recently followed', follows.slice(0, CHANNEL_NAMES).map((f) => f.item.title.trim()), ', '],
    ['Who they keep going back to', frequents.slice(0, CHANNEL_NAMES), ', '],
    ['Artists they return to', [...artists.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0])).slice(0, TOP_ARTISTS).map(([name, n]) => `${name} (${n})`), ', '],
    // The playlist names are short and are the listener's own words for a
    // mood; the song list is the long tail, so it speaks last and takes the
    // room the others left.
    ['Playlists', playlists.slice(0, PLAYLIST_NAMES), ', '],
    ['Songs they keep', songs.slice(0, RECENT_ITEMS).map((r) => quoted(r.item)), ' \u00b7 '],
  ]
  const pending = layers.filter(([, parts]) => parts.length > 0)
  let used = lines.join('\n').length
  pending.forEach(([lead, parts, sep], i) => {
    const share = Math.floor((budget - used) / (pending.length - i)) - lead.length - 3
    const text = joinCapped(parts, sep, Math.max(share, 0))
    if (text === '') return
    const line = `${lead}: ${text}`
    lines.push(line)
    used += line.length + 1
  })

  // The platforms' own rankings, kept apart from the merged view: a top list
  // is the platform's word, not a count of anything.
  for (const { snapshot, items } of kept) {
    const topArtists = items.filter((i) => i.kind === 'top-artist').slice(0, PLATFORM_LIST)
    const topTracks = items.filter((i) => i.kind === 'top-track').slice(0, PLATFORM_LIST)
    if (topArtists.length + topTracks.length > 0) {
      const parts = [
        ...(topArtists.length > 0 ? [`artists \u2014 ${topArtists.map((i) => i.title.trim()).join(', ')}`] : []),
        ...(topTracks.length > 0 ? [`tracks \u2014 ${topTracks.map(quoted).join(', ')}`] : []),
      ]
      lines.push(`${SOURCE_NAMES[snapshot.source]} says (top, medium term): ${parts.join('; ')}`)
    }
    const daily = items.filter((i) => i.kind === 'daily').slice(0, PLATFORM_LIST)
    if (daily.length > 0) lines.push(`${SOURCE_NAMES[snapshot.source]} suggests today: ${daily.map(quoted).join(', ')}`)
  }

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
  private warned = new Set<string>()
  // How many renders ran; the memoisation's own evidence.
  renders = 0

  constructor(deps: TasteReaderDeps) {
    this.deps = deps
  }

  digest(): string {
    const mounted = this.deps.mounted?.()
    let names: string[]
    try {
      names = readdirSync(this.deps.dir)
        .filter((n) => n.endsWith('.json'))
        .filter((n) => mounted === undefined || mounted.includes(n.slice(0, -'.json'.length) as SourceId))
        .sort()
    } catch {
      return ''
    }
    if (names.length === 0) {
      this.key = ''
      this.cached = ''
      return ''
    }
    const files = names.map((name) => {
      const path = join(this.deps.dir, name)
      try {
        const stat = statSync(path)
        return { path, key: `${name}:${stat.mtimeMs}:${stat.size}`, size: stat.size }
      } catch {
        return null
      }
    })
    const key = files.map((f) => f?.key ?? '').join('|')
    if (key === this.key) return this.cached
    const snapshots: TasteSnapshot[] = []
    for (const file of files) {
      if (file === null) continue
      const parsed = this.readSnapshot(file)
      if (parsed !== null) snapshots.push(parsed)
    }
    // A fixed order, so the digest never depends on directory listing order.
    snapshots.sort((a, b) => SOURCE_IDS.indexOf(a.source) - SOURCE_IDS.indexOf(b.source))
    this.renders++
    this.cached = renderTasteDigest(snapshots, (this.deps.now ?? (() => new Date()))())
    this.key = key
    return this.cached
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
