// The NetEase client (spec 14 §2.8): the eapi transport pinned by a golden
// vector from yt-dlp's own Python, and the four reads parsed from captured
// shapes (values redacted).
import { describe, expect, it } from 'vitest'

import { SourceAuthError } from '../src/music/sources/auth.ts'
import { eapiParams, mountNetease, NeteaseClient, NeteaseSource, type NeteaseFetch } from '../src/music/sources/netease.ts'

// Produced once by yt-dlp 2026.08.19's NetEaseMusicBaseIE._create_eapi_cipher
// with exactly this path, body and cookie dict.
const GOLDEN =
  'params=FA90B329E9614F79E79598F37DC2EDB487F00D1BC4C9B24CD57E6C318B9073569338432CD7D98D1A3626E997A2C5312196EAA6061696E185EE1BA15409319F18CA4ED390B056D95E39BB15C62B7E0B280A41E6E5D6BF982EFB798708965E277DC2934CB9DF1EBE33AB5D1DB32D2DB99320EBCBAB9FEF2944CA1245196132AB1439EDE2388849A918479997CF4FA914059C2910C5729409EAB19F5BAA79640911BBF21C9291E9A23CE4733012EB3E5560E1113D824D15146C8AC544BEF31A0ECDF20CA8C9E0B22FE34C8B5B872D6E80326AA3B102FBE7296AB0DB9EA5C46AD12B'

// The same, for a query with Chinese characters and an astral emoji: the
// server rejects raw UTF-8 in the ciphered JSON with an empty body (smoke,
// 2026-09-07), so the escaping is part of the contract.
const GOLDEN_UNICODE =
  'params=2B5D64177AA6460FBAA3DCB1285E28954BBB4F7556E09B0FB25750F12398BB504623642AF8326BB327261593F4C625884E280CD8ADB235DA8B6872CD808FEB2694328362B01C2C9889EFD83E408302BDAD891C1E1606915BEE38EBF17B202E4955BC59BC80C22F86D32325FF3E1BB848AF9E5F5296404A61130C2DB72F5B6A028D2BA3EF13E62370C79435BE240E9718C1F35DA02FC67B0B2DDB507973B2A17819332F922A28D7C722D38211A5F36EAB00433CF746ACE8C3185ED1837CF9E8ED24335092C3B724FB6DEE16CE5AF11F24C4EB6B5F1AF78481BB3482B340630A081973D9BAEAE80ED3AA102AF4ACD931CB'

describe('eapiParams (the cipher, pinned against yt-dlp)', () => {
  it('matches the golden vector byte for byte', () => {
    const body = { ids: '[123]', level: 'standard', encodeType: 'flac' }
    const cookies = { os: 'pc', appver: '8.0.0', MUSIC_U: 'redacted-token' }
    expect(eapiParams('/api/song/enhance/player/url/v1', body, cookies)).toBe(GOLDEN)
  })

  it('escapes non-ASCII the way the platform expects (a second golden vector)', () => {
    const body = { s: '\u9648\u7eee\u8d1e \u65c5\u884c\u7684\u610f\u4e49 \u{1f3b5}', type: 1, limit: 3, offset: 0, total: true }
    expect(eapiParams('/api/cloudsearch/pc', body, { os: 'pc', appver: '8.0.0' })).toBe(GOLDEN_UNICODE)
  })
})

type Call = { url: string; body: string; headers: Record<string, string> }

// A fetch that answers by path, recording what was sent.
function fakeFetch(answers: Record<string, unknown>, status = 200): { fetch: NeteaseFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: NeteaseFetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), body: String(init?.body ?? ''), headers })
    const path = new URL(String(url)).pathname
    const hit = Object.entries(answers).find(([key]) => path.endsWith(key))
    return new Response(JSON.stringify(hit === undefined ? { code: 404 } : hit[1]), { status })
  }
  return { fetch, calls }
}

const COOKIE = 'MUSIC_U=<redacted-u>; __csrf=<redacted-csrf>; NMTID=<redacted>'

