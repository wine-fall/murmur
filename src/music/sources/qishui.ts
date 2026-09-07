// Soda Music (Qishui) as a read-only taste source (spec 14 §2.8, §6): the
// passport QR flow (scanned with Douyin — the platform's own copy says so),
// then the account's collection, playlists and daily mix over the transport
// the PC client and the Android app use. The mechanism is the one the MIT
// reference documents (§7); nothing decrypts anything here, and playback is
// out of scope by decision.
//
// Every response is an untrusted boundary: zod at the edge, a dead session
// as the typed failure.

import qrcode from 'qrcode-generator'
import { z } from 'zod'

import { SourceAuthError } from './auth.ts'
import type { MountResult } from './netease.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const PC_HOST = 'https://api.qishui.com'
const LUNA_HOST = 'https://beta-luna.douyin.com'
const DEFAULT_TIMEOUT_MS = 15_000
// The QR poll cadence and patience (spec 14 §3.1).
export const QR_POLL_MS = 2_000
export const QR_TIMEOUT_MS = 3 * 60_000

// The passport SDK's fixed identity for the PC client (the reference's).
const PASSPORT = {
  aid: '386088',
  passport_jssdk_version: '2.4.13',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  next: 'https://api.qishui.com',
  need_logo: 'false',
  need_short_url: 'false',
  is_frontier: 'true',
  is_new_login: '1',
  iid: '27960026095955',
  version_code: '30020100',
}

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const PC_UA = 'LunaPC/3.0.0(290101097)'
const APP_UA = 'Luna/19.1.0 Android'

export type QishuiFetch = (url: string, init?: RequestInit) => Promise<Response>

export type QishuiDeps = {
  fetch?: QishuiFetch
  timeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  // Sixteen decimal digits for the device and install ids minted at mount.
  random?: () => string
}

export type QishuiEntry = { sessionCookie: string; deviceId: string; installId: string }

const QrSchema = z.object({
  data: z.object({ token: z.string(), qrcode_index_url: z.string(), expire_time: z.number().optional() }),
})
const StatusSchema = z.object({ data: z.object({ status: z.string().optional() }).nullish() })
const StatusCodeSchema = z.object({ status_code: z.number().optional() })
const MeSchema = z.object({
  my_info: z.object({ id: z.union([z.number(), z.string()]).optional(), nickname: z.string().optional() }).nullish(),
  user: z.object({ id: z.union([z.number(), z.string()]).optional(), nickname: z.string().optional() }).nullish(),
})
const PlaylistSchema = z.object({ title: z.string().optional(), name: z.string().optional() })
const PlaylistsSchema = z.object({ playlists: z.array(z.unknown()).nullish() })
const TrackSchema = z.object({
  name: z.string(),
  artists: z.array(z.object({ name: z.string().optional() })).optional(),
  album: z.object({ name: z.string().optional() }).nullish(),
})
const CollectionItemSchema = z.object({
  item_type: z.string().optional(),
  track: z.unknown().optional(),
  media: z.object({ track: z.unknown().optional() }).nullish(),
  playlist: z.unknown().optional(),
})
const CollectionSchema = z.object({ mixed_collections: z.array(z.unknown()).nullish() })
const FeedItemSchema = z.object({
  entity: z.object({ track_wrapper: z.object({ track: z.unknown().optional() }).nullish(), track: z.unknown().optional() }).nullish(),
  track: z.unknown().optional(),
})
const FeedSchema = z.object({ media_resources: z.array(z.unknown()).nullish(), data: z.object({ media_resources: z.array(z.unknown()).nullish() }).nullish() })

function trackItem(kind: 'liked' | 'daily', raw: unknown): TasteItem | null {
  const track = TrackSchema.safeParse(raw)
  if (!track.success || track.data.name.trim() === '') return null
  const artist = (track.data.artists ?? [])
    .map((a) => a.name?.trim() ?? '')
    .filter((n) => n !== '')
    .join(' / ')
  const album = track.data.album?.name?.trim()
  return { kind, title: track.data.name, ...(artist !== '' && { artist }), ...(album && { album }) }
}

function setCookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw)
    if (match !== null) return match[1]
  }
  return undefined
}

function randomDigits(): string {
  let out = ''
  while (out.length < 16) out += Math.floor(Math.random() * 10)
  return out
}

export class QishuiClient {
  private deps: QishuiDeps
  private fetch: QishuiFetch

  constructor(deps: QishuiDeps) {
    this.deps = deps
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
  }

  // The QR to show: its scan URL, the poll token, and the csrf cookie the
  // poll must carry back.
  async issueQr(): Promise<{ token: string; url: string; expiresAt: string; cookie: string }> {
    const url = new URL(`${PC_HOST}/passport/web/get_qrcode/`)
    for (const key of ['passport_jssdk_version', 'passport_jssdk_type', 'is_from_ttaccountsdk', 'aid', 'next', 'need_logo', 'need_short_url', 'is_new_login'] as const) {
      url.searchParams.set(key, PASSPORT[key])
    }
    const response = await this.request(url.toString(), { headers: { 'User-Agent': WEB_UA } })
    const parsed = QrSchema.parse(await response.json())
    const csrf = setCookieValue(response, 'passport_csrf_token')
    return {
      token: parsed.data.token,
      url: parsed.data.qrcode_index_url,
      expiresAt: new Date((parsed.data.expire_time ?? 0) * 1000).toISOString(),
      cookie: csrf === undefined ? '' : `passport_csrf_token=${csrf}`,
    }
  }

