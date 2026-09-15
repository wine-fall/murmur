// The NetEase and Bilibili scan sign-ins (spec 14 §2.8): the two endpoints
// each platform exposes without a login, every status code they answer with,
// and what a confirmed scan leaves in the entry. Shapes are the live ones
// (probed 2026-09-15); cookie values are redacted.
import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { BilibiliClient, mountBilibili, mountBilibiliQr } from '../src/music/sources/bilibili.ts'
import { jarRowsFromHeader, setCookieHeader, writeJar } from '../src/music/sources/cookies.ts'
import { mountNetease, mountNeteaseQr, NeteaseClient, type NeteaseFetch } from '../src/music/sources/netease.ts'

type Call = { url: string; headers: Record<string, string> }

// A fetch that answers by path with a body and, optionally, Set-Cookie.
function fakeFetch(answers: Record<string, { body: unknown; setCookie?: string[] }>): { fetch: NeteaseFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: NeteaseFetch = async (url, init) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    const path = new URL(String(url)).pathname
    const hit = Object.entries(answers).find(([key]) => path.endsWith(key))
    if (hit === undefined) return new Response(JSON.stringify({ code: 404 }), { status: 404 })
    const headers = new Headers({ 'Content-Type': 'application/json' })
    for (const raw of hit[1].setCookie ?? []) headers.append('Set-Cookie', raw)
    return new Response(JSON.stringify(hit[1].body), { status: 200, headers })
  }
  return { fetch, calls }
}

const clock = (): { now: () => Date; sleep: (ms: number) => Promise<void> } => {
  let t = 0
  return { now: () => new Date(t), sleep: async (ms) => void (t += ms) }
}

describe('NetEase scan sign-in (spec 14 §2.8)', () => {
  it('asks for a key and draws the platform\'s own sign-in page for it, carrying no cookie', async () => {
    const { fetch, calls } = fakeFetch({ '/login/qrcode/unikey': { body: { code: 200, unikey: 'a-uni-key' } } })
    const client = new NeteaseClient({ cookie: async () => 'should-not-be-sent', fetch })
    expect(await client.qrKey()).toEqual({ key: 'a-uni-key', url: 'https://music.163.com/login?codekey=a-uni-key' })
    expect(calls[0]!.url).toBe('https://music.163.com/api/login/qrcode/unikey?type=1')
    expect(calls[0]!.headers.Cookie).toBeUndefined()
  })

  it('reads every status the poll answers with — 801 / 802 / 803 / 800 — and nothing else as confirmed', async () => {
    const poll = async (code: number, setCookie?: string[]) => {
      const { fetch } = fakeFetch({ '/login/qrcode/client/login': { body: { code, message: 'x' }, ...(setCookie && { setCookie }) } })
      return new NeteaseClient({ cookie: async () => '', fetch }).qrPoll('k')
    }
    expect(await poll(801)).toEqual({ status: 'waiting' })
    expect(await poll(802)).toEqual({ status: 'scanned' })
    expect(await poll(800)).toEqual({ status: 'expired' })
    expect(await poll(803, ['MUSIC_U=<redacted>; Path=/; HttpOnly', '__csrf=<redacted-csrf>; Path=/'])).toEqual({
      status: 'confirmed',
      value: 'MUSIC_U=<redacted>; __csrf=<redacted-csrf>',
    })
    // An answer murmur does not model waits rather than guessing; the scan
    // loop's own deadline is what ends it.
    expect(await poll(4242)).toEqual({ status: 'waiting' })
    // Confirmed with no cookie is not a sign-in: it keeps waiting rather
    // than mounting an account there is no credential for (codex review).
    expect(await poll(803)).toEqual({ status: 'waiting' })
  })

  it('mounts on a confirmed scan: the cookie is the entry, and no browser is named anywhere in it', async () => {
    let polls = 0
    const { fetch } = fakeFetch({
      '/login/qrcode/unikey': { body: { code: 200, unikey: 'k' } },
      '/login/qrcode/client/login': { body: { code: 803 }, setCookie: ['MUSIC_U=<redacted>; Path=/'] },
      '/nuser/account/get': { body: { code: 200, profile: { userId: 42, nickname: 'Chen X' } } },
      '/user/playlist': { body: { code: 200, playlist: [{ id: 7, name: 'my likes', specialType: 5, trackCount: 3 }] } },
    })
    const shown: string[] = []
    const result = await mountNeteaseQr(
      { fetch: (url, init) => (String(url).includes('client/login') ? (polls++, fetch(url, init)) : fetch(url, init)) },
      { show: (url) => shown.push(url), ...clock() },
    )
    expect(shown).toEqual(['https://music.163.com/login?codekey=k'])
    expect(polls).toBe(1)
    expect(result).toEqual({
      ok: true,
      who: 'Chen X',
      entry: { auth: 'qr', cookie: 'MUSIC_U=<redacted>', userId: '42', likedPlaylistId: '7' },
    })
    expect(JSON.stringify(result)).not.toContain('browser')
  })

  it('a scan the platform never confirms ends as a timeout, and a cookie that signs in to nothing as login-required', async () => {
    const expired = fakeFetch({
      '/login/qrcode/unikey': { body: { code: 200, unikey: 'k' } },
      '/login/qrcode/client/login': { body: { code: 800 } },
    })
    expect(await mountNeteaseQr({ fetch: expired.fetch }, { show: () => {}, ...clock() })).toEqual({ ok: false, reason: 'timeout' })

    const anonymous = fakeFetch({
      '/login/qrcode/unikey': { body: { code: 200, unikey: 'k' } },
      '/login/qrcode/client/login': { body: { code: 803 }, setCookie: ['NMTID=<redacted>; Path=/'] },
      '/nuser/account/get': { body: { code: 200, profile: null } },
    })
    expect(await mountNeteaseQr({ fetch: anonymous.fetch }, { show: () => {}, ...clock() })).toEqual({ ok: false, reason: 'login-required' })
  })
})

