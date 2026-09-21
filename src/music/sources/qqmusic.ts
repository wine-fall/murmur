// The QQ Music client (spec 14 §2.10): it identifies the account and reads
// what it keeps. It does not play and it does not search. Playing is yt-dlp's
// (§2.5) — a kept song's `ref` is a `y.qq.com/n/ryqq/songDetail/<mid>` URL its
// `qqmusic` extractor takes, resolved with this same mount's cookie, and a
// VIP track is dropped as a per-track rights miss. Searching stays out: there
// is no `qqmusicsearch:` prefix, so the digest is what shapes murmur's
// searches on YouTube, Bilibili and NetEase (§2.4).
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

import type { DailySong, TrackCandidate } from '../../contracts.ts'
import { SourceAuthError } from './auth.ts'
import { scanToSignIn, type QrMountOptions, type QrMountResult, type QrPoll } from './qr.ts'
import type { BrowserName } from './store.ts'
import { asked, BOUNDS, type TasteItem, type TasteKind, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const SONG_URL = 'https://y.qq.com/n/ryqq/songDetail/'
const DEFAULT_TIMEOUT_MS = 15_000
// How far over the asked-for limit a search reaches, and the page the service
// is willing to answer, so the playable remainder still fills the limit.
const VIP_HEADROOM = 3
const SEARCH_PAGE_MAX = 30
// The web player's own user agent; an unbranded client is answered with empty
// lists rather than an error.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
// QQ Music's own directory id for the account's liked songs. It is fixed
// across accounts — the list's NAME is localised, its dir id is not.
const LIKED_DIR_ID = 201
// The codes a lost login answers with, and the one for "slow down".
const LOGIN_CODES = new Set([1000, 104401, 104400])
const RATE_LIMITED_CODE = 104604

// The WeChat scan (spec 14 §2.10). QQ Music's own app id on the WeChat open
// platform, and the page that hands out a code for it.
const WX_APPID = 'wx48db31d50e334801'
const WX_REDIRECT = 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/'
const WX_QRCONNECT = 'https://open.weixin.qq.com/connect/qrconnect'
// What the code image encodes — decoded from the served JPEG, so murmur draws
// the string itself and never has to show a fetched picture.
const WX_CONFIRM = 'https://open.weixin.qq.com/connect/confirm?uuid='
const WX_POLL = 'https://lp.open.weixin.qq.com/connect/l/qrconnect'
// The poll is a long one — the platform holds it ~15 s. It gets its own,
// shorter patience: the scan loop only hears a stop between polls, so a
// listener pressing Esc must not wait out the platform's hold. A poll that
// times out reads as waiting, which is what it was.
const WX_POLL_MS = 12_000
// The poll's own answers: waiting, the phone has it, and confirmed. 402 and
// 403 (expired, refused) were never reached in the capture, so they are not
// claimed here — an unknown code reads as waiting, and the scan loop's own
// deadline is what ends it.
const WX_WAITING = 408
const WX_SCANNED = 404
const WX_CONFIRMED = 405

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
const SearchSchema = z.object({ body: z.object({ song: z.object({ list: z.array(z.unknown()).nullish() }).nullish() }).nullish() })
// A search hit is a song row plus the rights flag the taste reads never carry.
const SearchHitSchema = SongSchema.extend({ interval: z.number().nullish(), pay: z.object({ pay_play: z.number().nullish() }).nullish() })
// The radar (spec 14 3.10): the platform's own push for this account, the
// second feed of the daily lane. It carries no reason of its own.
const RadarSchema = z.object({ VecSongs: z.array(z.object({ Track: z.unknown() })).nullish() })
// The scan's exchange answers with some three dozen keys; these five are the
// whole of what a mount needs. `str_musicid` is NOT interchangeable with
// `musicid`: the account number is 19 digits, and JSON.parse rounds it
// through a double (a real uin of ...943987 comes back as ...944000), so
// reads addressed with the number would target an account that is not there.
const LoginSchema = z.object({
  str_musicid: z.string(),
  musickey: z.string(),
  encryptUin: z.string(),
})

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

  // The search catalogue (spec 14 §2.4). This is what makes QQ Music playback
  // reachable: the taste digest carries titles, not refs, so without a search
  // the brain can never hand submit_pick a y.qq.com ref.
  //
  // Signed in only. An unsigned search is not refused — it answers `code: 0`
  // with an EMPTY list, which reads exactly like "no such song", so a mount
  // with no credential is turned away here rather than surfacing as no hits.
  // The radar (spec 14 3.10), the QQ feed of the daily lane. `GetSimilarSongs`
  // beside it answers `vecSong: null` on every seed measured, so neighbours
  // are read from NetEase and YouTube instead.
  async radar(limit: number): Promise<DailySong[]> {
    const data = await this.call('music.recommend.TrackRelationServer', 'GetRadarSong', { Page: 1, ReqType: 0, FavSongs: [], EntranceSongs: [] })
    const out: DailySong[] = []
    for (const row of RadarSchema.parse(data).VecSongs ?? []) {
      if (out.length >= limit) break
      const hit = SearchHitSchema.safeParse(row.Track)
      if (!hit.success || hit.data.name.trim() === '') continue
      // A VIP track cannot play on this account (2.5).
      if (hit.data.pay?.pay_play === 1) continue
      out.push({
        ref: `${SONG_URL}${hit.data.mid}`,
        title: hit.data.name,
        artist: (hit.data.singer ?? []).map((singer) => singer.name.trim()).filter((n) => n !== '').join(' / '),
      })
    }
    return out
  }

  async search(query: string, limit: number): Promise<TrackCandidate[]> {
    const cookie = await this.deps.cookie()
    if (credentialFrom(cookie) === null) throw new SourceAuthError('qqmusic', 'login-required', 'a search needs the account')
    const data = await this.call('music.search.SearchCgiService', 'DoSearchForQQMusicDesktop', {
      query,
      search_type: 0,
      // Roughly two thirds of a real result page is VIP (measured over a
      // 60-song sample, 2026-09-16), so asking for exactly the limit would
      // leave the brain one or two candidates to choose between.
      num_per_page: Math.min(limit * VIP_HEADROOM, SEARCH_PAGE_MAX),
      page_num: 1,
      // Off, or the service wraps the matched words in markup and the title
      // reaches the brain with tags in it.
      highlight: 0,
    })
    const candidates: TrackCandidate[] = []
    for (const raw of SearchSchema.parse(data).body?.song?.list ?? []) {
      const hit = SearchHitSchema.safeParse(raw)
      if (!hit.success || hit.data.name.trim() === '') continue
      // A VIP track cannot play on this account (§2.5). The rights miss at
      // resolve time is the safety net — a flag can be stale or regional —
      // not the plan: dropping it here saves an extraction and a model turn.
      if (hit.data.pay?.pay_play === 1) continue
      const album = hit.data.album?.name?.trim()
      candidates.push({
        ref: `${SONG_URL}${hit.data.mid}`,
        title: hit.data.name,
        uploader: (hit.data.singer ?? [])
          .map((singer) => singer.name.trim())
          .filter((name) => name !== '')
          .join(' / '),
        durationS: Math.trunc(hit.data.interval ?? 0),
        extra: album === undefined || album === '' ? {} : { album },
        catalogue: 'qqmusic',
      })
    }
    return candidates.slice(0, limit)
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

  // The code to draw (spec 14 §2.10): the platform serves a JPEG, but what
  // matters is the string inside it, which the confirm URL reproduces.
  async wxQrCode(): Promise<{ uuid: string; url: string }> {
    const query = new URLSearchParams({
      appid: WX_APPID,
      redirect_uri: WX_REDIRECT,
      response_type: 'code',
      scope: 'snsapi_login',
      state: 'state',
      login_type: 'jssdk',
      self_redirect: 'default',
    })
    const page = await this.text(`${WX_QRCONNECT}?${query}`, WX_QRCONNECT)
    if (page.text === undefined) throw new Error(`qqmusic wechat qrconnect: HTTP ${page.status}`)
    const uuid = /uuid=([A-Za-z0-9_-]+)/.exec(page.text)?.[1]
    if (uuid === undefined) throw new Error('qqmusic wechat qrconnect: no uuid in the page')
    return { uuid, url: `${WX_CONFIRM}${uuid}` }
  }

  // One long poll. Its whole answer is a pair of assignments in a script body.
  async wxQrPoll(uuid: string): Promise<QrPoll<string>> {
    let answer: { status: number; text?: string }
    try {
      answer = await this.text(`${WX_POLL}?uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`, 'https://open.weixin.qq.com/', this.deps.timeoutMs ?? WX_POLL_MS, false)
    } catch {
      // Aborted at our own patience, or the network blinked: still waiting,
      // which is what it was. Only THIS is read as a quiet wait.
      return { status: 'waiting' }
    }
    // A refusal from the service is not a quiet wait. Swallowed as one, the
    // loop would keep asking a service that just said to stop for the whole
    // three minutes, and then report the code as expired.
    if (answer.status === 429) throw new SourceAuthError('qqmusic', 'rate-limited', 'HTTP 429 on the WeChat poll')
    if (answer.text === undefined) throw new Error(`qqmusic wechat poll: HTTP ${answer.status}`)
    const seen = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/.exec(answer.text)
    if (seen === null) return { status: 'waiting' }
    const [, code, granted] = seen as unknown as [string, string, string]
    if (Number(code) === WX_SCANNED) return { status: 'scanned' }
    // A confirmation carrying no code is not a sign-in; it waits out the
    // deadline rather than mounting an account with no credential.
    if (Number(code) === WX_CONFIRMED && granted !== '') return { status: 'confirmed', value: granted }
    if (Number(code) === WX_WAITING) return { status: 'waiting' }
    return { status: 'waiting' }
  }

  // The scanned code becomes the account's credential, written as the very
  // cookie header a browser jar would have carried — so nothing downstream
  // learns which road the mount came down. The exchange also answers with a
  // `nick`, but it is blank on a returning account, so the name is not taken
  // from here (see mountQQMusicQr).
  async wxLogin(code: string): Promise<{ cookie: string }> {
    const answer = await this.post(
      JSON.stringify({
        comm: { ct: 24, cv: 4747474, platform: 'yqq.json', tmeLoginType: 1 },
        req: { module: 'music.login.LoginServer', method: 'Login', param: { code, strAppid: WX_APPID } },
      }),
      '',
    )
    const data = LoginSchema.parse(this.unwrap(answer, 'music.login.LoginServer.Login'))
    return {
      cookie: [
        `uin=${data.str_musicid}`,
        `wxuin=${data.str_musicid}`,
        `qm_keyst=${data.musickey}`,
        `qqmusic_key=${data.musickey}`,
        `euin=${data.encryptUin}`,
      ].join('; '),
    }
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
    return this.unwrap(await this.post(body, cookie), `${module}.${method}`)
  }

  // The envelope's inner code is the real one; the outer is always 0. The
  // codes a lost login answers with become the typed failure, so the
  // expired/reconnect road works the same whichever call raised it.
  private unwrap(answer: { status: number; json?: unknown }, what: string): unknown {
    if (answer.status === 429) throw new SourceAuthError('qqmusic', 'rate-limited', `HTTP 429 on ${what}`)
    if (answer.json === undefined) throw new Error(`qqmusic ${what}: HTTP ${answer.status}`)
    const { req } = EnvelopeSchema.parse(answer.json)
    if (LOGIN_CODES.has(req.code)) throw new SourceAuthError('qqmusic', 'login-required', `code ${req.code} on ${what}`)
    if (req.code === RATE_LIMITED_CODE) throw new SourceAuthError('qqmusic', 'rate-limited', `code ${req.code} on ${what}`)
    if (req.code !== 0) throw new Error(`qqmusic ${what}: code ${req.code}`)
    return req.data
  }

  private post(body: string, cookie: string): Promise<{ status: number; json?: unknown }> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://y.qq.com/', 'Content-Type': 'application/json', ...(cookie !== '' && { Cookie: cookie }) },
      body,
    }
    return this.retried(() => this.round(API, init, (r) => r.json(), 'json'))
  }

  // A plain GET whose body is text: the two scan calls, neither of which
  // carries a cookie — there is not one yet.
  private text(url: string, referer: string, timeoutMs?: number, retry = true): Promise<{ status: number; text?: string }> {
    const init: RequestInit = { method: 'GET', headers: { 'User-Agent': USER_AGENT, Referer: referer } }
    const read = (): Promise<{ status: number; text?: string }> => this.round(url, init, (r) => r.text(), 'text', timeoutMs)
    return retry ? this.retried(read) : read()
  }

  private async retried<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch {
      return await work()
    }
  }

  // ONE round trip under ONE deadline. The timer is cleared only once the
  // body has been read, so the abort it fires covers the whole request:
  // fetch resolves on the headers alone, and a body that then stalls must be
  // ABORTED, not merely stopped being waited for — otherwise every stalled
  // read leaks its connection while the scan loop keeps polling.
  private async round(
    url: string,
    init: RequestInit,
    read: (r: Response) => Promise<unknown>,
    key: 'json' | 'text',
    timeoutMs?: number,
  ): Promise<{ status: number; json?: unknown; text?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal })
      // A body that is not going to be read is not waited for either.
      if (!response.ok) return { status: response.status }
      return { status: response.status, [key]: await read(response) }
    } finally {
      clearTimeout(timer)
    }
  }
}

