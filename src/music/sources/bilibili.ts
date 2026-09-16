// Bilibili as a taste source (spec 14 §2.8): a small client over the web
// APIs yt-dlp's own extractors read — nav (who, mid), the watch history, the
// accounts followed, the account's audio uploads — with the browser's cookie.
// The lists are read here rather than through yt-dlp's flat output because
// that output carries ids alone, and a taste is titles. What the listener
// collected into a favourites folder is deliberately not read: a folder is
// where a course or a recipe is filed, and the taste is what they watched
// and who they follow (§2.3). Playback still goes through yt-dlp (§2.5).

import { z } from 'zod'

import { SourceAuthError } from './auth.ts'
import { setCookieHeader } from './cookies.ts'
import type { MountResult } from './netease.ts'
import { scanToSignIn, type QrMountOptions, type QrMountResult, type QrPoll } from './qr.ts'
import type { BrowserName } from './store.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const API = 'https://api.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'
const DEFAULT_TIMEOUT_MS = 15_000
// The APIs' page sizes; pages are read until the bound or the end.
const HISTORY_PAGE = 30
const FOLLOW_PAGE = 50
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
const HistoryCursorSchema = z.object({
  data: z.object({ cursor: z.object({ max: z.number(), view_at: z.number() }).nullish(), list: z.array(z.unknown()).nullish() }).nullish(),
})
const HistoryRowSchema = z.object({
  title: z.string(),
  author_name: z.string().nullish(),
  view_at: z.number().optional(),
  tag_name: z.string().nullish(),
  history: z.object({ bvid: z.string().nullish() }).nullish(),
})
const FollowingsSchema = z.object({ data: z.object({ list: z.array(z.unknown()).nullish() }).nullish() })
const FollowingSchema = z.object({ mid: z.number(), uname: z.string(), mtime: z.number().optional() })
const AudioPageSchema = z.object({ data: z.object({ pageCount: z.number().optional(), data: z.array(z.unknown()).nullish() }).nullish() })
const AudioSchema = z.object({ id: z.number(), title: z.string(), author: z.string().optional() })
const QrKeySchema = z.object({ code: z.number(), data: z.object({ url: z.string(), qrcode_key: z.string() }) })
// The poll's own code lives INSIDE the envelope: the envelope is 0 for a
// code still waiting to be scanned as much as for one just confirmed.
const QrPollSchema = z.object({ code: z.number(), data: z.object({ code: z.number() }).nullish() })