describe('Bilibili scan sign-in (spec 14 §2.8)', () => {
  it('takes the URL to draw from the platform, along with the key to poll', async () => {
    const { fetch, calls } = fakeFetch({
      '/qrcode/generate': { body: { code: 0, message: 'OK', data: { url: 'https://account.bilibili.com/h5/scan?qrcode_key=abc', qrcode_key: 'abc' } } },
    })
    const client = new BilibiliClient({ cookie: async () => 'should-not-be-sent', fetch })
    expect(await client.qrKey()).toEqual({ key: 'abc', url: 'https://account.bilibili.com/h5/scan?qrcode_key=abc' })
    expect(calls[0]!.url).toBe('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
    expect(calls[0]!.headers.Cookie).toBeUndefined()
  })

  it('reads the code inside the envelope — 86101 / 86090 / 0 / 86038 — not the envelope, which is 0 throughout', async () => {
    const poll = async (code: number, setCookie?: string[]) => {
      const { fetch } = fakeFetch({ '/qrcode/poll': { body: { code: 0, message: 'OK', data: { url: '', code, message: 'x' } }, ...(setCookie && { setCookie }) } })
      return new BilibiliClient({ cookie: async () => '', fetch }).qrPoll('k')
    }
    expect(await poll(86101)).toEqual({ status: 'waiting' })
    expect(await poll(86090)).toEqual({ status: 'scanned' })
    expect(await poll(86038)).toEqual({ status: 'expired' })
    expect(await poll(0, ['SESSDATA=<redacted>; Path=/; HttpOnly', 'bili_jct=<redacted-jct>; Path=/', 'DedeUserID=42; Path=/'])).toEqual({
      status: 'confirmed',
      value: 'SESSDATA=<redacted>; bili_jct=<redacted-jct>; DedeUserID=42',
    })
    expect(await poll(99999)).toEqual({ status: 'waiting' })
    expect(await poll(0)).toEqual({ status: 'waiting' })
  })

  it('mounts on a confirmed scan, keeping the cookie and the account it names', async () => {
    const { fetch } = fakeFetch({
      '/qrcode/generate': { body: { code: 0, data: { url: 'https://scan.me', qrcode_key: 'k' } } },
      '/qrcode/poll': { body: { code: 0, data: { code: 0 } }, setCookie: ['SESSDATA=<redacted>; Path=/'] },
      '/x/web-interface/nav': { body: { code: 0, data: { isLogin: true, uname: 'Zach G', mid: 42 } } },
    })
    expect(await mountBilibiliQr({ fetch }, { show: () => {}, ...clock() })).toEqual({
      ok: true,
      who: 'Zach G',
      entry: { auth: 'qr', cookie: 'SESSDATA=<redacted>', mid: '42' },
    })
  })

  it('Esc stops it before anything is written', async () => {
    const { fetch } = fakeFetch({
      '/qrcode/generate': { body: { code: 0, data: { url: 'https://scan.me', qrcode_key: 'k' } } },
      '/qrcode/poll': { body: { code: 0, data: { code: 86101 } } },
    })
    expect(await mountBilibiliQr({ fetch }, { show: () => {}, cancelled: () => true, ...clock() })).toEqual({ ok: false, reason: 'cancelled' })
  })
})

describe('the cookie a scan hands back (spec 14 §2.5/§2.8)', () => {
  it('collects every Set-Cookie into the header a client sends back, last value per name', () => {
    const headers = new Headers()
    for (const raw of ['a=1; Path=/', 'b=2; Path=/; HttpOnly', 'a=3; Path=/', 'Expires=nonsense']) headers.append('Set-Cookie', raw)
    expect(setCookieHeader({ headers })).toBe('a=3; b=2; Expires=nonsense')
  })

  it('writes the stored header as a jar yt-dlp can load, and the lease deletes it', () => {
    const rows = jarRowsFromHeader('SESSDATA=<redacted>; bili_jct=<redacted-jct>', 'bilibili.com')
    expect(rows).toHaveLength(2)
    // Not secure-only: yt-dlp's NetEase extractor reads its eapi endpoints
    // over plain http, and a secure row would never be sent there — the
    // signed-in listener's track would resolve anonymously (codex review).
    expect(rows[0]!.line.split('\t')).toEqual(['.bilibili.com', 'TRUE', '/', 'FALSE', '2000000000', 'SESSDATA', '<redacted>'])
    expect(jarRowsFromHeader('MUSIC_U=x', 'music.163.com')[0]!.line.split('\t')[3]).toBe('FALSE')
    const lease = writeJar(rows)
    const text = readFileSync(lease.path, 'utf-8')
    expect(text.startsWith('# Netscape HTTP Cookie File\n')).toBe(true)
    expect(text).toContain('.bilibili.com\tTRUE\t/\tFALSE\t2000000000\tbili_jct\t<redacted-jct>')
    expect(lease.args).toEqual(['--cookies', lease.path])
    lease.release()
    expect(existsSync(lease.path)).toBe(false)
  })

  it('ignores anything in the header that is not a name=value pair', () => {
    expect(jarRowsFromHeader('  ; =nothing; SESSDATA=x ;', 'bilibili.com').map((r) => r.name)).toEqual(['SESSDATA'])
  })
})

// The browser road back (spec 14 §3.1, revised 2026-09-15). #242 made the
// scan the ONLY way into these two; the sign-in card offers both again, so
// the cookie mounts they had before are here again — writing `auth:
// 'browser'` this time, which the store's Borrowed arm has always read.
describe('the browser mount for NetEase and Bilibili (spec 14 §3.1)', () => {
  it('mounts NetEase from a browser cookie, naming the browser and the profile it was read from', async () => {
    const { fetch } = fakeFetch({
      '/nuser/account/get': { body: { code: 200, profile: { userId: 42, nickname: 'Chen X' } } },
      '/user/playlist': { body: { code: 200, playlist: [{ id: 7, name: 'my likes', specialType: 5, userId: 42 }] } },
    })
    const result = await mountNetease({ browser: 'chrome', profile: 'Profile 3' }, { fetch, cookie: async () => 'MUSIC_U=x' })
    expect(result).toEqual({
      ok: true,
      who: 'Chen X',
      entry: { auth: 'browser', browser: 'chrome', profile: 'Profile 3', userId: '42', likedPlaylistId: '7' },
    })
  })

  it('mounts Bilibili the same way', async () => {
    const { fetch } = fakeFetch({ '/x/web-interface/nav': { body: { code: 0, data: { isLogin: true, uname: 'Zach G', mid: 42 } } } })
    const result = await mountBilibili({ browser: 'chrome', profile: 'Default' }, { fetch, cookie: async () => 'SESSDATA=x' })
    expect(result).toEqual({ ok: true, who: 'Zach G', entry: { auth: 'browser', browser: 'chrome', profile: 'Default', mid: '42' } })
  })

  it('never carries a cookie into the entry: a browser mount borrows one per read, it does not keep it', async () => {
    const { fetch } = fakeFetch({ '/x/web-interface/nav': { body: { code: 0, data: { isLogin: true, uname: 'Zach G', mid: 42 } } } })
    const result = await mountBilibili({ browser: 'chrome', profile: 'Default' }, { fetch, cookie: async () => 'SESSDATA=secret' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('a cookie that signs in to nobody is login-required, never an exception', async () => {
    const { fetch } = fakeFetch({ '/nuser/account/get': { body: { code: 200, profile: null } } })
    expect(await mountNetease({ browser: 'chrome' }, { fetch, cookie: async () => '' })).toEqual({ ok: false, reason: 'login-required' })
    const bili = fakeFetch({ '/x/web-interface/nav': { body: { code: 0, data: { isLogin: false } } } })
    expect(await mountBilibili({ browser: 'chrome' }, { fetch: bili.fetch, cookie: async () => '' })).toEqual({ ok: false, reason: 'login-required' })
  })

  it('leaves the profile off the entry when the pick carries none — an older file shape stays reachable', async () => {
    const { fetch } = fakeFetch({ '/x/web-interface/nav': { body: { code: 0, data: { isLogin: true, uname: 'Zach G', mid: 42 } } } })
    expect(await mountBilibili({ browser: 'firefox' }, { fetch, cookie: async () => 'x' })).toMatchObject({ entry: { browser: 'firefox' } })
    expect((await mountBilibili({ browser: 'firefox' }, { fetch, cookie: async () => 'x' })) as { entry: object }).not.toHaveProperty('entry.profile')
  })
})
