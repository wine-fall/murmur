// The QQ Music client (spec 14 §2.9): one POST endpoint, musicu.fcg, carrying
// the browser's cookie. Parsed from shapes captured against the live service
// on 2026-09-16 (values redacted). Taste only — QQ Music is never played.
import { describe, expect, it } from 'vitest'

import { SourceAuthError } from '../src/music/sources/auth.ts'
import { credentialFrom, mountQQMusic, QQMusicClient, type QQMusicFetch, QQMusicSource } from '../src/music/sources/qqmusic.ts'

type Call = { url: string; body: { comm: Record<string, unknown>; req: { module: string; method: string; param: Record<string, unknown> } }; headers: Record<string, string> }

// One musicu.fcg answer, keyed by "<module>.<method>" — the real service
// dispatches on the body, not the path, and so does this.
function fakeFetch(answers: Record<string, unknown>, status = 200): { fetch: QQMusicFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: QQMusicFetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Call['body']
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> })
    const key = `${body.req?.module}.${body.req?.method}`
    const hit = answers[key]
    // The envelope is always 200/code 0; the inner req carries the real code.
    return new Response(JSON.stringify({ code: 0, req: hit ?? { code: 2000, data: {} } }), { status })
  }
  return { fetch, calls }
}

// A WeChat-signed-in jar, as yt-dlp exports it: the key appears twice (once
// for .qq.com, once for .y.qq.com) because both rows carry it.
const COOKIE = 'euin=<redacted-euin>; qm_keyst=<redacted-key>; qqmusic_key=<redacted-key>; tmeLoginType=1; wxuin=1152921504873943987; qm_keyst=<redacted-key>'

const WHO = { code: 0, data: { errMsg: 'OK', info: { nick: 'Wine' } } }
const LISTS = {
  code: 0,
  data: {
    total: 2,
    v_playlist: [
      { dirId: 201, dirName: 'my favourites', tid: 5489082138, songNum: 2 },
      { dirId: 3, dirName: 'late drive', tid: 7011264340, songNum: 12 },
    ],
    bFinish: true,
  },
}
const LIKED = {
  code: 0,
  data: {
    total_song_num: 2,
    dirinfo: { id: 5489082138, dirid: 201, songnum: 2 },
    songlist: [
      { id: 106359731, mid: '000P8peU0HhORi', name: 'Hua', title: 'Hua (Live Piano Session)', interval: 168, singer: [{ name: 'G.E.M.' }], album: { name: 'Hua (Live Piano Session)' } },
      { id: 5, mid: '003s9sXr2So0QE', name: 'What You Made Me', title: 'What You Made Me', interval: 235, singer: [{ name: 'Deoxik' }, { name: 'Aleesia' }], album: { name: 'What You Made Me' } },
    ],
  },
}
const FAVS = {
  code: 0,
  data: { number: 2, hasmore: 0, v_list: [{ tid: 5268900319, name: 'bass-heavy female vocals', songnum: 167 }, { tid: 5295126258, name: 'late electronica', songnum: 230 }] },
}
const ALL = {
  'music.UserInfo.userInfoServer.GetLoginUserInfo': WHO,
  'music.musicasset.PlaylistBaseRead.GetPlaylistByUin': LISTS,
  'music.srfDissInfo.DissInfo.CgiGetDiss': LIKED,
  'music.musicasset.PlaylistFavRead.CgiGetPlaylistFavInfo': FAVS,
}

const client = (answers: Record<string, unknown>, cookie = COOKIE, status = 200) => {
  const { fetch, calls } = fakeFetch(answers, status)
  return { client: new QQMusicClient({ cookie: async () => cookie, fetch }), calls }
}

describe('credentialFrom', () => {
  it('reads the uin, the encrypted uin and the key out of the browser cookie', () => {
    expect(credentialFrom(COOKIE)).toEqual({ uin: '1152921504873943987', euin: '<redacted-euin>', key: '<redacted-key>' })
  })

  it('takes a QQ sign-in\'s plain uin over the WeChat one, and tolerates either alone', () => {
    expect(credentialFrom('uin=12345; qm_keyst=k; euin=e')?.uin).toBe('12345')
    expect(credentialFrom('wxuin=999; qm_keyst=k; euin=e')?.uin).toBe('999')
  })

  it('is null when the jar carries no key or no uin — there is no login there', () => {
    expect(credentialFrom('wxuin=999; euin=e')).toBeNull()
    expect(credentialFrom('qm_keyst=k; euin=e')).toBeNull()
    expect(credentialFrom('')).toBeNull()
  })
})