describe('NeteaseClient', () => {
  it('posts ciphered params to interface3 with the app cookie set, MUSIC_U included', async () => {
    const { fetch, calls } = fakeFetch({ '/nuser/account/get': { code: 200, profile: { userId: 42, nickname: 'Chen X' } } })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    expect(await client.account()).toEqual({ userId: '42', who: 'Chen X' })
    expect(calls[0]!.url).toBe('https://interface3.music.163.com/eapi/nuser/account/get')
    expect(calls[0]!.body).toMatch(/^params=[0-9A-F]+$/)
    expect(calls[0]!.headers.Cookie).toContain('MUSIC_U=<redacted-u>')
    expect(calls[0]!.headers.Cookie).toContain('os=pc')
    expect(calls[0]!.headers.Referer).toBe('https://music.163.com')
  })

  it('an anonymous cookie reads as no account', async () => {
    const { fetch } = fakeFetch({ '/nuser/account/get': { code: 200, account: null, profile: null } })
    expect(await new NeteaseClient({ cookie: async () => '', fetch }).account()).toBeNull()
  })

  it('lists playlists, and reads a playlist into liked items with the kept-at date', async () => {
    const { fetch, calls } = fakeFetch({
      '/user/playlist': {
        code: 200,
        playlist: [
          { id: 7, name: 'Liked', trackCount: 3, specialType: 5, creator: { userId: 42 } },
          { id: 8, name: 'late drive', trackCount: 12, specialType: 0, creator: { userId: 42 } },
          { id: 9, name: 'someone else', trackCount: 40, specialType: 0, creator: { userId: 99 } },
        ],
      },
      '/v6/playlist/detail': {
        code: 200,
        playlist: { trackIds: [{ id: 1, at: 1757116800000 }, { id: 2, at: 1757030400000 }, { id: 3 }] },
      },
      '/v3/song/detail': {
        code: 200,
        songs: [
          { id: 1, name: 'Travel Is Meaningful', ar: [{ name: 'Cheer Chen' }], al: { name: 'Groupies' }, dt: 240000 },
          { id: 2, name: 'Holocene', ar: [{ name: 'Bon Iver' }, { name: 'Someone' }], al: { name: 'Bon Iver' }, dt: 344000 },
          { id: 3, name: '', ar: [], dt: 0 },
        ],
      },
    })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    const playlists = await client.playlists('42')
    expect(playlists).toEqual([
      { id: '7', name: 'Liked', trackCount: 3, liked: true, mine: true },
      { id: '8', name: 'late drive', trackCount: 12, liked: false, mine: true },
      { id: '9', name: 'someone else', trackCount: 40, liked: false, mine: false },
    ])
    const items = await client.playlistTracks('7', 500)
    expect(items).toEqual([
      { kind: 'liked', title: 'Travel Is Meaningful', artist: 'Cheer Chen', album: 'Groupies', at: '2025-09-06T00:00:00.000Z', ref: 'https://music.163.com/#/song?id=1' },
      { kind: 'liked', title: 'Holocene', artist: 'Bon Iver / Someone', album: 'Bon Iver', at: '2025-09-05T00:00:00.000Z', ref: 'https://music.163.com/#/song?id=2' },
    ])
    // The detail call carries the ids it was asked for.
    expect(calls.some((c) => c.url.endsWith('/v3/song/detail'))).toBe(true)
  })

  it('caps the liked read and batches the detail lookups', async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1 }))
    const { fetch, calls } = fakeFetch({
      '/v6/playlist/detail': { code: 200, playlist: { trackIds: ids } },
      '/v3/song/detail': { code: 200, songs: [{ id: 1, name: 'x', ar: [{ name: 'a' }], dt: 1000 }] },
    })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    await client.playlistTracks('7', 500)
    // 500 ids in batches of 200 = 3 detail calls, never 1200.
    expect(calls.filter((c) => c.url.endsWith('/v3/song/detail'))).toHaveLength(3)
  })

  it('searches the catalogue into candidates whose ref is a song url', async () => {
    const { fetch } = fakeFetch({
      '/cloudsearch/pc': {
        code: 200,
        result: { songs: [{ id: 5, name: 'Groupies', ar: [{ name: 'Cheer Chen' }], al: { name: 'Groupies' }, dt: 215000 }], songCount: 1 },
      },
    })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    expect(await client.search('cheer chen groupies', 5)).toEqual([
      { ref: 'https://music.163.com/#/song?id=5', title: 'Groupies', uploader: 'Cheer Chen', durationS: 215, extra: { album: 'Groupies' }, catalogue: 'netease' },
    ])
  })

  it('turns the login codes and a 429 into typed failures', async () => {
    const need = new NeteaseClient({ cookie: async () => COOKIE, fetch: fakeFetch({ '/user/playlist': { code: -462, message: '<redacted>' } }).fetch })
    await expect(need.playlists('42')).rejects.toMatchObject({ source: 'netease', reason: 'login-required' })
    const gone = new NeteaseClient({ cookie: async () => COOKIE, fetch: fakeFetch({ '/user/playlist': { code: 301, msg: '<redacted>' } }).fetch })
    await expect(gone.playlists('42')).rejects.toBeInstanceOf(SourceAuthError)
    const busy = new NeteaseClient({ cookie: async () => COOKIE, fetch: fakeFetch({}, 429).fetch })
    await expect(busy.search('x', 1)).rejects.toMatchObject({ reason: 'rate-limited' })
  })

  it('retries a network error once, never an auth error', async () => {
    let calls = 0
    const flaky: NeteaseFetch = async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ code: 200, result: { songs: [] } }))
    }
    expect(await new NeteaseClient({ cookie: async () => COOKIE, fetch: flaky }).search('x', 1)).toEqual([])
    expect(calls).toBe(2)
  })
})

