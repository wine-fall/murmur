// The QQ Music client (spec 14 §2.10): a taste-only source. QQ Music is read,
// never played — yt-dlp's `qqmusic` extractor cannot resolve a song today
// ("unable to extract init data" / "only available for registered users",
// with and without a browser cookie), and there is no `qqmusicsearch:` prefix
// to search with. So this client identifies the account and reads what it
// keeps; the digest then shapes what murmur searches for on YouTube,
// Bilibili and NetEase (§2.4).
//
// One endpoint does all of it: `u.y.qq.com/cgi-bin/musicu.fcg` takes a POST
// whose body names a module and a method, and answers `{code, req:{code,
// data}}`. The credential is the browser's own — `qm_keyst` plus the uin —
// with `g_tk = hash33(key, 5381)` in the comm block. Nothing is signed beyond
// that and no client key is borrowed.
//
// Every response is an untrusted boundary: zod at the edge, and the codes QQ
// Music answers a lost login with (1000, 104401, 104400) become the typed
// auth failure.

import { z } from 'zod'

import { SourceAuthError } from './auth.ts'
import type { BrowserName } from './store.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const SONG_URL = 'https://y.qq.com/n/ryqq/songDetail/'
const DEFAULT_TIMEOUT_MS = 15_000
// The web player's own user agent; an unbranded client is answered with empty
// lists rather than an error.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
// QQ Music's own directory id for the account's liked songs. It is fixed
// across accounts — the list's NAME is localised, its dir id is not.
const LIKED_DIR_ID = 201
// The codes a lost login answers with, and the one for "slow down".
const LOGIN_CODES = new Set([1000, 104401, 104400])
const RATE_LIMITED_CODE = 104604

export type QQMusicFetch = (url: string, init?: RequestInit) => Promise<Response>

export type QQMusicClientDeps = {
  // The cookie header for y.qq.com, read at call time from the browser.
  cookie: () => Promise<string>
  fetch?: QQMusicFetch
  timeoutMs?: number
  now?: () => Date
}

// QQ Music's own hash, over the key, for the `g_tk` every signed-in read
// carries. Both sign-in roads use the same one; only the seed differs.
function hash33(text: string, seed = 0): number {
  let hash = seed
  for (const char of text) hash += (hash << 5) + char.codePointAt(0)!
  return hash & 0x7fff_ffff
}

// What the browser's jar carries for a signed-in account. `uin` is the plain
// account number (a WeChat sign-in spells it `wxuin`), `euin` its encrypted
// form — the lists are addressed by the encrypted one — and `key` the
// credential itself. A jar missing either half holds no login.
export type QQMusicCredential = { uin: string; euin: string; key: string }

export function credentialFrom(cookie: string): QQMusicCredential | null {
  // yt-dlp exports one row per domain, so a name can appear twice (`.qq.com`
  // and `.y.qq.com` both carry `qm_keyst`); the first non-empty one wins.
  const jar = new Map<string, string>()
  for (const pair of cookie.split(';')) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (value !== '' && !jar.has(name)) jar.set(name, value)
  }
  const uin = jar.get('uin') ?? jar.get('wxuin') ?? jar.get('qqmusic_uin') ?? ''
  const key = jar.get('qm_keyst') ?? jar.get('qqmusic_key') ?? ''
  if (uin === '' || key === '') return null
  return { uin, euin: jar.get('euin') ?? '', key }
}

const EnvelopeSchema = z.object({ req: z.object({ code: z.number(), data: z.unknown().optional() }) })
const WhoSchema = z.object({ info: z.object({ nick: z.string() }) })
const PlaylistsSchema = z.object({
  v_playlist: z.array(z.object({ dirId: z.number(), dirName: z.string(), tid: z.number(), songNum: z.number().optional() })).nullish(),
})
const DissSchema = z.object({ songlist: z.array(z.unknown()).nullish() })
const SongSchema = z.object({
  mid: z.string(),
  name: z.string(),
  singer: z.array(z.object({ name: z.string() })).nullish(),
  album: z.object({ name: z.string().optional() }).nullish(),
})
const FavouritesSchema = z.object({ v_list: z.array(z.object({ name: z.string() })).nullish() })

export type QQMusicPlaylist = { id: string; name: string; songCount: number; liked: boolean }

export class QQMusicClient {
  private deps: QQMusicClientDeps
  private fetch: QQMusicFetch

  constructor(deps: QQMusicClientDeps) {
    this.deps = deps
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
  }

