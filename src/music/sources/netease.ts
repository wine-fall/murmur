// The NetEase client (spec 14 §2.8): the one catalogue yt-dlp cannot search
// or answer "who am I" for. It speaks the eapi transport NetEase's own
// clients use — the same mechanism yt-dlp (public domain) implements for URL
// resolution, reimplemented here over node:crypto and pinned by a golden
// vector produced from yt-dlp's Python. Playback stays yt-dlp's (§2.5); this
// client only identifies, reads the kept lists, and searches.
//
// Every response is an untrusted boundary: zod at the edge, and the login
// codes NetEase answers with (-462, 301) become the typed auth failure.

import { createCipheriv, createHash } from 'node:crypto'

import { z } from 'zod'

import type { TrackCandidate } from '../../contracts.ts'
import { SourceAuthError } from './auth.ts'
import type { BrowserName } from './store.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const EAPI_KEY = 'e82ckenh8dichen8'
const EAPI_BASE = 'https://interface3.music.163.com/eapi'
const SONG_URL = 'https://music.163.com/#/song?id='
const DEFAULT_TIMEOUT_MS = 15_000
// How many song ids one detail lookup carries.
const DETAIL_BATCH = 200
// NetEase's own marker for the account's liked-songs playlist.
const LIKED_SPECIAL_TYPE = 5

