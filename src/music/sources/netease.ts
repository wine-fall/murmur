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

import type { DailySong, TrackCandidate } from '../../contracts.ts'
import { SourceAuthError } from './auth.ts'
import { setCookieHeader } from './cookies.ts'
import { scanToSignIn, type QrMountOptions, type QrMountResult, type QrPoll } from './qr.ts'
import type { BrowserName } from './store.ts'
import { asked, BOUNDS, type TasteItem, type TasteKind, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const API_BASE = 'https://music.163.com/api'
const SONG_URL = 'https://music.163.com/#/song?id='
// What the scanned code encodes: the platform's own sign-in page for a key.
const QR_LOGIN_URL = 'https://music.163.com/login?codekey='
const DEFAULT_TIMEOUT_MS = 15_000
// These endpoints serve the web player, and answer an unbranded client with
// empty results; a browser's own user agent is what they expect.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
// NetEase's own marker for the account's liked-songs playlist.
const LIKED_SPECIAL_TYPE = 5
// The mood pool (spec 14 §3.10): the platform's search type for playlists,
// and how much of the index one pick is allowed to read.
const PLAYLIST_SEARCH_TYPE = 1000
const POOL_PLAYLISTS = 2
const POOL_TRACKS = 30

export type NeteaseFetch = (url: string, init?: RequestInit) => Promise<Response>

export type NeteaseClientDeps = {
  // The cookie header for music.163.com, read at call time: a QR mount's own,
  // or the browser's. The QR calls themselves carry none.
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
// The mood pool (spec 14 §3.10): playlists other people made, found by the
// words the moment gives, or under one of the platform's own categories.
const PlaylistHitsSchema = z.object({
  result: z.object({ playlists: z.array(z.object({ id: z.number() })).optional() }).nullish(),
  playlists: z.array(z.object({ id: z.number() })).optional(),
})
const CatalogueSchema = z.object({ sub: z.array(z.object({ name: z.string() })).optional() })
// The daily lane (spec 14 §3.10): the platform's own pick of the day, each
// with the one-line reason it gives for it.
const DailySchema = z.object({ data: z.object({ dailySongs: z.array(z.unknown()).optional() }).nullish() })
const DailySongSchema = SongSchema.extend({ reason: z.string().nullish() })
const SimilarSchema = z.object({ songs: z.array(z.unknown()).nullish() })
// The artist ranking behind the "artist's #N hit" label (spec 14 3.10): the
// name resolves to an id, the id to the songs the platform ranks highest.
const ArtistSearchSchema = z.object({ result: z.object({ artists: z.array(z.object({ id: z.number() })).nullish() }).nullish() })
const HotSongsSchema = z.object({ hotSongs: z.array(z.object({ name: z.string() })).nullish() })
const ARTIST_SEARCH_TYPE = 100
const QrKeySchema = z.object({ code: z.number(), unikey: z.string() })
// The poll's whole answer is its code — there is no envelope under it.
const QrPollSchema = z.object({ code: z.number() })

export type NeteasePlaylist = { id: string; name: string; trackCount: number; liked: boolean; mine: boolean }


type Song = z.infer<typeof SongSchema>

const artistLine = (song: Song): string =>
  (song.ar ?? song.artists ?? [])
    .map((a) => a.name.trim())
    .filter((n) => n !== '')
    .join(' / ')
const albumName = (song: Song): string | undefined => (song.al ?? song.album)?.name?.trim()
const durationMs = (song: Song): number => song.dt ?? song.duration ?? 0

const candidateOf = (song: Song): TrackCandidate => {
  const album = albumName(song)
  return {
    ref: `${SONG_URL}${song.id}`,
    title: song.name,
    uploader: artistLine(song),
    durationS: Math.trunc(durationMs(song) / 1000),
    extra: album ? { album } : {},
    catalogue: 'netease',
  }
}

export class NeteaseClient {
  private deps: NeteaseClientDeps
  private fetch: NeteaseFetch
  private catalogue: Promise<readonly string[]> | undefined

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

  // The mood pool (spec 14 §3.10): a situation in words -> playlists other
  // people keep -> their tracks as candidates. Two reads of the playlist
  // index at most, plus one detail read each, all anonymous.
  //
  // ponytail: the head of a hot playlist is what comes back, so the same
  // mood word twice in an evening can offer the same first tracks twice --
  // the avoid-list catches the exact repeat. Upgrade path: page the detail
  // read at a rotating offset.
  async playlistPool(query: string, limit: number): Promise<TrackCandidate[]> {
    const mood = query.trim()
    const categories = await this.categories()
    const hit = categories.find((name) => name.toLowerCase() === mood.toLowerCase())
    const json =
      hit === undefined
        ? await this.call('/search/get', { s: mood, type: PLAYLIST_SEARCH_TYPE, offset: 0, limit: POOL_PLAYLISTS })
        : await this.call('/playlist/list', { cat: hit, order: 'hot', offset: 0, limit: POOL_PLAYLISTS })
    const parsed = PlaylistHitsSchema.parse(json)
    const found = (parsed.result?.playlists ?? parsed.playlists ?? []).slice(0, POOL_PLAYLISTS)
    const read = await Promise.all(found.map((p) => this.playlistCandidates(String(p.id))))
    // Interleaved, so a pool of two playlists is two moods and not one long
    // one; the same track kept in both counts once.
    const out = new Map<string, TrackCandidate>()
    for (let i = 0; out.size < limit && read.some((tracks) => i < tracks.length); i++) {
      for (const tracks of read) {
        const track = tracks[i]
        if (track !== undefined && !out.has(track.ref) && out.size < limit) out.set(track.ref, track)
      }
    }
    return [...out.values()]
  }

  // The platform's own category names, read once per process: the tree moves
  // on the scale of a product decision, not of a pick.
  private async categories(): Promise<readonly string[]> {
    this.catalogue ??= this.call('/playlist/catalogue', {})
      .then((json) => (CatalogueSchema.parse(json).sub ?? []).map((c) => c.name))
      // A tree that would not load is not a failed pick: every mood then
      // takes the search route, which needs no category name.
      .catch((): readonly string[] => [])
    return this.catalogue
  }

  private async playlistCandidates(playlistId: string): Promise<TrackCandidate[]> {
    const detail = DetailSchema.parse(await this.call('/v6/playlist/detail', { id: playlistId, n: POOL_TRACKS, s: 0 }))
    const out: TrackCandidate[] = []
    for (const raw of detail.playlist.tracks ?? []) {
      const song = SongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '') continue
      out.push(candidateOf(song.data))
    }
    return out
  }

  // The day's recommendation (spec 14 §3.10). Needs the account cookie --
  // it is the one read here that is about this listener and not about a
  // catalogue -- and carries the platform's own reason per song.
  async dailyRecommendation(limit: number): Promise<DailySong[]> {
    const parsed = DailySchema.parse(await this.call('/v1/discovery/recommend/songs', {}))
    const out: DailySong[] = []
    for (const raw of parsed.data?.dailySongs ?? []) {
      if (out.length >= limit) break
      const song = DailySongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '') continue
      const reason = song.data.reason?.trim()
      out.push({
        ref: `${SONG_URL}${song.data.id}`,
        title: song.data.name,
        artist: artistLine(song.data),
        ...(reason !== undefined && reason !== '' && { reason }),
      })
    }
    return out
  }

  // The neighbours of one song (spec 14 3.10), anonymous: the platform's own
  // "next to this one", which is a place to look that no memory of ours has.
  async similarSongs(songId: string, limit: number): Promise<TrackCandidate[]> {
    const parsed = SimilarSchema.parse(await this.call('/v1/discovery/simiSong', { songid: songId, limit }))
    const out: TrackCandidate[] = []
    for (const raw of parsed.songs ?? []) {
      const song = SongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '') continue
      out.push(candidateOf(song.data))
    }
    return out.slice(0, limit)
  }

  // The artist's own top songs (spec 14 3.10), anonymous. Two reads: the
  // name to an id, then the id's ranking.
  //
  // ponytail: the first artist the search returns is the one taken -- names
  // repeat across artists and the platform's own order puts the one everyone
  // means first. Upgrade path: score the candidates against the song that
  // asked.
  async artistHotSongs(artist: string, limit: number): Promise<string[]> {
    const found = ArtistSearchSchema.parse(
      await this.call('/search/get', { s: artist, type: ARTIST_SEARCH_TYPE, offset: 0, limit: 1 }),
    )
    const id = found.result?.artists?.[0]?.id
    if (id === undefined) return []
    const hot = HotSongsSchema.parse(await this.call(`/v1/artist/${id}`, {}))
    return (hot.hotSongs ?? []).map((song) => song.name.trim()).filter((name) => name !== '').slice(0, limit)
  }

  async search(query: string, limit: number): Promise<TrackCandidate[]> {
    const json = await this.call('/search/get', { s: query, type: 1, offset: 0, limit })
    const parsed = SearchSchema.parse(json)
    const candidates: TrackCandidate[] = []
    for (const raw of parsed.result?.songs ?? []) {
      const song = SongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '') continue
      candidates.push(candidateOf(song.data))
    }
    return candidates.slice(0, limit)
  }

  // The QR sign-in (spec 14 §2.8): a key, drawn as the platform's own
  // sign-in URL. Plaintext and unauthenticated — it carries no cookie,
  // because there is not one yet.
  async qrKey(): Promise<{ key: string; url: string }> {
    const parsed = QrKeySchema.parse(await this.plain('/login/qrcode/unikey', { type: 1 }))
    if (parsed.code !== 200) throw new Error(`netease qrcode/unikey: code ${parsed.code}`)
    return { key: parsed.unikey, url: `${QR_LOGIN_URL}${parsed.unikey}` }
  }

  // 801 waiting / 802 the phone has it / 803 confirmed, and the cookie comes
  // back as Set-Cookie / 800 the code is spent (verified against the live
  // endpoint, 2026-09-15). Anything else reads as waiting: the loop's own
  // deadline bounds it, and a fresh code is a better answer than a guess.
  async qrPoll(key: string): Promise<QrPoll<string>> {
    const response = await this.send(this.url('/login/qrcode/client/login', { key, type: 1 }), { method: 'GET', headers: this.headers('') })
    if (!response.ok) throw new Error(`netease qrcode/client/login: HTTP ${response.status}`)
    const { code } = QrPollSchema.parse(await response.json())
    if (code === 803) {
      // A confirmation that carried no Set-Cookie is not a sign-in: it reads
      // as still waiting, so the loop asks again rather than mounting an
      // account there is no credential for (codex review).
      const cookie = setCookieHeader(response)
      return cookie === '' ? { status: 'waiting' } : { status: 'confirmed', value: cookie }
    }
    if (code === 802) return { status: 'scanned' }
    if (code === 800) return { status: 'expired' }
    return { status: 'waiting' }
  }

  private url(path: string, query: Record<string, string | number>): string {
    const url = new URL(`${API_BASE}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    return url.toString()
  }

  private headers(cookie: string): Record<string, string> {
    return { 'User-Agent': USER_AGENT, Referer: 'https://music.163.com/', ...(cookie !== '' && { Cookie: cookie }) }
  }

  // A read whose own `code` is the answer, not an error: the QR endpoints
  // speak entirely in codes, so `call`'s "anything but 200 is a failure"
  // would turn "waiting for the scan" into a thrown error.
  private async plain(path: string, query: Record<string, string | number>): Promise<unknown> {
    const response = await this.send(this.url(path, query), { method: 'GET', headers: this.headers('') })
    if (!response.ok) throw new Error(`netease ${path}: HTTP ${response.status}`)
    return response.json()
  }

  // One round trip with a timeout and one retry on a network error.
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.once(url, init)
    } catch {
      return await this.once(url, init)
    }
  }

  // One round trip: a plain GET carrying the cookie as it stands, a timeout,
  // one retry on a network error and none on an auth answer; the login codes
  // and a 429 become the typed failure.
  private async call(path: string, query: Record<string, string | number>): Promise<unknown> {
    const cookie = await this.deps.cookie()
    const response = await this.send(this.url(path, query), { method: 'GET', headers: this.headers(cookie) })
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

// How the account's cookie was obtained (spec 14 §2.8): scanned here, or
// borrowed from a browser by a mount made before the scan existed.
export type NeteaseAccess = { auth: 'qr'; cookie: string } | { auth?: 'browser' | undefined; browser: BrowserName; profile?: string | undefined }
export type NeteaseEntry = NeteaseAccess & { userId: string; likedPlaylistId: string }

export type MountResult<T> = { ok: true; who: string; entry: T } | { ok: false; reason: 'login-required' }

// The account behind a cookie, and its liked-songs playlist.
async function identify(client: NeteaseClient): Promise<{ who: string; userId: string; likedPlaylistId: string } | null> {
  const account = await client.account()
  if (account === null) return null
  const playlists = await client.playlists(account.userId)
  const liked = playlists.find((p) => p.liked) ?? playlists.find((p) => p.mine) ?? playlists[0]
  if (liked === undefined) return null
  return { who: account.who, userId: account.userId, likedPlaylistId: liked.id }
}

// The browser mount (spec 14 §3.1): the account behind a Chrome profile's
// cookie, and its liked-songs playlist. The entry keeps the browser and the
// profile, never the cookie — yt-dlp exports it again per read, so a sign-out
// there is a sign-out here. No login = a plain "sign in there first".
export async function mountNetease(browser: { browser: BrowserName; profile?: string | undefined }, deps: NeteaseClientDeps): Promise<MountResult<NeteaseEntry>> {
  const who = await identify(new NeteaseClient(deps))
  if (who === null) return { ok: false, reason: 'login-required' }
  return {
    ok: true,
    who: who.who,
    entry: { auth: 'browser', browser: browser.browser, ...(browser.profile !== undefined && { profile: browser.profile }), userId: who.userId, likedPlaylistId: who.likedPlaylistId },
  }
}

// The scan mount (spec 14 §3.1): show the code, wait for the NetEase Cloud
// Music app to confirm it, keep the cookie the platform hands back. No
// browser is read, so nothing needs to be installed, unlocked or permitted.
export async function mountNeteaseQr(deps: Omit<NeteaseClientDeps, 'cookie'>, opts: QrMountOptions): Promise<QrMountResult<NeteaseEntry>> {
  const anonymous = new NeteaseClient({ ...deps, cookie: async () => '' })
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
  const who = await identify(new NeteaseClient({ ...deps, cookie: async () => cookie }))
  if (who === null) return { ok: false, reason: 'login-required' }
  return { ok: true, who: who.who, entry: { auth: 'qr', cookie, userId: who.userId, likedPlaylistId: who.likedPlaylistId } }
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
  readonly kinds = ['liked', 'playlist'] as const

  async snapshot(kinds?: readonly TasteKind[]): Promise<TasteSnapshot> {
    // The identity probe runs whatever is due: a read that quietly returned
    // nothing because the cookie died is the failure this throw exists for.
    if ((await this.client.account()) === null) throw new SourceAuthError('netease', 'login-required', 'the cookie no longer signs in')
    const liked = asked(kinds, 'liked') ? await this.client.playlistTracks(this.entry.likedPlaylistId, BOUNDS.liked) : []
    const playlists = !asked(kinds, 'playlist')
      ? []
      : (await this.client.playlists(this.entry.userId))
          .filter((p) => p.id !== this.entry.likedPlaylistId)
          .slice(0, BOUNDS.playlist)
          .map((p): TasteItem => ({ kind: 'playlist', title: p.name }))
    return { source: 'netease', takenAt: this.now().toISOString(), items: [...liked, ...playlists] }
  }
}