  async pollQr(token: string, cookie: string): Promise<{ status: string; sessionId?: string }> {
    const url = new URL(`${PC_HOST}/passport/web/check_qrconnect/`)
    for (const key of ['passport_jssdk_version', 'passport_jssdk_type', 'is_from_ttaccountsdk', 'aid', 'iid'] as const) {
      url.searchParams.set(key, PASSPORT[key])
    }
    const body = new URLSearchParams({
      need_logo: PASSPORT.need_logo,
      need_short_url: PASSPORT.need_short_url,
      is_frontier: PASSPORT.is_frontier,
      token,
      is_new_login: PASSPORT.is_new_login,
      next: PASSPORT.next,
    }).toString()
    const response = await this.request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': WEB_UA, ...(cookie !== '' && { Cookie: cookie }) },
      body,
    })
    const parsed = StatusSchema.safeParse(await response.json())
    const status = parsed.success ? (parsed.data.data?.status ?? 'unknown') : 'unknown'
    const sessionId = setCookieValue(response, 'sessionid')
    return { status, ...(sessionId !== undefined && { sessionId }) }
  }

  // null = the session no longer signs in (the mount path wants a plain
  // answer, not an exception).
  async me(entry: QishuiEntry): Promise<{ id: string; who: string } | null> {
    let json: unknown
    try {
      json = await this.pc('/luna/pc/me', entry)
    } catch (err) {
      if (err instanceof SourceAuthError && err.reason === 'expired') return null
      throw err
    }
    const parsed = MeSchema.safeParse(json)
    if (!parsed.success) return null
    const info = parsed.data.my_info ?? parsed.data.user
    if (info == null || info.id === undefined) return null
    return { id: String(info.id), who: info.nickname ?? 'your Soda Music account' }
  }

  async playlists(entry: QishuiEntry): Promise<TasteItem[]> {
    const parsed = PlaylistsSchema.safeParse(await this.pc('/luna/pc/me/playlist', entry, { version_code: PASSPORT.version_code }))
    if (!parsed.success) return []
    const items: TasteItem[] = []
    for (const raw of parsed.data.playlists ?? []) {
      const p = PlaylistSchema.safeParse(raw)
      const title = (p.success ? (p.data.title ?? p.data.name ?? '') : '').trim()
      if (title !== '') items.push({ kind: 'playlist', title })
    }
    return items.slice(0, BOUNDS.playlist)
  }

  // The collection is mixed: kept tracks become liked items, kept playlists
  // contribute their names, videos are not music.
  async collection(entry: QishuiEntry): Promise<TasteItem[]> {
    const parsed = CollectionSchema.safeParse(await this.pc('/luna/pc/me/collection/mixed', entry))
    if (!parsed.success) return []
    const items: TasteItem[] = []
    for (const raw of parsed.data.mixed_collections ?? []) {
      const item = CollectionItemSchema.safeParse(raw)
      if (!item.success) continue
      const track = trackItem('liked', item.data.track ?? item.data.media?.track)
      if (track !== null) {
        items.push(track)
        continue
      }
      const p = PlaylistSchema.safeParse(item.data.playlist)
      const title = (p.success ? (p.data.title ?? p.data.name ?? '') : '').trim()
      if (title !== '') items.push({ kind: 'playlist', title })
    }
    return items.slice(0, BOUNDS.liked)
  }

  // The app's daily mix. Answered with a non-zero status (the app's own
  // "not for this caller") to a session that lacks the app's context: then
  // it is simply an empty read, not a failure.
  async dailyMix(entry: QishuiEntry): Promise<TasteItem[]> {
    const response = await this.request(`${LUNA_HOST}/luna/feed/song-tab`, {
      method: 'POST',
      headers: { 'User-Agent': APP_UA, 'Content-Type': 'application/json; charset=utf-8', Cookie: `sessionid=${entry.sessionCookie}` },
      body: '{}',
    })
    if (!response.ok) return []
    const json: unknown = await response.json()
    const code = StatusCodeSchema.safeParse(json)
    if (code.success && code.data.status_code !== undefined && code.data.status_code !== 0) return []
    const parsed = FeedSchema.safeParse(json)
    if (!parsed.success) return []
    const items: TasteItem[] = []
    for (const raw of parsed.data.media_resources ?? parsed.data.data?.media_resources ?? []) {
      const item = FeedItemSchema.safeParse(raw)
      if (!item.success) continue
      const track = trackItem('daily', item.data.entity?.track_wrapper?.track ?? item.data.entity?.track ?? item.data.track)
      if (track !== null) items.push(track)
    }
    return items.slice(0, BOUNDS.top)
  }

  private async pc(path: string, entry: QishuiEntry, extra: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${PC_HOST}${path}`)
    url.searchParams.set('aid', PASSPORT.aid)
    url.searchParams.set('iid', entry.installId)
    url.searchParams.set('device_id', entry.deviceId)
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
    const response = await this.request(url.toString(), {
      headers: { 'User-Agent': PC_UA, 'Content-Type': 'application/json; charset=utf-8', Cookie: `sessionid=${entry.sessionCookie}` },
    })
    if (response.status === 401 || response.status === 403) throw new SourceAuthError('qishui', 'expired', `HTTP ${response.status} on ${path}`)
    if (!response.ok) throw new Error(`qishui ${path}: HTTP ${response.status}`)
    const json: unknown = await response.json()
    // The platform answers a dead session with HTTP 200 and a non-zero
    // status: parsed as empty arrays it would look like an account with
    // nothing in it, and a refresh would quietly replace the last good
    // snapshot. It is the login being gone.
    const code = StatusCodeSchema.safeParse(json)
    if (code.success && code.data.status_code !== undefined && code.data.status_code !== 0) {
      throw new SourceAuthError('qishui', 'expired', `status ${code.data.status_code} on ${path}`)
    }
    return json
  }

  // One round trip with a timeout and one retry on a network error; a 429
  // is the typed rate limit wherever it happens.
  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await this.once(url, init)
    } catch {
      response = await this.once(url, init)
    }
    if (response.status === 429) throw new SourceAuthError('qishui', 'rate-limited', `HTTP 429`)
    return response
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

export type QishuiMountOptions = {
  // Where the QR's URL is shown (the flow renders it as half-blocks).
  show: (url: string) => void
  timeoutMs?: number
  cancelled?: () => boolean
}

export type QishuiMountResult = MountResult<QishuiEntry> | { ok: false; reason: 'timeout' | 'cancelled' }

// The QR conversation (spec 14 §3.1): issue, show, poll every two seconds
// until the Douyin scan is confirmed, then read who the session is.
export async function mountQishui(deps: QishuiDeps, opts: QishuiMountOptions): Promise<QishuiMountResult> {
  const client = new QishuiClient(deps)
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const qr = await client.issueQr()
  opts.show(qr.url)
  const deadline = now().getTime() + (opts.timeoutMs ?? QR_TIMEOUT_MS)
  while (now().getTime() < deadline) {
    if (opts.cancelled?.() === true) return { ok: false, reason: 'cancelled' }
    const poll = await client.pollQr(qr.token, qr.cookie)
    if (poll.status === 'confirmed' && poll.sessionId !== undefined) {
      const random = deps.random ?? randomDigits
      const entry: QishuiEntry = { sessionCookie: poll.sessionId, deviceId: random(), installId: random() }
      const me = await client.me(entry)
      if (me === null) return { ok: false, reason: 'login-required' }
      return { ok: true, who: me.who, entry }
    }
    if (poll.status === 'expired') return { ok: false, reason: 'timeout' }
    await sleep(QR_POLL_MS)
    if (opts.cancelled?.() === true) return { ok: false, reason: 'cancelled' }
  }
  return { ok: false, reason: 'timeout' }
}

export class QishuiSource implements TasteSource {
  readonly id = 'qishui' as const
  private entry: QishuiEntry
  private client: QishuiClient
  private now: () => Date

  constructor(entry: QishuiEntry, deps: QishuiDeps) {
    this.entry = entry
    this.client = new QishuiClient(deps)
    this.now = deps.now ?? (() => new Date())
  }

  async verify(): Promise<VerifyResult> {
    const me = await this.client.me(this.entry)
    return me === null ? { ok: false, reason: 'expired' } : { ok: true, who: me.who }
  }

  async snapshot(): Promise<TasteSnapshot> {
    const [collection, playlists, daily] = await Promise.all([
      this.client.collection(this.entry),
      this.client.playlists(this.entry),
      this.client.dailyMix(this.entry),
    ])
    return { source: 'qishui', takenAt: this.now().toISOString(), items: [...collection, ...playlists, ...daily] }
  }
}

// The QR as terminal text: two modules per character row in half-blocks,
// light modules drawn as blocks so a dark terminal reads as the white
// background a scanner expects, with a two-module quiet zone all round.
export function qrHalfBlocks(text: string): string[] {
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  const n = code.getModuleCount()
  const quiet = 2
  const size = n + quiet * 2
  const dark = (row: number, col: number): boolean => {
    const r = row - quiet
    const c = col - quiet
    return r >= 0 && c >= 0 && r < n && c < n && code.isDark(r, c)
  }
  const lines: string[] = []
  for (let row = 0; row < size; row += 2) {
    let line = ''
    for (let col = 0; col < size; col++) {
      const top = dark(row, col)
      const bottom = row + 1 < size ? dark(row + 1, col) : false
      line += top ? (bottom ? ' ' : '▄') : bottom ? '▀' : '█'
    }
    lines.push(line)
  }
  return lines
}