describe('QQMusicClient', () => {
  it('reads the account over one musicu.fcg POST, signing the comm block with the key', async () => {
    const { client: c, calls } = client(ALL)
    expect(await c.account()).toEqual({ uin: '1152921504873943987', euin: '<redacted-euin>', who: 'Wine' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg')
    expect(calls[0]!.headers.Cookie).toBe(COOKIE)
    expect(calls[0]!.headers.Referer).toBe('https://y.qq.com/')
    // g_tk is hash33(key, 5381) — the service rejects the read without it.
    expect(calls[0]!.body.comm).toMatchObject({ uin: '1152921504873943987', format: 'json', platform: 'yqq.json' })
    expect(calls[0]!.body.comm.g_tk).toBe(calls[0]!.body.comm.g_tk_new_20200303)
    expect(typeof calls[0]!.body.comm.g_tk).toBe('number')
  })

  it('a jar with no login reads as no account, and costs no round trip at all', async () => {
    const { client: c, calls } = client(ALL, 'fqm_pvqid=<redacted>; pgv_pvid=<redacted>')
    expect(await c.account()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('a key that no longer signs in reads as no account rather than throwing', async () => {
    const { client: c } = client({ ...ALL, 'music.UserInfo.userInfoServer.GetLoginUserInfo': { code: 1000, data: {} } })
    expect(await c.account()).toBeNull()
  })

  it('lists the created playlists, marking the fixed liked dir as the liked one', async () => {
    const { client: c, calls } = client(ALL)
    expect(await c.playlists('1152921504873943987')).toEqual([
      { id: '5489082138', name: 'my favourites', songCount: 2, liked: true },
      { id: '7011264340', name: 'late drive', songCount: 12, liked: false },
    ])
    expect(calls[0]!.body.req.param).toEqual({ uin: '1152921504873943987' })
  })

  it('reads the liked list into liked items in one call, capped at the bound', async () => {
    const { client: c, calls } = client(ALL)
    expect(await c.likedSongs('<redacted-euin>', 500)).toEqual([
      { kind: 'liked', title: 'Hua', artist: 'G.E.M.', album: 'Hua (Live Piano Session)', ref: 'https://y.qq.com/n/ryqq/songDetail/000P8peU0HhORi' },
      { kind: 'liked', title: 'What You Made Me', artist: 'Deoxik / Aleesia', album: 'What You Made Me', ref: 'https://y.qq.com/n/ryqq/songDetail/003s9sXr2So0QE' },
    ])
    // One round trip: song_num at the bound returns the whole list (verified
    // against a 167-song list on 2026-09-16), so nothing is paged.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.req.param).toMatchObject({ dirid: 201, song_begin: 0, song_num: 500, enc_host_uin: '<redacted-euin>' })
  })

  it('caps the liked read at the bound and never walks the rest', async () => {
    const songlist = Array.from({ length: 900 }, (_, i) => ({ id: i + 1, mid: `m${i}`, name: `song ${i}`, interval: 100, singer: [{ name: 'a' }] }))
    const { client: c, calls } = client({ 'music.srfDissInfo.DissInfo.CgiGetDiss': { code: 0, data: { songlist, total_song_num: 900 } } })
    expect(await c.likedSongs('e', 500)).toHaveLength(500)
    expect(calls).toHaveLength(1)
  })

  it('drops a song the service returned untitled rather than sending an empty title on', async () => {
    const { client: c } = client({
      'music.srfDissInfo.DissInfo.CgiGetDiss': { code: 0, data: { songlist: [{ id: 1, mid: 'm1', name: '  ', interval: 10, singer: [] }, ...LIKED.data.songlist] } },
    })
    expect((await c.likedSongs('e', 500)).map((i) => i.title)).toEqual(['Hua', 'What You Made Me'])
  })

  it('reads the favourited playlist names, within the playlist bound', async () => {
    const { client: c, calls } = client(ALL)
    expect(await c.favouritePlaylists('<redacted-euin>')).toEqual(['bass-heavy female vocals', 'late electronica'])
    expect(calls[0]!.body.req.param).toEqual({ uin: '<redacted-euin>', offset: 0, size: 50 })
  })

  it('turns the login codes, the rate-limit code and a 429 into typed failures', async () => {
    for (const code of [1000, 104401, 104400]) {
      const { client: c } = client({ 'music.musicasset.PlaylistBaseRead.GetPlaylistByUin': { code, data: {} } })
      await expect(c.playlists('1')).rejects.toMatchObject({ source: 'qqmusic', reason: 'login-required' })
    }
    const { client: slow } = client({ 'music.musicasset.PlaylistBaseRead.GetPlaylistByUin': { code: 104604, data: {} } })
    await expect(slow.playlists('1')).rejects.toMatchObject({ source: 'qqmusic', reason: 'rate-limited' })
    const { client: busy } = client(ALL, COOKIE, 429)
    await expect(busy.playlists('1')).rejects.toBeInstanceOf(SourceAuthError)
  })

  it('a body that does not fit the shape is a plain error, never a login failure', async () => {
    const { client: c } = client({ 'music.musicasset.PlaylistBaseRead.GetPlaylistByUin': { code: 0, data: { v_playlist: 'not a list' } } })
    await expect(c.playlists('1')).rejects.not.toBeInstanceOf(SourceAuthError)
    await expect(c.playlists('1')).rejects.toThrow()
  })

  it('retries a network error once, never an auth answer', async () => {
    let n = 0
    const flaky: QQMusicFetch = async () => {
      n++
      if (n === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ code: 0, req: WHO }))
    }
    expect(await new QQMusicClient({ cookie: async () => COOKIE, fetch: flaky }).account()).toMatchObject({ who: 'Wine' })
    expect(n).toBe(2)
  })
})

describe('mountQQMusic', () => {
  it('mounts the account behind a Chrome profile, keeping the profile and never the cookie', async () => {
    const { fetch } = fakeFetch(ALL)
    const result = await mountQQMusic({ browser: 'chrome', profile: 'Default' }, { cookie: async () => COOKIE, fetch })
    expect(result).toEqual({ ok: true, who: 'Wine', entry: { auth: 'browser', browser: 'chrome', profile: 'Default' } })
    expect(JSON.stringify(result)).not.toContain('<redacted-key>')
  })

  it('a profile with no QQ Music login is the plain "sign in there first"', async () => {
    const { fetch } = fakeFetch(ALL)
    expect(await mountQQMusic({ browser: 'chrome', profile: 'Default' }, { cookie: async () => '', fetch })).toEqual({ ok: false, reason: 'login-required' })
  })
})

describe('QQMusicSource', () => {
  it('a snapshot on a cookie that no longer signs in is the typed failure, not an anonymous read', async () => {
    // Verified against the live service (2026-09-16): with the key flipped,
    // GetLoginUserInfo answers code 1000 but GetPlaylistByUin STILL returns
    // the account's lists — it authenticates on the uin alone. A snapshot
    // that skipped the login check would report an expired mount as fine.
    const { fetch } = fakeFetch({ ...ALL, 'music.UserInfo.userInfoServer.GetLoginUserInfo': { code: 1000, data: {} } })
    const source = new QQMusicSource({ cookie: async () => COOKIE, fetch })
    await expect(source.snapshot()).rejects.toMatchObject({ source: 'qqmusic', reason: 'login-required' })
  })

  it('snapshots the liked songs plus the created and favourited playlist names', async () => {
    const { fetch } = fakeFetch(ALL)
    const source = new QQMusicSource({ cookie: async () => COOKIE, fetch, now: () => new Date('2026-09-16T10:00:00Z') })
    expect(await source.verify()).toEqual({ ok: true, who: 'Wine' })
    const snapshot = await source.snapshot()
    expect(snapshot.source).toBe('qqmusic')
    expect(snapshot.takenAt).toBe('2026-09-16T10:00:00.000Z')
    expect(snapshot.items).toEqual([
      { kind: 'liked', title: 'Hua', artist: 'G.E.M.', album: 'Hua (Live Piano Session)', ref: 'https://y.qq.com/n/ryqq/songDetail/000P8peU0HhORi' },
      { kind: 'liked', title: 'What You Made Me', artist: 'Deoxik / Aleesia', album: 'What You Made Me', ref: 'https://y.qq.com/n/ryqq/songDetail/003s9sXr2So0QE' },
      // The liked dir is the body above; it never also appears as a name.
      { kind: 'playlist', title: 'late drive' },
      { kind: 'playlist', title: 'bass-heavy female vocals' },
      { kind: 'playlist', title: 'late electronica' },
    ])
  })

  it('verify reports the lost login rather than throwing', async () => {
    const { fetch } = fakeFetch({ ...ALL, 'music.UserInfo.userInfoServer.GetLoginUserInfo': { code: 1000, data: {} } })
    expect(await new QQMusicSource({ cookie: async () => COOKIE, fetch }).verify()).toEqual({ ok: false, reason: 'login-required' })
  })
})