  // null = the browser holds no QQ Music login, either because the jar has no
  // credential at all (no round trip is spent finding that out) or because
  // the credential it has no longer signs in.
  async account(): Promise<{ uin: string; euin: string; who: string } | null> {
    const credential = credentialFrom(await this.deps.cookie())
    if (credential === null) return null
    let data: unknown
    try {
      data = await this.call('music.UserInfo.userInfoServer', 'GetLoginUserInfo', {})
    } catch (err) {
      // A lost login is an answer here, not a failure; anything else — a
      // rate limit, a network error — is still the caller's problem.
      if (err instanceof SourceAuthError && err.reason === 'login-required') return null
      throw err
    }
    // Parsed strictly: only a missing credential or a login code is "no
    // account". A body that does not fit the shape is a bug at the far end,
    // and read as a lost login it would flip the mount to expired and stop
    // the refresher re-reading it — demanding a sign-in nothing is wrong with.
    const who = WhoSchema.parse(data).info.nick
    if (who.trim() === '') throw new Error('qqmusic GetLoginUserInfo: a signed-in account with no name')
    return { uin: credential.uin, euin: credential.euin, who }
  }

  // The lists the account created. The liked one is the fixed dir 201 — it is
  // one of these, which is why it never also contributes its name (§3.5).
  async playlists(uin: string): Promise<QQMusicPlaylist[]> {
    const data = await this.call('music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin', { uin })
    return (PlaylistsSchema.parse(data).v_playlist ?? []).map((list) => ({
      id: String(list.tid),
      name: list.dirName,
      songCount: list.songNum ?? 0,
      liked: list.dirId === LIKED_DIR_ID,
    }))
  }

  // The newest `cap` liked songs. One read: asking for `song_num = cap`
  // returns the whole list up to the bound, so nothing is paged (verified
  // against a 167-song list, 2026-09-16).
  async likedSongs(euin: string, cap: number): Promise<TasteItem[]> {
    const data = await this.call('music.srfDissInfo.DissInfo', 'CgiGetDiss', {
      disstid: 0,
      dirid: LIKED_DIR_ID,
      tag: true,
      song_begin: 0,
      song_num: cap,
      userinfo: true,
      orderlist: true,
      enc_host_uin: euin,
    })
    const items: TasteItem[] = []
    for (const raw of DissSchema.parse(data).songlist ?? []) {
      const song = SongSchema.safeParse(raw)
      if (!song.success || song.data.name.trim() === '') continue
      const artist = (song.data.singer ?? [])
        .map((s) => s.name.trim())
        .filter((n) => n !== '')
        .join(' / ')
      const album = song.data.album?.name?.trim()
      items.push({
        kind: 'liked',
        title: song.data.name,
        ...(artist !== '' && { artist }),
        ...(album !== undefined && album !== '' && { album }),
        ref: `${SONG_URL}${song.data.mid}`,
      })
    }
    // The service returns the list in its own order — newest kept first —
    // and carries no per-song kept-at date, so the items carry none either.
    return items.slice(0, cap)
  }

  // Someone else's lists the account keeps: names only, like every other
  // playlist row in the digest.
  async favouritePlaylists(euin: string): Promise<string[]> {
    const data = await this.call('music.musicasset.PlaylistFavRead', 'CgiGetPlaylistFavInfo', { uin: euin, offset: 0, size: BOUNDS.playlist })
    return (FavouritesSchema.parse(data).v_list ?? []).map((list) => list.name.trim()).filter((name) => name !== '')
  }

  // One round trip with a timeout, one retry on a network error and none on
  // an auth answer. The envelope is always HTTP 200 with an outer code 0 —
  // the inner `req.code` is the real one, so it is what gets classified.
  private async call(module: string, method: string, param: Record<string, unknown>): Promise<unknown> {
    const cookie = await this.deps.cookie()
    const credential = credentialFrom(cookie)
    if (credential === null) throw new SourceAuthError('qqmusic', 'login-required', `no QQ Music login in the browser (${module}.${method})`)
    const gtk = hash33(credential.key, 5381)
    const body = JSON.stringify({
      comm: {
        ct: 24,
        cv: 4747474,
        platform: 'yqq.json',
        chid: '0',
        uin: credential.uin,
        g_tk: gtk,
        g_tk_new_20200303: gtk,
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        need_new_code: 1,
      },
      req: { module, method, param },
    })
    const answer = await this.send(cookie, body)
    if (answer.status === 429) throw new SourceAuthError('qqmusic', 'rate-limited', `HTTP 429 on ${module}.${method}`)
    if (answer.json === undefined) throw new Error(`qqmusic ${module}.${method}: HTTP ${answer.status}`)
    const { req } = EnvelopeSchema.parse(answer.json)
    if (LOGIN_CODES.has(req.code)) throw new SourceAuthError('qqmusic', 'login-required', `code ${req.code} on ${module}.${method}`)
    if (req.code === RATE_LIMITED_CODE) throw new SourceAuthError('qqmusic', 'rate-limited', `code ${req.code} on ${module}.${method}`)
    if (req.code !== 0) throw new Error(`qqmusic ${module}.${method}: code ${req.code}`)
    return req.data
  }

