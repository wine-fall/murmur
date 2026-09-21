// The QQ Music client (spec 14 §2.10): one POST endpoint, musicu.fcg, carrying
// the browser's cookie. Parsed from shapes captured against the live service
// on 2026-09-16 (values redacted) — the taste reads, and the search that
// feeds the pick (§2.4).
import { describe, expect, it } from 'vitest'

import { SourceAuthError } from '../src/music/sources/auth.ts'
import { credentialFrom, mountQQMusic, mountQQMusicQr, QQMusicClient, type QQMusicFetch, QQMusicSource } from '../src/music/sources/qqmusic.ts'

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

// One search answer, as the live service shapes it: hits arrive under
// body.song.list, and every hit carries pay.pay_play — 1 = VIP, which this
// account cannot play (§2.5). Rows captured against the live service
// 2026-09-16 for "What You Made Me", plus the VIP track §2.5's smoke uses.
const SEARCH = {
  code: 0,
  data: {
    body: {
      song: {
        list: [
          { mid: '000P8peU0HhORi', name: 'Hua', interval: 168, singer: [{ name: 'G.E.M.' }], album: { name: 'Hua (Live Piano Session)' }, pay: { pay_play: 1 } },
          { mid: '003s9sXr2So0QE', name: 'What You Made Me (feat. Aleesia)', interval: 235, singer: [{ name: 'Deoxik' }, { name: 'Aleesia' }], album: { name: 'What You Made Me' }, pay: { pay_play: 0 } },
          { mid: '002RbFdB0DoURh', name: 'What You Made Me', interval: 390, singer: [{ name: 'The Wreckage' }], album: { name: 'Vaudeville' }, pay: { pay_play: 0 } },
          { mid: '000hHsXz1OCVL9', name: '', interval: 223, singer: [{ name: 'Post Paradise' }], album: { name: '' }, pay: { pay_play: 0 } },
          { mid: '003Oe8qc0AGV2P', name: 'Call Out', interval: 172, singer: [], album: { name: '' }, pay: { pay_play: 0 } },
        ],
      },
    },
  },
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

// The search catalogue (spec 14 §2.4): the one thing that makes QQ Music
// playback reachable — without it the brain can name a QQ Music track but
// never hand submit_pick a y.qq.com ref.
describe('QQMusicClient.search', () => {
  const SEARCH_KEY = 'music.search.SearchCgiService.DoSearchForQQMusicDesktop'

  it('asks musicu.fcg for songs and maps the hits to candidates', async () => {
    const { client: c, calls } = client({ [SEARCH_KEY]: SEARCH })
    const found = await c.search('what you made me', 3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.req.param).toMatchObject({ query: 'what you made me', search_type: 0, page_num: 1, highlight: 0 })
    expect(found[0]).toEqual({
      ref: 'https://y.qq.com/n/ryqq/songDetail/003s9sXr2So0QE',
      title: 'What You Made Me (feat. Aleesia)',
      uploader: 'Deoxik / Aleesia',
      durationS: 235,
      extra: { album: 'What You Made Me' },
      catalogue: 'qqmusic',
    })
    expect(found[1]).toMatchObject({ ref: 'https://y.qq.com/n/ryqq/songDetail/002RbFdB0DoURh', uploader: 'The Wreckage' })
  })

  // A VIP hit is a candidate the radio cannot play (§2.5). The rights miss at
  // resolve time is the safety net, not the plan: dropping them here saves a
  // wasted extraction and a wasted turn of the model's attention.
  it('drops the VIP hits and the nameless ones', async () => {
    const { client: c } = client({ [SEARCH_KEY]: SEARCH })
    const found = await c.search('what you made me', 10)
    expect(found.map((f) => f.ref)).toEqual([
      'https://y.qq.com/n/ryqq/songDetail/003s9sXr2So0QE',
      'https://y.qq.com/n/ryqq/songDetail/002RbFdB0DoURh',
      'https://y.qq.com/n/ryqq/songDetail/003Oe8qc0AGV2P',
    ])
    // A hit with no singer at all still travels; the brain judges it.
    expect(found[2]).toMatchObject({ uploader: '' })
  })

  // About two thirds of a real result page is VIP, so asking for exactly the
  // limit would hand the brain one or two candidates to choose between.
  it('over-asks so the playable remainder still fills the limit, and caps at it', async () => {
    const { client: c, calls } = client({ [SEARCH_KEY]: SEARCH })
    const found = await c.search('what you made me', 2)
    expect(Number(calls[0]!.body.req.param.num_per_page)).toBeGreaterThan(2)
    expect(found).toHaveLength(2)
  })

  // The service answers an unsigned search `code: 0` with an EMPTY list — a
  // silent nothing that reads exactly like "no such song". A mount that
  // carries no credential must say so instead (§2.6).
  it('refuses a search with no login rather than returning a silent nothing', async () => {
    const { client: c, calls } = client({ [SEARCH_KEY]: SEARCH }, 'fqm_pvqid=<redacted>')
    await expect(c.search('what you made me', 3)).rejects.toMatchObject({ source: 'qqmusic', reason: 'login-required' })
    expect(calls).toEqual([])
  })

  it('reads an empty result page as no candidates, not as a failure', async () => {
    const { client: c } = client({ [SEARCH_KEY]: { code: 0, data: { body: { song: { list: [] } } } } })
    expect(await c.search('nothing at all', 5)).toEqual([])
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

  // A garbled body is a bug at the far end, not a lost login: routed as one,
  // SourceAuthWatch flips the mount to expired and the refresher stops
  // re-reading it, so one bad response would demand a fresh sign-in
  // (codex review).
  it('an account body that does not fit the shape is a plain error, never "expired"', async () => {
    const { client: c } = client({ ...ALL, 'music.UserInfo.userInfoServer.GetLoginUserInfo': { code: 0, data: { info: { nick: 42 } } } })
    await expect(c.account()).rejects.not.toBeInstanceOf(SourceAuthError)
    const { client: blank } = client({ ...ALL, 'music.UserInfo.userInfoServer.GetLoginUserInfo': { code: 0, data: { info: { nick: '  ' } } } })
    await expect(blank.account()).rejects.not.toBeInstanceOf(SourceAuthError)
  })

  // The timeout has to cover the BODY: fetch resolves on the headers, so a
  // response that stalls mid-body would hang the foreground mount and leave
  // the background refresh unable to finish (codex review). And rejecting is
  // not enough — the request itself must be ABORTED, or every stalled read
  // leaks its connection while the scan loop keeps polling (codex review).
  it('times out a response whose body never arrives, and aborts the request with it', async () => {
    const signals: AbortSignal[] = []
    const stalled: QQMusicFetch = async (_url, init) => {
      if (init?.signal != null) signals.push(init.signal)
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          },
        }),
      )
    }
    const c = new QQMusicClient({ cookie: async () => COOKIE, fetch: stalled, timeoutMs: 20 })
    await expect(c.account()).rejects.toThrow()
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
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

// The WeChat scan road (spec 14 §2.10): shapes captured from a real scan on
// 2026-09-16 against the live endpoints, values redacted.
describe('the WeChat scan', () => {
  const PAGE = '<html>…<img class="qrcode lightBorder" src="/connect/qrcode/041Fea9a2Wq1ll2U">…uuid=041Fea9a2Wq1ll2U"…</html>'
  const body = (errcode: number, code = ''): string => `window.wx_errcode=${errcode};window.wx_code='${code}';`

  // The exchange's answer, as the live service spells it: ~36 keys, of which
  // five matter. `musicid` is the trap — see the test below.
  const LOGIN = {
    code: 0,
    data: {
      errMsg: 'OK',
      musicid: 1152921504873944000,
      str_musicid: '1152921504873943987',
      musickey: '<redacted-key>',
      encryptUin: '<redacted-euin>',
      // Blank on the live service — the name comes from the credential's own
      // first read, not from the exchange (see the mount tests below).
      nick: '',
      openid: '<redacted-openid>',
      refresh_token: '<redacted-refresh>',
      refresh_key: '',
      expired_at: 1789550390,
    },
  }

  // A fetch that answers each of the three hosts the scan talks to.
  function scanFetch(over: { poll?: string[]; login?: unknown; reads?: Record<string, unknown> } = {}): { fetch: QQMusicFetch; urls: string[] } {
    const urls: string[] = []
    const polls = [...(over.poll ?? [body(405, '<redacted-wx-code>')])]
    const fetch: QQMusicFetch = async (url: string, init?: RequestInit) => {
      urls.push(String(url))
      if (String(url).includes('/connect/qrconnect')) return new Response(PAGE)
      if (String(url).includes('/connect/l/qrconnect')) return new Response(polls.length > 1 ? polls.shift()! : polls[0]!)
      const posted = JSON.parse(String(init?.body ?? '{}')) as { req?: { module?: string; method?: string } }
      const which = `${posted.req?.module}.${posted.req?.method}`
      if (which === 'music.login.LoginServer.Login') return new Response(JSON.stringify({ code: 0, req: over.login ?? LOGIN }))
      const reads: Record<string, unknown> = { ...ALL, ...over.reads }
      return new Response(JSON.stringify({ code: 0, req: reads[which] ?? { code: 2000, data: {} } }))
    }
    return { fetch, urls }
  }

  it('issues a code whose URL is the confirm page the QR image encodes', async () => {
    const { fetch, urls } = scanFetch()
    const issued = await new QQMusicClient({ cookie: async () => '', fetch }).wxQrCode()
    // Decoded from the real image with CoreImage — murmur draws this string
    // itself rather than showing the JPEG the platform serves.
    expect(issued).toEqual({ uuid: '041Fea9a2Wq1ll2U', url: 'https://open.weixin.qq.com/connect/confirm?uuid=041Fea9a2Wq1ll2U' })
    expect(urls[0]).toContain('appid=wx48db31d50e334801')
    expect(urls[0]).toContain('scope=snsapi_login')
  })

  it('reads the poll codes: 408 waiting, 404 scanned, 405 confirmed with the code', async () => {
    const poll = async (answer: string) => {
      const { fetch } = scanFetch({ poll: [answer] })
      return new QQMusicClient({ cookie: async () => '', fetch }).wxQrPoll('u')
    }
    expect(await poll(body(408))).toEqual({ status: 'waiting' })
    expect(await poll(body(404))).toEqual({ status: 'scanned' })
    expect(await poll(body(405, '<redacted-wx-code>'))).toEqual({ status: 'confirmed', value: '<redacted-wx-code>' })
    // 402 / 403 were never reached in the capture, so they are not claimed:
    // an unknown code reads as waiting and the loop's deadline ends it.
    expect(await poll(body(402))).toEqual({ status: 'waiting' })
    // A confirmation with no code is not a sign-in.
    expect(await poll(body(405))).toEqual({ status: 'waiting' })
  })

  // A rate limit is not a quiet wait: swallowed as one, the loop would keep
  // hammering a service that just said to stop, for three minutes, and then
  // tell the listener the code expired (codex review).
  it('a rate-limited poll is the typed failure, not another silent wait', async () => {
    const limited: QQMusicFetch = async () => new Response('', { status: 429 })
    await expect(new QQMusicClient({ cookie: async () => '', fetch: limited }).wxQrPoll('u')).rejects.toMatchObject({
      source: 'qqmusic',
      reason: 'rate-limited',
    })
  })

  it('a poll the service answers with a server error is raised, not read as waiting', async () => {
    const broken: QQMusicFetch = async () => new Response('', { status: 503 })
    await expect(new QQMusicClient({ cookie: async () => '', fetch: broken }).wxQrPoll('u')).rejects.toThrow(/503/)
  })

  it('a long poll that times out reads as waiting, so an Esc is not held for it', async () => {
    const stalled: QQMusicFetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          },
        }),
      )
    expect(await new QQMusicClient({ cookie: async () => '', fetch: stalled, timeoutMs: 20 }).wxQrPoll('u')).toEqual({ status: 'waiting' })
  })

  // The account number is 19 digits; JSON.parse rounds it through a double,
  // so `musicid` comes back as ...944000 for a real uin of ...943987. Reads
  // addressed with that number target an account that does not exist.
  it('takes the account number from str_musicid, never from the rounded musicid', async () => {
    const { fetch } = scanFetch()
    const signedIn = await new QQMusicClient({ cookie: async () => '', fetch }).wxLogin('<redacted-wx-code>')
    const jar = credentialFrom(signedIn.cookie)
    expect(jar).toEqual({ uin: '1152921504873943987', euin: '<redacted-euin>', key: '<redacted-key>' })
    expect(signedIn.cookie).not.toContain('1152921504873944000')
  })

  it('the exchange fails as a login failure, not a plain error, when the code is spent', async () => {
    const { fetch } = scanFetch({ login: { code: 1000, data: {} } })
    await expect(new QQMusicClient({ cookie: async () => '', fetch }).wxLogin('spent')).rejects.toMatchObject({ source: 'qqmusic', reason: 'login-required' })
  })

  it('mounts the scanned account into the credential-bearing arm, and nothing else', async () => {
    const { fetch } = scanFetch()
    const shown: string[] = []
    const result = await mountQQMusicQr({ fetch }, { show: (url) => shown.push(url), sleep: async () => {} })
    // The exchange's own `nick` is blank on the live service, so the name
    // comes from reading the account with the credential just minted — which
    // also proves that credential signs in before anything is mounted.
    expect(result).toMatchObject({ ok: true, who: 'Wine' })
    expect(shown).toEqual(['https://open.weixin.qq.com/connect/confirm?uuid=041Fea9a2Wq1ll2U'])
    const entry = (result as { entry: { auth: string; cookie: string } }).entry
    expect(entry.auth).toBe('qr')
    // The whole entry is the credential: no browser, no profile to read.
    expect(Object.keys(entry).sort()).toEqual(['auth', 'cookie'])
    expect(credentialFrom(entry.cookie)?.uin).toBe('1152921504873943987')
  })

  it('a scanned mount reads the same lists as a browser one, through the same client', async () => {
    const { fetch } = scanFetch()
    const mounted = await mountQQMusicQr({ fetch }, { show: () => {}, sleep: async () => {} })
    const cookie = (mounted as { entry: { cookie: string } }).entry.cookie
    const source = new QQMusicSource({ cookie: async () => cookie, fetch: fakeFetch(ALL).fetch, now: () => new Date('2026-09-16T10:00:00Z') })
    const snapshot = await source.snapshot()
    expect(snapshot.items.filter((i) => i.kind === 'liked').map((i) => i.title)).toEqual(['Hua', 'What You Made Me'])
  })

  it('a minted credential that does not sign in is refused, not mounted blank', async () => {
    const { fetch } = scanFetch({ reads: { 'music.UserInfo.userInfoServer.GetLoginUserInfo': { code: 1000, data: {} } } })
    expect(await mountQQMusicQr({ fetch }, { show: () => {}, sleep: async () => {} })).toEqual({ ok: false, reason: 'login-required' })
  })

  it('a listener who never scans gets a timeout, and nothing is mounted', async () => {
    const { fetch } = scanFetch({ poll: [body(408)] })
    expect(await mountQQMusicQr({ fetch }, { show: () => {}, sleep: async () => {}, timeoutMs: 0 })).toEqual({ ok: false, reason: 'timeout' })
  })
})