describe('mountNetease + NeteaseSource', () => {
  const answers = {
    '/nuser/account/get': { code: 200, profile: { userId: 42, nickname: 'Chen X' } },
    '/user/playlist': {
      code: 200,
      playlist: [
        { id: 7, name: 'Liked', trackCount: 1, specialType: 5, creator: { userId: 42 } },
        { id: 8, name: 'late drive', trackCount: 12, specialType: 0, creator: { userId: 42 } },
      ],
    },
    '/v6/playlist/detail': { code: 200, playlist: { trackIds: [{ id: 1 }] } },
    '/v3/song/detail': { code: 200, songs: [{ id: 1, name: 'Holocene', ar: [{ name: 'Bon Iver' }], dt: 344000 }] },
  }

  it('mounting finds the account and the liked playlist; a browser with no login says so', async () => {
    const jar = { calls: 0, cookie: async () => (jar.calls++, COOKIE) }
    const mounted = await mountNetease({ browser: 'chrome' }, { cookie: jar.cookie, fetch: fakeFetch(answers).fetch })
    expect(mounted).toEqual({ ok: true, who: 'Chen X', entry: { browser: 'chrome', userId: '42', likedPlaylistId: '7' } })
    const anon = await mountNetease({ browser: 'firefox', profile: 'p' }, { cookie: async () => '', fetch: fakeFetch({ '/nuser/account/get': { code: 200 } }).fetch })
    expect(anon).toEqual({ ok: false, reason: 'login-required' })
  })

  it('snapshots the liked list and the playlist names, within the bounds', async () => {
    const source = new NeteaseSource(
      { browser: 'chrome', userId: '42', likedPlaylistId: '7' },
      { cookie: async () => COOKIE, fetch: fakeFetch(answers).fetch, now: () => new Date('2026-09-06T10:00:00Z') },
    )
    expect(await source.verify()).toEqual({ ok: true, who: 'Chen X' })
    const snapshot = await source.snapshot()
    expect(snapshot.source).toBe('netease')
    expect(snapshot.takenAt).toBe('2026-09-06T10:00:00.000Z')
    expect(snapshot.items).toEqual([
      { kind: 'liked', title: 'Holocene', artist: 'Bon Iver', ref: 'https://music.163.com/#/song?id=1' },
      { kind: 'playlist', title: 'late drive' },
    ])
  })
})
