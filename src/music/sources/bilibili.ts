// Bilibili as a taste source (spec 14 §2.8): a small client over the web
// APIs yt-dlp's own extractors read — nav (who, mid), the favourite folders,
// a folder's contents, watch later, the account's audio uploads — with the
// browser's cookie. The lists are read here rather than through yt-dlp's
// flat output because that output carries ids alone, and a taste is titles.
// Playback of a favourite still goes through yt-dlp (§2.5).

import { z } from 'zod'

import { SourceAuthError } from './auth.ts'
import type { MountResult } from './netease.ts'
import type { BrowserName } from './store.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const API = 'https://api.bilibili.com'
const DEFAULT_TIMEOUT_MS = 15_000
// The API's page size for a folder; pages are read until the bound or the end.
const FOLDER_PAGE = 20
const AUDIO_PAGE = 30

export type BilibiliFetch = (url: string, init?: RequestInit) => Promise<Response>

export type BilibiliClientDeps = {
  cookie: () => Promise<string>
  fetch?: BilibiliFetch
  timeoutMs?: number
  now?: () => Date
}

const EnvelopeSchema = z.object({ code: z.number(), message: z.string().optional() })
const NavSchema = z.object({ data: z.object({ isLogin: z.boolean().optional(), uname: z.string().optional(), mid: z.number().optional() }) })
const FoldersSchema = z.object({ data: z.object({ list: z.array(z.object({ id: z.number(), title: z.string(), media_count: z.number().optional() })).nullish() }).nullish() })
const MediaSchema = z.object({
  title: z.string(),
  upper: z.object({ name: z.string().optional() }).nullish(),
  bvid: z.string().optional(),
  fav_time: z.number().optional(),
})
const FavListSchema = z.object({ data: z.object({ medias: z.array(z.unknown()).nullish(), has_more: z.boolean().optional() }).nullish() })
const ToViewSchema = z.object({ data: z.object({ list: z.array(z.unknown()).nullish() }).nullish() })
const LaterSchema = z.object({ title: z.string(), owner: z.object({ name: z.string().optional() }).nullish(), bvid: z.string().optional(), add_at: z.number().optional() })
const AudioPageSchema = z.object({ data: z.object({ pageCount: z.number().optional(), data: z.array(z.unknown()).nullish() }).nullish() })
const AudioSchema = z.object({ id: z.number(), title: z.string(), author: z.string().optional() })

export type BilibiliFolder = { id: string; title: string; count: number }

const stamp = (seconds: number | undefined): { at?: string } => (seconds === undefined ? {} : { at: new Date(seconds * 1000).toISOString() })
const withArtist = (name: string | undefined): { artist?: string } => (name === undefined || name.trim() === '' ? {} : { artist: name.trim() })

export class BilibiliClient {
  private deps: BilibiliClientDeps
  private fetch: BilibiliFetch

  constructor(deps: BilibiliClientDeps) {
    this.deps = deps
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
  }

  // null = the cookie carries no login.
  async nav(): Promise<{ mid: string; who: string } | null> {
    const json = await this.get('/x/web-interface/nav', {}, { anonymousOk: true })
    const parsed = NavSchema.safeParse(json)
    if (!parsed.success || parsed.data.data.isLogin !== true || parsed.data.data.mid === undefined) return null
    return { mid: String(parsed.data.data.mid), who: parsed.data.data.uname ?? 'your Bilibili account' }
  }

  async folders(mid: string): Promise<BilibiliFolder[]> {
    const parsed = FoldersSchema.parse(await this.get('/x/v3/fav/folder/created/list-all', { up_mid: mid }))
    return (parsed.data?.list ?? []).map((f) => ({ id: String(f.id), title: f.title, count: f.media_count ?? 0 }))
  }

  async folderItems(folderId: string, bound: number): Promise<TasteItem[]> {
    const items: TasteItem[] = []
    for (let page = 1; items.length < bound; page++) {
      const parsed = FavListSchema.parse(await this.get('/x/v3/fav/resource/list', { media_id: folderId, pn: String(page), ps: String(FOLDER_PAGE) }))
      const medias = parsed.data?.medias ?? []
      for (const raw of medias) {
        const media = MediaSchema.safeParse(raw)
        if (!media.success || media.data.title.trim() === '' || media.data.bvid === undefined) continue
        items.push({
          kind: 'favourite',
          title: media.data.title,
          ...withArtist(media.data.upper?.name),
          ...stamp(media.data.fav_time),
          ref: `https://www.bilibili.com/video/${media.data.bvid}`,
        })
      }
      if (medias.length < FOLDER_PAGE || parsed.data?.has_more === false) break
    }
    return items.slice(0, bound)
  }