// spec 14 §3.10 step 4: QQ's radar, the second feed of the daily lane. It
// gives no reason string of its own — the lane simply lists what it sends.
describe('QQMusicClient.radar', () => {
  const answer = {
    code: 0,
    data: {
      VecSongs: [
        { Track: { mid: 'aaa', name: 'World Goes Round', singer: [{ name: 'Slow Marina' }] } },
        { Track: { mid: 'bbb', name: 'Second One', singer: [{ name: 'Umber Radio' }], pay: { pay_play: 1 } } },
        { Track: { mid: 'ccc', name: '  ', singer: [] } },
      ],
    },
  }

  it('reads the radar and drops what this account cannot play', async () => {
    const { fetch, calls } = fakeFetch({ 'music.recommend.TrackRelationServer.GetRadarSong': answer })
    const songs = await new QQMusicClient({ cookie: async () => COOKIE, fetch }).radar(10)
    expect(songs).toEqual([
      { ref: 'https://y.qq.com/n/ryqq/songDetail/aaa', title: 'World Goes Round', artist: 'Slow Marina' },
    ])
    expect(calls[0]!.body.req.method).toBe('GetRadarSong')
  })

  it('needs the account, like every other read here', async () => {
    const { fetch } = fakeFetch({})
    await expect(new QQMusicClient({ cookie: async () => '', fetch }).radar(10)).rejects.toBeInstanceOf(SourceAuthError)
  })
})
