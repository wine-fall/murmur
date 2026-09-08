// The NetEase client (spec 14 §2.8): the one catalogue yt-dlp cannot search
// or answer "who am I" for. It speaks the plaintext `music.163.com/api`
// endpoints the platform's own web pages use — ordinary GETs carrying the
// browser's cookie, no signing and no borrowed client key. Playback stays
// yt-dlp's (§2.5); this client only identifies, reads the kept lists, and
// searches (search answers anonymously, so it needs no cookie at all).
//
// Every response is an untrusted boundary: zod at the edge, and the login
// codes NetEase answers with (-462, 301) become the typed auth failure.

import { z } from 'zod'

import type { TrackCandidate } from '../../contracts.ts'
import { SourceAuthError } from './auth.ts'
import type { BrowserName } from './store.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const API_BASE = 'https://music.163.com/api'
const SONG_URL = 'https://music.163.com/#/song?id='
const DEFAULT_TIMEOUT_MS = 15_000
// These endpoints serve the web player, and answer an unbranded client with
// empty results; a browser's own user agent is what they expect.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
// NetEase's own marker for the account's liked-songs playlist.
const LIKED_SPECIAL_TYPE = 5

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
  playlist: z.object({
    trackIds: z.array(z.object({ id: z.number(), at: z.number().optional() })),
    // The first `n` tracks in full — the whole list, at the bound we ask for.
    tracks: z.array(z.unknown()).optional(),
  }),
})
const ArtistSchema = z.object({ name: z.string() })
// One song, in either of the two spellings the platform uses: the player's
// (`ar`/`al`/`dt`) and the web search's (`artists`/`album`/`duration`).
const SongSchema = z.object({
  id: z.number(),
  name: z.string(),
  ar: z.array(ArtistSchema).optional(),
  artists: z.array(ArtistSchema).optional(),
  al: z.object({ name: z.string().optional() }).nullish(),
  album: z.object({ name: z.string().optional() }).nullish(),
  dt: z.number().optional(),
  duration: z.number().optional(),
})
const SearchSchema = z.object({ result: z.object({ songs: z.array(z.unknown()).optional() }).nullish() })

export type NeteasePlaylist = { id: string; name: string; trackCount: number; liked: boolean; mine: boolean }

type Song = z.infer<typeof SongSchema>

const artistLine = (song: Song): string =>
  (song.ar ?? song.artists ?? [])
    .map((a) => a.name.trim())
    .filter((n) => n !== '')
    .join(' / ')
const albumName = (song: Song): string | undefined => (song.al ?? song.album)?.name?.trim()
const durationMs = (song: Song): number => song.dt ?? song.duration ?? 0

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

  // The newest `cap` tracks of a playlist as liked items. One read: the
  // detail call answers with the ids (and when each was kept) plus the first
  // `n` tracks in full, so asking for `n = cap` returns both halves at once.
  async playlistTracks(playlistId: string, cap: number): Promise<TasteItem[]> {
    const detail = DetailSchema.parse(await this.call('/v6/playlist/detail', { id: playlistId, n: cap, s: 0 }))
    const ids = detail.playlist.trackIds.slice(0, cap)
    const at = new Map(ids.map((t) => [t.id, t.at]))
    const titled = new Map<number, TasteItem>()
    for (const raw of detail.playlist.tracks ?? []) {
      const song = SongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '' || !at.has(song.data.id)) continue
      const kept = at.get(song.data.id)
      const artist = artistLine(song.data)
      const album = albumName(song.data)
      titled.set(song.data.id, {
        kind: 'liked',
        title: song.data.name,
        ...(artist !== '' && { artist }),
        ...(album && { album }),
        ...(kept !== undefined && { at: new Date(kept).toISOString() }),
        ref: `${SONG_URL}${song.data.id}`,
      })
    }
    // In the playlist's own order: newest kept first. An id the detail read
    // left untitled (a track the platform withdrew) is dropped, not chased.
    return ids.flatMap((t) => {
      const item = titled.get(t.id)
      return item === undefined ? [] : [item]
    })
  }

  async search(query: string, limit: number): Promise<TrackCandidate[]> {
    const json = await this.call('/search/get', { s: query, type: 1, offset: 0, limit })
    const parsed = SearchSchema.parse(json)
    const candidates: TrackCandidate[] = []
    for (const raw of parsed.result?.songs ?? []) {
      const song = SongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '') continue
      const album = albumName(song.data)
      candidates.push({
        ref: `${SONG_URL}${song.data.id}`,
        title: song.data.name,
        uploader: artistLine(song.data),
        durationS: Math.trunc(durationMs(song.data) / 1000),
        extra: album ? { album } : {},
        catalogue: 'netease',
      })
    }
    return candidates.slice(0, limit)
  }

  // One round trip: a plain GET carrying the browser's cookie as it stands,
  // a timeout, one retry on a network error and none on an auth answer; the
  // login codes and a 429 become the typed failure.
  private async call(path: string, query: Record<string, string | number>): Promise<unknown> {
    const url = new URL(`${API_BASE}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const cookie = await this.deps.cookie()
    const init: RequestInit = {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://music.163.com/',
        ...(cookie !== '' && { Cookie: cookie }),
      },
    }
    let response: Response
    try {
      response = await this.once(url.toString(), init)
    } catch {
      response = await this.once(url.toString(), init)
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
  // contribute their names only. The login is checked first: the playlist
  // endpoints serve a public list anonymously, and a snapshot that "worked"
  // on a cookie that no longer signs in would hide an expired mount.
  async snapshot(): Promise<TasteSnapshot> {
    if ((await this.client.account()) === null) throw new SourceAuthError('netease', 'login-required', 'the cookie no longer signs in')
    const liked = await this.client.playlistTracks(this.entry.likedPlaylistId, BOUNDS.liked)
    const playlists = (await this.client.playlists(this.entry.userId))
      .filter((p) => p.id !== this.entry.likedPlaylistId)
      .slice(0, BOUNDS.playlist)
      .map((p): TasteItem => ({ kind: 'playlist', title: p.name }))
    return { source: 'netease', takenAt: this.now().toISOString(), items: [...liked, ...playlists] }
  }
}