  async watchLater(): Promise<TasteItem[]> {
    const parsed = ToViewSchema.parse(await this.get('/x/v2/history/toview/web', { jsonp: 'jsonp' }))
    const items: TasteItem[] = []
    for (const raw of parsed.data?.list ?? []) {
      const row = LaterSchema.safeParse(raw)
      if (!row.success || row.data.title.trim() === '' || row.data.bvid === undefined) continue
      items.push({ kind: 'favourite', title: row.data.title, ...withArtist(row.data.owner?.name), ...stamp(row.data.add_at), ref: `https://www.bilibili.com/video/${row.data.bvid}` })
    }
    return items
  }

  // The account's own audio uploads: kept as liked — they are the listener's
  // by definition.
  async spaceAudio(mid: string, bound: number): Promise<TasteItem[]> {
    const items: TasteItem[] = []
    for (let page = 1; items.length < bound; page++) {
      const parsed = AudioPageSchema.parse(await this.get('/audio/music-service/web/song/upper', { uid: mid, pn: String(page), ps: String(AUDIO_PAGE), order: '1', jsonp: 'jsonp' }))
      for (const raw of parsed.data?.data ?? []) {
        const song = AudioSchema.safeParse(raw)
        if (!song.success || song.data.title.trim() === '') continue
        items.push({ kind: 'liked', title: song.data.title, ...withArtist(song.data.author), ref: `https://www.bilibili.com/audio/au${song.data.id}` })
      }
      if (page >= (parsed.data?.pageCount ?? 0)) break
    }
    return items.slice(0, bound)
  }

  // One GET with the cookie, a timeout and one retry on a network error. A
  // -101 (not logged in) is the typed login failure everywhere but the nav
  // read, whose anonymous answer is a plain "no account".
  private async get(path: string, query: Record<string, string>, opts: { anonymousOk?: boolean } = {}): Promise<unknown> {
    const url = new URL(`${API}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const init: RequestInit = {
      headers: {
        Cookie: await this.deps.cookie(),
        Referer: 'https://www.bilibili.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
    }
    let response: Response
    try {
      response = await this.once(url.toString(), init)
    } catch {
      response = await this.once(url.toString(), init)
    }
    if (response.status === 429 || response.status === 412) throw new SourceAuthError('bilibili', 'rate-limited', `HTTP ${response.status} on ${path}`)
    if (!response.ok) throw new Error(`bilibili ${path}: HTTP ${response.status}`)
    const json: unknown = await response.json()
    const envelope = EnvelopeSchema.safeParse(json)
    if (envelope.success && envelope.data.code === -101 && opts.anonymousOk !== true) {
      throw new SourceAuthError('bilibili', 'login-required', `code -101 on ${path}`)
    }
    if (envelope.success && envelope.data.code !== 0 && envelope.data.code !== -101) {
      throw new Error(`bilibili ${path}: code ${envelope.data.code} ${envelope.data.message ?? ''}`.trim())
    }
    return json
  }

  private async once(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      return await this.fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

export type BilibiliEntry = { browser: BrowserName; profile?: string | undefined; mid: string }

export async function mountBilibili(
  browser: { browser: BrowserName; profile?: string | undefined },
  deps: BilibiliClientDeps,
): Promise<MountResult<BilibiliEntry>> {
  const nav = await new BilibiliClient(deps).nav()
  if (nav === null) return { ok: false, reason: 'login-required' }
  return { ok: true, who: nav.who, entry: { browser: browser.browser, ...(browser.profile !== undefined && { profile: browser.profile }), mid: nav.mid } }
}

export class BilibiliSource implements TasteSource {
  readonly id = 'bilibili' as const
  private entry: BilibiliEntry
  private client: BilibiliClient
  private now: () => Date

  constructor(entry: BilibiliEntry, deps: BilibiliClientDeps) {
    this.entry = entry
    this.client = new BilibiliClient(deps)
    this.now = deps.now ?? (() => new Date())
  }

  async verify(): Promise<VerifyResult> {
    const nav = await this.client.nav()
    return nav === null ? { ok: false, reason: 'login-required' } : { ok: true, who: nav.who }
  }

  // Folder names first, then the favourites (folders in the account's own
  // order until the bound), watch later, and the account's audio uploads.
  async snapshot(): Promise<TasteSnapshot> {
    const folders = (await this.client.folders(this.entry.mid)).slice(0, BOUNDS.playlist)
    const items: TasteItem[] = folders.map((f): TasteItem => ({ kind: 'playlist', title: f.title }))
    const favourites: TasteItem[] = []
    for (const folder of folders) {
      if (favourites.length >= BOUNDS.liked) break
      if (folder.count === 0) continue
      favourites.push(...(await this.client.folderItems(folder.id, BOUNDS.liked - favourites.length)))
    }
    items.push(...favourites, ...(await this.client.watchLater()), ...(await this.client.spaceAudio(this.entry.mid, BOUNDS.liked)))
    return { source: 'bilibili', takenAt: this.now().toISOString(), items }
  }
}
