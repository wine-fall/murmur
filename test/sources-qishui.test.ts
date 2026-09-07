// Soda Music (spec 14 §2.8): the Douyin QR passport flow and the read-only
// account reads over the Luna PC transport. The QR shapes are captured from
// the real passport endpoint (2026-09-07, values redacted); the account
// shapes follow the reference implementation's field names and are the
// user's smoke to confirm (§5.7).
import { describe, expect, it } from 'vitest'

import { mountQishui, QishuiClient, qrHalfBlocks, QishuiSource, type QishuiFetch } from '../src/music/sources/qishui.ts'

type Call = { url: string; method: string; headers: Record<string, string>; body: string }

function fakeFetch(answers: Record<string, { body: unknown; headers?: Record<string, string>; status?: number } | ((call: Call) => { body: unknown; headers?: Record<string, string>; status?: number })>): { fetch: QishuiFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: QishuiFetch = async (url, init) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') }
    calls.push(call)
    const path = new URL(call.url).pathname
    const hit = Object.entries(answers).find(([key]) => path.endsWith(key))
    if (hit === undefined) return new Response('{}', { status: 404 })
    const answer = typeof hit[1] === 'function' ? hit[1](call) : hit[1]
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: answer.headers ?? {} })
  }
  return { fetch, calls }
}

const QR = {
  body: {
    message: 'success',
    data: {
      token: 'tok-<redacted>',
      qrcode: 'data:image/png;base64,<redacted>',
      qrcode_index_url: 'https://bff-pc.qishui.com/ucenter_web/app/sdk-next?next_url=<redacted>',
      expire_time: 1788749637,
      web_name: 'Soda Music PC',
      copywriting: '{"desc":"scan with the Douyin app"}',
    },
  },
  headers: { 'set-cookie': 'passport_csrf_token=<redacted-csrf>; Path=/; Domain=qishui.com; Max-Age=5184000; Secure; SameSite=None' },
}

describe('QishuiClient (passport QR)', () => {
  it('issues the QR with the passport SDK parameters and keeps the csrf cookie for the poll', async () => {
    const { fetch, calls } = fakeFetch({ '/passport/web/get_qrcode/': QR })
    const client = new QishuiClient({ fetch })
    const qr = await client.issueQr()
    expect(qr).toEqual({ token: 'tok-<redacted>', url: 'https://bff-pc.qishui.com/ucenter_web/app/sdk-next?next_url=<redacted>', expiresAt: '2026-09-07T02:53:57.000Z', cookie: 'passport_csrf_token=<redacted-csrf>' })
    const u = new URL(calls[0]!.url)
    expect(u.host).toBe('api.qishui.com')
    expect(u.searchParams.get('aid')).toBe('386088')
    expect(u.searchParams.get('next')).toBe('https://api.qishui.com')
  })

  it('polls the status as a form post carrying the token and the csrf cookie; a confirmed scan yields the session', async () => {
    const { fetch, calls } = fakeFetch({
      '/passport/web/check_qrconnect/': (call) =>
        call.body.includes('token=tok-1')
          ? { body: { message: 'success', data: { status: 'confirmed', error_code: 0 } }, headers: { 'set-cookie': 'sessionid=<redacted-session>; Path=/; Domain=qishui.com; HttpOnly' } }
          : { body: { message: 'success', data: { status: 'new', error_code: 0 } } },
    })
    const client = new QishuiClient({ fetch })
    expect(await client.pollQr('tok-0', 'passport_csrf_token=x')).toEqual({ status: 'new' })
    expect(await client.pollQr('tok-1', 'passport_csrf_token=x')).toEqual({ status: 'confirmed', sessionId: '<redacted-session>' })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0]!.headers.Cookie).toBe('passport_csrf_token=x')
    expect(calls[0]!.body).toContain('token=tok-0')
    expect(calls[0]!.body).toContain('is_frontier=true')
  })
})