// A mount made by scanning holds the credential itself, written as the very
// cookie header a browser jar would have carried; a browser mount holds the
// Chrome pin and re-exports that jar per read.
export type QQMusicEntry = { auth: 'qr'; cookie: string } | { auth?: 'browser' | undefined; browser: BrowserName; profile?: string | undefined }

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
  readonly kinds = ['liked', 'playlist'] as const

  async snapshot(kinds?: readonly TasteKind[]): Promise<TasteSnapshot> {
    const account = await this.client.account()
    if (account === null) throw new SourceAuthError('qqmusic', 'login-required', 'the cookie no longer signs in')
    const liked = asked(kinds, 'liked') ? await this.client.likedSongs(account.euin, BOUNDS.liked) : []
    const names: TasteItem[] = []
    if (asked(kinds, 'playlist')) {
      const created = (await this.client.playlists(account.uin)).filter((list) => !list.liked).map((list) => list.name)
      names.push(
        ...[...created, ...(await this.client.favouritePlaylists(account.euin))]
          .slice(0, BOUNDS.playlist)
          .map((title): TasteItem => ({ kind: 'playlist', title })),
      )
    }
    return { source: 'qqmusic', takenAt: this.now().toISOString(), items: [...liked, ...names] }
  }
}

// The scan mount (spec 14 §2.10): show the code, wait for WeChat to confirm
// it, keep the credential the exchange hands back. No browser is read, so
// nothing needs to be installed, unlocked or permitted.
export async function mountQQMusicQr(deps: Omit<QQMusicClientDeps, 'cookie'>, opts: QrMountOptions): Promise<QrMountResult<QQMusicEntry>> {
  const anonymous = new QQMusicClient({ ...deps, cookie: async () => '' })
  let uuid = ''
  const scan = await scanToSignIn<string>({
    ...opts,
    issue: async () => {
      const issued = await anonymous.wxQrCode()
      uuid = issued.uuid
      return { url: issued.url }
    },
    poll: () => anonymous.wxQrPoll(uuid),
  })
  if (!scan.ok) return scan
  const { cookie } = await anonymous.wxLogin(scan.value)
  // The credential is read back before it is mounted. It names the account —
  // the exchange's own `nick` comes back blank for a returning listener — and
  // it proves the minted cookie actually signs in, so a mount is never made
  // on a credential that does not work.
  const account = await new QQMusicClient({ ...deps, cookie: async () => cookie }).account()
  if (account === null) return { ok: false, reason: 'login-required' }
  return { ok: true, who: account.who, entry: { auth: 'qr', cookie } }
}
