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

const KINDS = ['liked', 'history', 'top-track', 'top-artist', 'playlist', 'favourite', 'subscription', 'daily'] as const
export type TasteKind = (typeof KINDS)[number]

const TasteItemSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string(),
  artist: z.string().optional(),
  album: z.string().optional(),
  at: z.string().optional(),
  ref: z.string().optional(),
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
export const BOUNDS = { liked: 500, history: 200, playlist: 50, top: 50, subscription: 100 } as const

// A snapshot file past the byte cap is a bug in the adapter that wrote it,
// and is skipped rather than fed to a prompt.
export const SNAPSHOT_MAX_BYTES = 1024 * 1024
export const DIGEST_BUDGET = 1500
const TOP_ARTISTS = 25
const RECENT_ITEMS = 20
const PLAYLIST_NAMES = 12
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

const quoted = (item: TasteItem): string =>
  item.artist === undefined || item.artist.trim() === '' ? `"${item.title}"` : `"${item.title}" ${item.artist.trim()}`

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
  const recent: { item: TasteItem; order: number }[] = []
  const playlists: string[] = []
  let order = 0
  for (const { items } of kept) {
    for (const item of items) {
      order++
      const name = (item.kind === 'top-artist' ? item.title : (item.artist ?? '')).trim()
      if (name !== '' && item.kind !== 'playlist' && item.kind !== 'subscription') {
        artists.set(name, (artists.get(name) ?? 0) + 1)
      }
      if (item.kind === 'liked' || item.kind === 'favourite') recent.push({ item, order })
      if (item.kind === 'playlist') playlists.push(item.title.trim())
    }
  }
  const ranked = [...artists.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0])).slice(0, TOP_ARTISTS)
  if (ranked.length > 0) lines.push(`Artists they return to: ${ranked.map(([name, n]) => `${name} (${n})`).join(', ')}`)

  // Newest first by the platform's own date; undated rows after, in the order
  // the snapshots listed them.
  recent.sort((a, b) => {
    const at = (x: { item: TasteItem }): string => x.item.at ?? ''
    if (at(a) !== at(b)) return at(a) === '' ? 1 : at(b) === '' ? -1 : byName(at(b), at(a))
    return a.order - b.order
  })
  if (recent.length > 0) {
    lines.push(`Recently kept: ${recent.slice(0, RECENT_ITEMS).map((r) => quoted(r.item)).join(' · ')}`)
  }
  if (playlists.length > 0) lines.push(`Playlists: ${playlists.slice(0, PLAYLIST_NAMES).join(', ')}`)

  // The platforms' own rankings, kept apart from the merged view: a top list
  // is the platform's word, not a count of anything.
  for (const { snapshot, items } of kept) {
    const topArtists = items.filter((i) => i.kind === 'top-artist').slice(0, PLATFORM_LIST)
    const topTracks = items.filter((i) => i.kind === 'top-track').slice(0, PLATFORM_LIST)
    if (topArtists.length + topTracks.length > 0) {
      const parts = [
        ...(topArtists.length > 0 ? [`artists — ${topArtists.map((i) => i.title.trim()).join(', ')}`] : []),
        ...(topTracks.length > 0 ? [`tracks — ${topTracks.map(quoted).join(', ')}`] : []),
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
    let names: string[]
    try {
      names = readdirSync(this.deps.dir).filter((n) => n.endsWith('.json')).sort()
    } catch {
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