const ME = { body: { status_code: 0, my_info: { id: 7788, nickname: 'Soda Listener', is_vip: false } } }
const PLAYLISTS = { body: { status_code: 0, playlists: [{ id: '1', title: 'night drive', count_tracks: 12 }, { id: '2', name: 'gym', count_tracks: 3 }], total_num: 2 } }
const COLLECTION = {
  body: {
    status_code: 0,
    mixed_collections: [
      { item_type: 'track', track: { id: '9', name: 'Holocene', artists: [{ name: 'Bon Iver' }], album: { name: 'Bon Iver' }, duration: 344000 } },
      { item_type: 'playlist', playlist: { id: '3', title: 'someone else list' } },
      { item_type: 'track', media: { track: { id: '10', name: 'Groupies', artists: [{ name: 'Cheer Chen' }] } } },
      { item_type: 'video', video: { id: 'v1', title: 'a clip' } },
    ],
    total_num: 4,
  },
}
const DAILY = {
  body: {
    status_code: 0,
    media_resources: [
      { entity: { track_wrapper: { track: { id: '11', name: 'Re: Stacks', artists: [{ name: 'Bon Iver' }] } } } },
      { entity: { track: { id: '12', name: 'Travel Is Meaningful', artists: [{ name: 'Cheer Chen' }] } } },
    ],
  },
}

describe('QishuiClient (account reads, Luna PC transport)', () => {
  const entry = { sessionCookie: '<redacted-session>', deviceId: '1234567890123456', installId: '6543210987654321' }

  it('reads me with the LunaPC agent and the session cookie only', async () => {
    const { fetch, calls } = fakeFetch({ '/luna/pc/me': ME })
    expect(await new QishuiClient({ fetch }).me(entry)).toEqual({ id: '7788', who: 'Soda Listener' })
    expect(calls[0]!.headers['User-Agent']).toBe('LunaPC/3.0.0(290101097)')
    expect(calls[0]!.headers.Cookie).toBe('sessionid=<redacted-session>')
    expect(new URL(calls[0]!.url).searchParams.get('aid')).toBe('386088')
  })

  it('a dead session and a 401 both read as no account; a 429 is rate limiting', async () => {
    // The mount asks "who is this?" and wants an answer, not an exception;
    // the reads behind the snapshot are where a dead session throws.
    expect(await new QishuiClient({ fetch: fakeFetch({ '/luna/pc/me': { body: { status_code: 1000006, status_msg: 'login' } } }).fetch }).me(entry)).toBeNull()
    expect(await new QishuiClient({ fetch: fakeFetch({ '/luna/pc/me': { body: {}, status: 401 } }).fetch }).me(entry)).toBeNull()
    await expect(new QishuiClient({ fetch: fakeFetch({ '/luna/pc/me': { body: {}, status: 429 } }).fetch }).me(entry)).rejects.toMatchObject({ reason: 'rate-limited' })
    await expect(new QishuiClient({ fetch: fakeFetch({ '/luna/pc/me/playlist': { body: { status_code: 1000006 } } }).fetch }).playlists(entry)).rejects.toMatchObject({ source: 'qishui', reason: 'expired' })
  })

  it('a dead session on the account reads is the typed failure, never an empty snapshot', async () => {
    // The PC endpoints answer HTTP 200 with a nonzero status_code; parsed as
    // empty arrays, a refresh would replace the last good snapshot with
    // nothing and never say the login is gone.
    const dead = { body: { status_code: 1000006, status_msg: 'login' } }
    const source = new QishuiSource(entry, { fetch: fakeFetch({ '/luna/pc/me': dead, '/luna/pc/me/playlist': dead, '/luna/pc/me/collection/mixed': dead }).fetch })
    await expect(source.snapshot()).rejects.toMatchObject({ source: 'qishui', reason: 'expired' })
    expect(await source.verify()).toEqual({ ok: false, reason: 'expired' })
  })

  it('snapshots the collection, the playlist names and the daily mix; a forbidden daily mix is simply empty', async () => {
    const { fetch, calls } = fakeFetch({ '/luna/pc/me': ME, '/luna/pc/me/playlist': PLAYLISTS, '/luna/pc/me/collection/mixed': COLLECTION, '/luna/feed/song-tab': DAILY })
    const source = new QishuiSource(entry, { fetch, now: () => new Date('2026-09-06T10:00:00Z') })
    expect(await source.verify()).toEqual({ ok: true, who: 'Soda Listener' })
    const snapshot = await source.snapshot()
    expect(snapshot).toEqual({
      source: 'qishui',
      takenAt: '2026-09-06T10:00:00.000Z',
      items: [
        { kind: 'liked', title: 'Holocene', artist: 'Bon Iver', album: 'Bon Iver' },
        { kind: 'playlist', title: 'someone else list' },
        { kind: 'liked', title: 'Groupies', artist: 'Cheer Chen' },
        { kind: 'playlist', title: 'night drive' },
        { kind: 'playlist', title: 'gym' },
        { kind: 'daily', title: 'Re: Stacks', artist: 'Bon Iver' },
        { kind: 'daily', title: 'Travel Is Meaningful', artist: 'Cheer Chen' },
      ],
    })
    const daily = calls.find((c) => c.url.includes('/luna/feed/song-tab'))!
    expect(daily.method).toBe('POST')
    expect(daily.headers['User-Agent']).toBe('Luna/19.1.0 Android')
    expect(new URL(daily.url).host).toBe('beta-luna.douyin.com')

    const forbidden = fakeFetch({ '/luna/pc/me': ME, '/luna/pc/me/playlist': PLAYLISTS, '/luna/pc/me/collection/mixed': COLLECTION, '/luna/feed/song-tab': { body: { status_code: 1000006 } } })
    const items = (await new QishuiSource(entry, { fetch: forbidden.fetch }).snapshot()).items
    expect(items.some((i) => i.kind === 'daily')).toBe(false)
    expect(items.some((i) => i.kind === 'liked')).toBe(true)
  })
})