// The eapi cipher: AES-128-ECB over "<path>-36cd479b6b5-<json>-36cd479b6b5-<md5>",
// hex-encoded. The JSON is the body plus the cookie dict under `header`,
// compact separators, key order as given.
// The JSON is spelled the way NetEase's clients (and yt-dlp's json.dumps)
// spell it: every non-ASCII code unit as \uXXXX. The server checks the md5
// over that exact text, so a raw UTF-8 title answers with an empty body.
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function eapiParams(path: string, body: Record<string, unknown>, cookies: Record<string, string>): string {
  const text = asciiJson({ ...body, header: cookies })
  const digest = createHash('md5').update(`nobody${path}use${text}md5forencrypt`, 'latin1').digest('hex')
  const message = `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'latin1'), null)
  const encrypted = Buffer.concat([cipher.update(message, 'utf8'), cipher.final()])
  return `params=${encrypted.toString('hex').toUpperCase()}`
}

export type NeteaseFetch = (url: string, init?: RequestInit) => Promise<Response>

export type NeteaseClientDeps = {
  // The browser's cookie header for music.163.com, read at call time.
  cookie: () => Promise<string>
  fetch?: NeteaseFetch
  timeoutMs?: number
  now?: () => Date
}

const CodeSchema = z.object({ code: z.number(), message: z.string().optional(), msg: z.string().optional() })
const AccountSchema = z.object({ profile: z.object({ userId: z.number(), nickname: z.string() }).nullish() })
const PlaylistsSchema = z.object({
  playlist: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      trackCount: z.number().optional(),
      specialType: z.number().optional(),
      creator: z.object({ userId: z.number() }).nullish(),
    }),
  ),
})
const DetailSchema = z.object({
  playlist: z.object({ trackIds: z.array(z.object({ id: z.number(), at: z.number().optional() })) }),
})
const ArtistSchema = z.object({ name: z.string() })
const SongSchema = z.object({
  id: z.number(),
  name: z.string(),
  ar: z.array(ArtistSchema).optional(),
  al: z.object({ name: z.string().optional() }).nullish(),
  dt: z.number().optional(),
})
const SongsSchema = z.object({ songs: z.array(z.unknown()) })
const SearchSchema = z.object({ result: z.object({ songs: z.array(z.unknown()).optional() }).nullish() })

export type NeteasePlaylist = { id: string; name: string; trackCount: number; liked: boolean; mine: boolean }

const artistLine = (song: z.infer<typeof SongSchema>): string => (song.ar ?? []).map((a) => a.name.trim()).filter((n) => n !== '').join(' / ')

function cookieValue(header: string, name: string): string | undefined {
  return header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export class NeteaseClient {
  private deps: NeteaseClientDeps
  private fetch: NeteaseFetch

  constructor(deps: NeteaseClientDeps) {
    this.deps = deps
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
  }

  // null = the cookie carries no login (an anonymous account read answers
  // 200 with no profile).
  async account(): Promise<{ userId: string; who: string } | null> {
    const json = await this.call('/nuser/account/get', {})
    const parsed = AccountSchema.safeParse(json)
    if (!parsed.success || parsed.data.profile == null) return null
    return { userId: String(parsed.data.profile.userId), who: parsed.data.profile.nickname }
  }

  async playlists(userId: string): Promise<NeteasePlaylist[]> {
    const json = await this.call('/user/playlist', { uid: userId, limit: BOUNDS.playlist, offset: 0 })
    const parsed = PlaylistsSchema.parse(json)
    return parsed.playlist.map((p) => ({
      id: String(p.id),
      name: p.name,
      trackCount: p.trackCount ?? 0,
      liked: p.specialType === LIKED_SPECIAL_TYPE,
      mine: p.creator?.userId === Number(userId),
    }))
  }

  // The newest `cap` tracks of a playlist as liked items. The detail call
  // carries ids only, so titles come from song detail in batches.
  async playlistTracks(playlistId: string, cap: number): Promise<TasteItem[]> {
    const detail = DetailSchema.parse(await this.call('/v6/playlist/detail', { id: playlistId, n: 100_000, s: 0 }))
    const ids = detail.playlist.trackIds.slice(0, cap)
    const at = new Map(ids.map((t) => [t.id, t.at]))
    const items: TasteItem[] = []
    for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
      const batch = ids.slice(i, i + DETAIL_BATCH)
      const json = await this.call('/v3/song/detail', { c: JSON.stringify(batch.map((t) => ({ id: t.id }))) })
      for (const raw of SongsSchema.parse(json).songs) {
        const song = SongSchema.safeParse(raw)
        if (!song.success || song.data.name.trim() === '') continue
        const kept = at.get(song.data.id)
        const artist = artistLine(song.data)
        const album = song.data.al?.name?.trim()
        items.push({
          kind: 'liked',
          title: song.data.name,
          ...(artist !== '' && { artist }),
          ...(album && { album }),
          ...(kept !== undefined && { at: new Date(kept).toISOString() }),
          ref: `${SONG_URL}${song.data.id}`,
        })
      }
    }
    return items
  }

  async search(query: string, limit: number): Promise<TrackCandidate[]> {
    const json = await this.call('/cloudsearch/pc', { s: query, type: 1, limit, offset: 0, total: true })
    const parsed = SearchSchema.parse(json)
    const candidates: TrackCandidate[] = []
    for (const raw of parsed.result?.songs ?? []) {
      const song = SongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '') continue
      const album = song.data.al?.name?.trim()
      candidates.push({
        ref: `${SONG_URL}${song.data.id}`,
        title: song.data.name,
        uploader: artistLine(song.data),
        durationS: Math.trunc((song.data.dt ?? 0) / 1000),
        extra: album ? { album } : {},
        catalogue: 'netease',
      })
    }
    return candidates.slice(0, limit)
  }

  // One eapi round trip: timeout, one retry on a network error, none on an
  // auth answer; the login codes and a 429 become the typed failure.
  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const header = await this.deps.cookie()
    const musicU = cookieValue(header, 'MUSIC_U')
    const csrf = cookieValue(header, '__csrf') ?? ''
    const cookies: Record<string, string> = {
      osver: 'undefined',
      deviceId: 'undefined',
      appver: '8.0.0',
      versioncode: '140',
      mobilename: 'undefined',
      buildver: '1623435496',
      resolution: '1920x1080',
      __csrf: csrf,
      os: 'pc',
      channel: 'undefined',
      requestId: `${(this.deps.now ?? (() => new Date()))().getTime()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
      ...(musicU !== undefined && { MUSIC_U: musicU }),
    }
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://music.163.com',
        Cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      },
      body: eapiParams(`/api${path}`, body, cookies),
    }
    const url = `${EAPI_BASE}${path}`
    let response: Response
    try {
      response = await this.once(url, init)
    } catch {
      response = await this.once(url, init)
    }
    if (response.status === 429) throw new SourceAuthError('netease', 'rate-limited', `HTTP 429 on ${path}`)
    if (!response.ok) throw new Error(`netease ${path}: HTTP ${response.status}`)
    const json: unknown = await response.json()
    const code = CodeSchema.safeParse(json)
    if (code.success && (code.data.code === -462 || code.data.code === 301)) {
      throw new SourceAuthError('netease', 'login-required', `code ${code.data.code} on ${path}`)
    }
    if (code.success && code.data.code !== 200) {
      throw new Error(`netease ${path}: code ${code.data.code} ${code.data.message ?? code.data.msg ?? ''}`.trim())
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

export type NeteaseEntry = { browser: BrowserName; profile?: string | undefined; userId: string; likedPlaylistId: string }

export type MountResult<T> = { ok: true; who: string; entry: T } | { ok: false; reason: 'login-required' }

// The mount step (spec 14 §3.1): the account behind the named browser's
// cookie, and its liked-songs playlist. No login = a plain "sign in there
// first", never an exception.
export async function mountNetease(
  browser: { browser: BrowserName; profile?: string | undefined },
  deps: NeteaseClientDeps,
): Promise<MountResult<NeteaseEntry>> {
  const client = new NeteaseClient(deps)
  const account = await client.account()
  if (account === null) return { ok: false, reason: 'login-required' }
  const playlists = await client.playlists(account.userId)
  const liked = playlists.find((p) => p.liked) ?? playlists.find((p) => p.mine) ?? playlists[0]
  if (liked === undefined) return { ok: false, reason: 'login-required' }
  return {
    ok: true,
    who: account.who,
    entry: {
      browser: browser.browser,
      ...(browser.profile !== undefined && { profile: browser.profile }),
      userId: account.userId,
      likedPlaylistId: liked.id,
    },
  }
}

export class NeteaseSource implements TasteSource {
  readonly id = 'netease' as const
  private entry: NeteaseEntry
  private client: NeteaseClient
  private now: () => Date

  constructor(entry: NeteaseEntry, deps: NeteaseClientDeps) {
    this.entry = entry
    this.client = new NeteaseClient(deps)
    this.now = deps.now ?? (() => new Date())
  }

  async verify(): Promise<VerifyResult> {
    const account = await this.client.account()
    return account === null ? { ok: false, reason: 'login-required' } : { ok: true, who: account.who }
  }

  // The liked list IS the snapshot's body (spec 14 §3.5); the other playlists
  // contribute their names only.
  async snapshot(): Promise<TasteSnapshot> {
    const liked = await this.client.playlistTracks(this.entry.likedPlaylistId, BOUNDS.liked)
    const playlists = (await this.client.playlists(this.entry.userId))
      .filter((p) => p.id !== this.entry.likedPlaylistId)
      .slice(0, BOUNDS.playlist)
      .map((p): TasteItem => ({ kind: 'playlist', title: p.name }))
    return { source: 'netease', takenAt: this.now().toISOString(), items: [...liked, ...playlists] }
  }
}