const stamp = (seconds: number | undefined): { at?: string } => (seconds === undefined ? {} : { at: new Date(seconds * 1000).toISOString() })
const withArtist = (name: string | undefined): { artist?: string } => (name === undefined || name.trim() === '' ? {} : { artist: name.trim() })
const withCategory = (tag: string | undefined): { category?: string } => (tag === undefined || tag.trim() === '' ? {} : { category: tag.trim() })

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

  // What the listener has actually been watching (spec 14 §2.3), newest
  // first, paged by the cursor the last page handed back. Each row carries
  // Bilibili's own sub-zone as its category, which is how the digest tells a
  // music row from a cooking one.
  async history(bound: number): Promise<TasteItem[]> {
    const items: TasteItem[] = []
    let cursor: { max: number; view_at: number } | null = null
    while (items.length < bound) {
      const query: Record<string, string> = { ps: String(HISTORY_PAGE), business: 'archive' }
      if (cursor !== null) {
        query.max = String(cursor.max)
        query.view_at = String(cursor.view_at)
      }
      const parsed = HistoryCursorSchema.safeParse(await this.get('/x/web-interface/history/cursor', query))
      if (!parsed.success) break
      const rows = parsed.data.data?.list ?? []
      for (const raw of rows) {
        const row = HistoryRowSchema.safeParse(raw)
        const bvid = row.success ? row.data.history?.bvid : undefined
        if (!row.success || row.data.title.trim() === '' || bvid === undefined || bvid === null) continue
        items.push({
          kind: 'history',
          title: row.data.title,
          ...withArtist(row.data.author_name ?? undefined),
          ...stamp(row.data.view_at),
          ...withCategory(row.data.tag_name ?? undefined),
          ref: `https://www.bilibili.com/video/${bvid}`,
        })
      }
      const next = parsed.data.data?.cursor
      if (rows.length === 0 || next === undefined || next === null || next.max === 0) break
      cursor = next
    }
    return items.slice(0, bound)
  }

  // Who the listener follows: 'follows' is the platform's default order, which
  // is follow-time descending — who they took to lately; 'frequents' asks for
  // order_type=attention, which is who they visit most (spec 14 §2.3).
  async followings(mid: string, bound: number, kind: 'follows' | 'frequents'): Promise<TasteItem[]> {
    const query: Record<string, string> = { vmid: mid, ps: String(Math.min(bound, FOLLOW_PAGE)), pn: '1' }
    if (kind === 'frequents') query.order_type = 'attention'
    const parsed = FollowingsSchema.safeParse(await this.get('/x/relation/followings', query))
    if (!parsed.success) return []
    const items: TasteItem[] = []
    for (const raw of parsed.data.data?.list ?? []) {
      const row = FollowingSchema.safeParse(raw)
      if (!row.success || row.data.uname.trim() === '') continue
      items.push({ kind, title: row.data.uname, ...stamp(row.data.mtime), ref: `https://space.bilibili.com/${row.data.mid}` })
    }
    return items.slice(0, bound)
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

  // The QR sign-in (spec 14 §2.8): a key and the URL to draw. Plaintext and
  // unauthenticated — there is no cookie to carry yet.
  async qrKey(): Promise<{ key: string; url: string }> {
    const response = await this.send(`${PASSPORT}/x/passport-login/web/qrcode/generate`, { headers: this.headers('') })
    if (!response.ok) throw new Error(`bilibili qrcode/generate: HTTP ${response.status}`)
    const parsed = QrKeySchema.parse(await response.json())
    if (parsed.code !== 0) throw new Error(`bilibili qrcode/generate: code ${parsed.code}`)
    return { key: parsed.data.qrcode_key, url: parsed.data.url }
  }

  // 86101 waiting / 86090 the phone has it / 0 confirmed, and SESSDATA,
  // bili_jct and DedeUserID come back as Set-Cookie / 86038 the code is
  // spent (verified against the live endpoint, 2026-09-15). Anything else
  // reads as waiting: the loop's own deadline bounds it.
  async qrPoll(key: string): Promise<QrPoll<string>> {
    const url = new URL(`${PASSPORT}/x/passport-login/web/qrcode/poll`)
    url.searchParams.set('qrcode_key', key)
    const response = await this.send(url.toString(), { headers: this.headers('') })
    if (!response.ok) throw new Error(`bilibili qrcode/poll: HTTP ${response.status}`)
    const parsed = QrPollSchema.parse(await response.json())
    const code = parsed.data?.code
    if (code === 0) {
      // A confirmation that carried no Set-Cookie is not a sign-in: it reads
      // as still waiting, so the loop asks again rather than mounting an
      // account there is no credential for (codex review).
      const cookie = setCookieHeader(response)
      return cookie === '' ? { status: 'waiting' } : { status: 'confirmed', value: cookie }
    }
    if (code === 86090) return { status: 'scanned' }
    if (code === 86038) return { status: 'expired' }
    return { status: 'waiting' }
  }

  private headers(cookie: string): Record<string, string> {
    return {
      ...(cookie !== '' && { Cookie: cookie }),
      Referer: 'https://www.bilibili.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    }
  }

  // One round trip with a timeout and one retry on a network error.
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.once(url, init)
    } catch {
      return await this.once(url, init)
    }
  }

  // One GET with the cookie, a timeout and one retry on a network error. A
  // -101 (not logged in) is the typed login failure everywhere but the nav
  // read, whose anonymous answer is a plain "no account".
  private async get(path: string, query: Record<string, string>, opts: { anonymousOk?: boolean } = {}): Promise<unknown> {
    const url = new URL(`${API}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const response = await this.send(url.toString(), { headers: { ...this.headers(''), Cookie: await this.deps.cookie() } })
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

// How the account's cookie was obtained (spec 14 §2.8): scanned here, or
// borrowed from a browser by a mount made before the scan existed.
export type BilibiliAccess = { auth: 'qr'; cookie: string } | { auth?: 'browser' | undefined; browser: BrowserName; profile?: string | undefined }
export type BilibiliEntry = BilibiliAccess & { mid: string }

// The browser mount (spec 14 §3.1): the account behind a Chrome profile's
// cookie. The entry keeps the browser and the profile, never the cookie.
export async function mountBilibili(browser: { browser: BrowserName; profile?: string | undefined }, deps: BilibiliClientDeps): Promise<MountResult<BilibiliEntry>> {
  const nav = await new BilibiliClient(deps).nav()
  if (nav === null) return { ok: false, reason: 'login-required' }
  return { ok: true, who: nav.who, entry: { auth: 'browser', browser: browser.browser, ...(browser.profile !== undefined && { profile: browser.profile }), mid: nav.mid } }
}

// The scan mount (spec 14 §3.1): show the code, wait for the Bilibili app to
// confirm it, keep the cookie the platform hands back. No browser is read.
export async function mountBilibiliQr(deps: Omit<BilibiliClientDeps, 'cookie'>, opts: QrMountOptions): Promise<QrMountResult<BilibiliEntry>> {
  const anonymous = new BilibiliClient({ ...deps, cookie: async () => '' })
  let key = ''
  const scan = await scanToSignIn<string>({
    ...opts,
    issue: async () => {
      const issued = await anonymous.qrKey()
      key = issued.key
      return { url: issued.url }
    },
    poll: () => anonymous.qrPoll(key),
  })
  if (!scan.ok) return scan
  const cookie = scan.value
  const nav = await new BilibiliClient({ ...deps, cookie: async () => cookie }).nav()
  if (nav === null) return { ok: false, reason: 'login-required' }
  return { ok: true, who: nav.who, entry: { auth: 'qr', cookie, mid: nav.mid } }
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

  // What they watched, who they took to lately, who they keep going back to,
  // and the account's own audio uploads (spec 14 §2.3).
  async snapshot(): Promise<TasteSnapshot> {
    const items: TasteItem[] = [
      ...(await this.client.history(BOUNDS.history)),
      ...(await this.client.followings(this.entry.mid, BOUNDS.follows, 'follows')),
      ...(await this.client.followings(this.entry.mid, BOUNDS.follows, 'frequents')),
      ...(await this.client.spaceAudio(this.entry.mid, BOUNDS.liked)),
    ]
    return { source: 'bilibili', takenAt: this.now().toISOString(), items }
  }
}