describe('mountQishui (the QR conversation, polled)', () => {
  it('issues, shows, polls every tick until confirmed, then reads who', async () => {
    let polls = 0
    const { fetch } = fakeFetch({
      '/passport/web/get_qrcode/': QR,
      '/passport/web/check_qrconnect/': () => (++polls < 3 ? { body: { data: { status: polls === 1 ? 'new' : 'scanned' } } } : { body: { data: { status: 'confirmed' } }, headers: { 'set-cookie': 'sessionid=<redacted-s>; Path=/' } }),
      '/luna/pc/me': ME,
    })
    const shown: string[] = []
    const waits: number[] = []
    const result = await mountQishui({ fetch, sleep: async (ms) => void waits.push(ms), random: () => '1111111111111111' }, { show: (url) => void shown.push(url), timeoutMs: 60_000 })
    expect(result).toMatchObject({ ok: true, who: 'Soda Listener', entry: { sessionCookie: '<redacted-s>', deviceId: '1111111111111111', installId: '1111111111111111' } })
    expect(shown).toEqual(['https://bff-pc.qishui.com/ucenter_web/app/sdk-next?next_url=<redacted>'])
    expect(polls).toBe(3)
    expect(waits.every((ms) => ms === 2000)).toBe(true)
  })

  it('gives up at the timeout with the typed outcome, and stops on cancel', async () => {
    const { fetch } = fakeFetch({ '/passport/web/get_qrcode/': QR, '/passport/web/check_qrconnect/': { body: { data: { status: 'new' } } } })
    let clock = 0
    const timedOut = await mountQishui({ fetch, sleep: async (ms) => void (clock += ms), now: () => new Date(clock) }, { show: () => {}, timeoutMs: 10_000 })
    expect(timedOut).toEqual({ ok: false, reason: 'timeout' })
    let cancelled = false
    const stopped = await mountQishui({ fetch, sleep: async () => void (cancelled = true) }, { show: () => {}, timeoutMs: 60_000, cancelled: () => cancelled })
    expect(stopped).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('an expired code is the timeout outcome too', async () => {
    const { fetch } = fakeFetch({ '/passport/web/get_qrcode/': QR, '/passport/web/check_qrconnect/': { body: { data: { status: 'expired' } } } })
    expect(await mountQishui({ fetch, sleep: async () => {} }, { show: () => {}, timeoutMs: 60_000 })).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('qrHalfBlocks', () => {
  it('renders a scannable grid in half-block cells with a quiet zone', () => {
    const lines = qrHalfBlocks('https://example.com/x')
    expect(lines.length).toBeGreaterThan(10)
    // Every row is the same width, and only the four half-block cells occur.
    const width = lines[0]!.length
    for (const line of lines) {
      expect(line.length).toBe(width)
      expect(line).toMatch(/^[ █▀▄]+$/)
    }
    // The quiet zone: the first and last rows, and the first/last cells of
    // every row, are light (rendered as full blocks on a dark terminal).
    expect(lines[0]).toBe('█'.repeat(width))
    for (const line of lines) expect(line.startsWith('██') && line.endsWith('██')).toBe(true)
  })
})
