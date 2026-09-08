// The NetEase client (spec 14 §2.8): four plaintext GET reads on
// music.163.com, parsed from captured shapes (values redacted).
import { describe, expect, it } from 'vitest'

import { SourceAuthError } from '../src/music/sources/auth.ts'
import { mountNetease, NeteaseClient, NeteaseSource, type NeteaseFetch } from '../src/music/sources/netease.ts'

type Call = { url: string; body: string; headers: Record<string, string>; method: string }

// A fetch that answers by path, recording what was sent.
function fakeFetch(answers: Record<string, unknown>, status = 200): { fetch: NeteaseFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: NeteaseFetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), body: String(init?.body ?? ''), headers, method: init?.method ?? 'GET' })
    const path = new URL(String(url)).pathname
    const hit = Object.entries(answers).find(([key]) => path.endsWith(key))
    return new Response(JSON.stringify(hit === undefined ? { code: 404 } : hit[1]), { status })
  }
  return { fetch, calls }
}

const COOKIE = 'MUSIC_U=<redacted-u>; __csrf=<redacted-csrf>; NMTID=<redacted>'

describe('NeteaseClient', () => {
  it('reads the account over a plaintext GET, the browser cookie passed through as it stands', async () => {
    const { fetch, calls } = fakeFetch({ '/nuser/account/get': { code: 200, profile: { userId: 42, nickname: 'Chen X' } } })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    expect(await client.account()).toEqual({ userId: '42', who: 'Chen X' })
    expect(calls[0]!.url).toBe('https://music.163.com/api/nuser/account/get')
    expect(calls[0]!.method).toBe('GET')
    // No ciphered body: nothing is signed, nothing is posted.
    expect(calls[0]!.body).toBe('')
    expect(calls[0]!.headers.Cookie).toBe(COOKIE)
    expect(calls[0]!.headers.Referer).toBe('https://music.163.com/')
  })

  it('an anonymous cookie reads as no account, and sends no Cookie header at all', async () => {
    const { fetch, calls } = fakeFetch({ '/nuser/account/get': { code: 200, account: null, profile: null } })
    expect(await new NeteaseClient({ cookie: async () => '', fetch }).account()).toBeNull()
    expect(calls[0]!.headers.Cookie).toBeUndefined()
  })

  it('lists playlists, and reads one playlist into liked items with the kept-at date, in one call', async () => {
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
        playlist: {
          trackIds: [{ id: 1, at: 1757116800000 }, { id: 2, at: 1757030400000 }, { id: 3 }],
          tracks: [
            { id: 1, name: 'Travel Is Meaningful', ar: [{ name: 'Cheer Chen' }], al: { name: 'Groupies' }, dt: 240000 },
            { id: 2, name: 'Holocene', ar: [{ name: 'Bon Iver' }, { name: 'Someone' }], al: { name: 'Bon Iver' }, dt: 344000 },
            { id: 3, name: '', ar: [], dt: 0 },
          ],
        },
      },
    })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    const playlists = await client.playlists('42')
    expect(playlists).toEqual([
      { id: '7', name: 'Liked', trackCount: 3, liked: true, mine: true },
      { id: '8', name: 'late drive', trackCount: 12, liked: false, mine: true },
      { id: '9', name: 'someone else', trackCount: 40, liked: false, mine: false },
    ])
    expect(calls[0]!.url).toBe('https://music.163.com/api/user/playlist?uid=42&limit=50&offset=0')
    const items = await client.playlistTracks('7', 500)
    expect(items).toEqual([
      { kind: 'liked', title: 'Travel Is Meaningful', artist: 'Cheer Chen', album: 'Groupies', at: '2025-09-06T00:00:00.000Z', ref: 'https://music.163.com/#/song?id=1' },
      { kind: 'liked', title: 'Holocene', artist: 'Bon Iver / Someone', album: 'Bon Iver', at: '2025-09-05T00:00:00.000Z', ref: 'https://music.163.com/#/song?id=2' },
    ])
    // The detail read carries the whole list: one round trip, no id-batched follow-up.
    expect(calls[1]!.url).toBe('https://music.163.com/api/v6/playlist/detail?id=7&n=500&s=0')
    expect(calls).toHaveLength(2)
  })

  it('caps the liked read at the bound and never walks the rest', async () => {
    const trackIds = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1 }))
    const tracks = trackIds.map((t) => ({ id: t.id, name: `song ${t.id}`, ar: [{ name: 'a' }], dt: 1000 }))
    const { fetch, calls } = fakeFetch({ '/v6/playlist/detail': { code: 200, playlist: { trackIds, tracks } } })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    expect(await client.playlistTracks('7', 500)).toHaveLength(500)
    expect(calls).toHaveLength(1)
  })

  it('searches the catalogue into candidates, reading the web spelling of a song', async () => {
    const { fetch, calls } = fakeFetch({
      '/search/get': {
        code: 200,
        result: { songs: [{ id: 5, name: 'Groupies', artists: [{ name: 'Cheer Chen' }], album: { name: 'Groupies' }, duration: 215000 }], songCount: 1 },
      },
    })
    const client = new NeteaseClient({ cookie: async () => COOKIE, fetch })
    expect(await client.search('cheer chen groupies', 5)).toEqual([
      { ref: 'https://music.163.com/#/song?id=5', title: 'Groupies', uploader: 'Cheer Chen', durationS: 215, extra: { album: 'Groupies' }, catalogue: 'netease' },
    ])
    expect(calls[0]!.url).toBe('https://music.163.com/api/search/get?s=cheer+chen+groupies&type=1&offset=0&limit=5')
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
    '/v6/playlist/detail': {
      code: 200,
      playlist: { trackIds: [{ id: 1 }], tracks: [{ id: 1, name: 'Holocene', ar: [{ name: 'Bon Iver' }], dt: 344000 }] },
    },
  }

  it('mounting finds the account and the liked playlist; a browser with no login says so', async () => {
    const jar = { calls: 0, cookie: async () => (jar.calls++, COOKIE) }
    const mounted = await mountNetease({ browser: 'chrome' }, { cookie: jar.cookie, fetch: fakeFetch(answers).fetch })
    expect(mounted).toEqual({ ok: true, who: 'Chen X', entry: { browser: 'chrome', userId: '42', likedPlaylistId: '7' } })
    const anon = await mountNetease({ browser: 'firefox', profile: 'p' }, { cookie: async () => '', fetch: fakeFetch({ '/nuser/account/get': { code: 200 } }).fetch })
    expect(anon).toEqual({ ok: false, reason: 'login-required' })
  })

  it('a snapshot on a cookie that no longer signs in is the typed failure, not an anonymous read', async () => {
    // The playlist endpoints serve a public list without a login; a refresh
    // that "worked" anonymously would report an expired mount as fine.
    const source = new NeteaseSource(
      { browser: 'chrome', userId: '42', likedPlaylistId: '7' },
      { cookie: async () => '', fetch: fakeFetch({ ...answers, '/nuser/account/get': { code: 200, profile: null } }).fetch },
    )
    await expect(source.snapshot()).rejects.toMatchObject({ source: 'netease', reason: 'login-required' })
  })

  it('drops an id the detail read left untitled rather than chasing it', async () => {
    const withGap = {
      ...answers,
      '/v6/playlist/detail': {
        code: 200,
        playlist: {
          trackIds: [{ id: 1, at: 1757116800000 }, { id: 2 }],
          tracks: [{ id: 1, name: 'Holocene', ar: [{ name: 'Bon Iver' }], dt: 344000 }],
        },
      },
    }
    const { fetch, calls } = fakeFetch(withGap)
    const items = await new NeteaseClient({ cookie: async () => COOKIE, fetch }).playlistTracks('7', 500)
    expect(items.map((i) => i.title)).toEqual(['Holocene'])
    expect(items[0]!.at).toBe('2025-09-06T00:00:00.000Z')
    expect(calls).toHaveLength(1)
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