  // The status, and the parsed body for an answer that has one. The body is
  // read INSIDE the timeout: fetch resolves on the headers alone, so a
  // response that stalls mid-body would hang the mount the listener is
  // waiting on and leave a background refresh unable to finish.
  private async send(cookie: string, body: string): Promise<{ status: number; json?: unknown }> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://y.qq.com/', 'Content-Type': 'application/json', ...(cookie !== '' && { Cookie: cookie }) },
      body,
    }
    try {
      return await this.once(init)
    } catch {
      return await this.once(init)
    }
  }

  private async once(init: RequestInit): Promise<{ status: number; json?: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetch(API, { ...init, signal: controller.signal })
      // A body that is not going to be read is not waited for either.
      if (!response.ok) return { status: response.status }
      return { status: response.status, json: await response.json() }
    } finally {
      clearTimeout(timer)
    }
  }
}

// A QQ Music mount is a browser mount and nothing else (spec 14 §3.1): there
// is no scan road in this build, so the entry is the Chrome pin alone — the
// account's own identifiers ride in the cookie, which is re-exported per read.
// The `auth` key is written for symmetry with the other cookie sources and to
// leave the scanned arm free if a scan road is ever added.
export type QQMusicEntry = { auth?: 'browser' | undefined; browser: BrowserName; profile?: string | undefined }

export type QQMusicMountResult = { ok: true; who: string; entry: QQMusicEntry } | { ok: false; reason: 'login-required' }

// The browser mount: who the Chrome profile's cookie signs in as. The entry
// keeps the browser and the profile, never the cookie — yt-dlp exports it
// again per read, so a sign-out there is a sign-out here.
export async function mountQQMusic(browser: { browser: BrowserName; profile?: string | undefined }, deps: QQMusicClientDeps): Promise<QQMusicMountResult> {
  const account = await new QQMusicClient(deps).account()
  if (account === null) return { ok: false, reason: 'login-required' }
  return {
    ok: true,
    who: account.who,
    entry: { auth: 'browser', browser: browser.browser, ...(browser.profile !== undefined && { profile: browser.profile }) },
  }
}

export class QQMusicSource implements TasteSource {
  readonly id = 'qqmusic' as const
  private client: QQMusicClient
  private now: () => Date

  constructor(deps: QQMusicClientDeps) {
    this.client = new QQMusicClient(deps)
    this.now = deps.now ?? (() => new Date())
  }

  async verify(): Promise<VerifyResult> {
    const account = await this.client.account()
    return account === null ? { ok: false, reason: 'login-required' } : { ok: true, who: account.who }
  }

  // The liked list IS the snapshot's body (spec 14 §3.5); the created and
  // favourited lists contribute their names only.
  //
  // The login is checked FIRST, and the result is what the reads are
  // addressed with. Verified against the live service (2026-09-16): with the
  // key flipped, GetPlaylistByUin still answers code 0 with the account's
  // lists — it authenticates on the uin alone. A snapshot that skipped this
  // check would read a signed-out account as healthy and never say "expired".
  async snapshot(): Promise<TasteSnapshot> {
    const account = await this.client.account()
    if (account === null) throw new SourceAuthError('qqmusic', 'login-required', 'the cookie no longer signs in')
    const liked = await this.client.likedSongs(account.euin, BOUNDS.liked)
    const created = (await this.client.playlists(account.uin)).filter((list) => !list.liked).map((list) => list.name)
    const names = [...created, ...(await this.client.favouritePlaylists(account.euin))]
      .slice(0, BOUNDS.playlist)
      .map((title): TasteItem => ({ kind: 'playlist', title }))
    return { source: 'qqmusic', takenAt: this.now().toISOString(), items: [...liked, ...names] }
  }
}
