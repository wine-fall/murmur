// Spotify (spec 14 §2.8): OAuth 2.0 PKCE against the listener's own app, a
// local callback, refresh on expiry, and the four read-only lists. Shapes
// follow the Web API reference; the user's account is the smoke (§5.7).
import { describe, expect, it } from 'vitest'

import { mountSpotify, pkcePair, redirectUri, SPOTIFY_CALLBACK_PORT, spotifyAuthUrl, SpotifySource, type SpotifyFetch } from '../src/music/sources/spotify.ts'

type Call = { url: string; method: string; headers: Record<string, string>; body: string }

function fakeFetch(answers: Record<string, unknown | ((call: Call) => { body: unknown; status?: number })>): { fetch: SpotifyFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: SpotifyFetch = async (url, init) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') }
    calls.push(call)
    const path = new URL(call.url).pathname
    const hit = Object.entries(answers).find(([key]) => path === key || path.endsWith(key))
    if (hit === undefined) return new Response('{}', { status: 404 })
    const answer = typeof hit[1] === 'function' ? (hit[1] as (c: Call) => { body: unknown; status?: number })(call) : { body: hit[1] }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }
  return { fetch, calls }
}

describe('PKCE', () => {
  it('derives the S256 challenge from the verifier, url-safe and unpadded', () => {
    const pair = pkcePair(Buffer.alloc(32, 7))
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkcePair(Buffer.alloc(32, 7)).challenge).toBe(pair.challenge)
    expect(pkcePair(Buffer.alloc(32, 8)).challenge).not.toBe(pair.challenge)
  })

  it('builds the authorize URL with the three read scopes and the exact redirect', () => {
    const url = new URL(spotifyAuthUrl('client-1', redirectUri(SPOTIFY_CALLBACK_PORT), 'state-1', 'chal'))
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:39917/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual(['playlist-read-private', 'user-library-read', 'user-top-read'])
  })
})

const ME = { id: 'u1', display_name: 'Listener' }
const TOKENS = { access_token: '<redacted-access>', refresh_token: '<redacted-refresh>', expires_in: 3600, token_type: 'Bearer' }

describe('mountSpotify', () => {
  it('opens the browser, waits for the callback, exchanges the code with the verifier, reads who', async () => {
    const { fetch, calls } = fakeFetch({ '/api/token': TOKENS, '/v1/me': ME })
    const opened: string[] = []
    const result = await mountSpotify('client-1', {
      fetch,
      openUrl: (url) => void opened.push(url),
      now: () => new Date('2026-09-06T10:00:00Z'),
      listen: async () => ({ port: 39917, code: async (state) => (state === new URL(opened[0]!).searchParams.get('state') ? 'code-1' : null), close: () => {} }),
      random: () => Buffer.alloc(32, 1),
    })
    expect(result).toEqual({
      ok: true,
      who: 'Listener',
      entry: { clientId: 'client-1', refreshToken: '<redacted-refresh>', accessToken: '<redacted-access>', expiresAt: '2026-09-06T11:00:00.000Z' },
    })
    const exchange = calls.find((c) => c.url.endsWith('/api/token'))!
    expect(exchange.method).toBe('POST')
    const form = new URLSearchParams(exchange.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('code-1')
    expect(form.get('client_id')).toBe('client-1')
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:39917/callback')
    expect(form.get('code_verifier')).toBe(pkcePair(Buffer.alloc(32, 1)).verifier)
    const me = calls.find((c) => c.url.endsWith('/v1/me'))!
    expect(me.headers.Authorization).toBe('Bearer <redacted-access>')
  })

  it('a callback that never arrives is the timeout outcome; a refused exchange is login-required', async () => {
    const silent = await mountSpotify('client-1', {
      fetch: fakeFetch({}).fetch,
      openUrl: () => {},
      listen: async () => ({ port: 1, code: async () => null, close: () => {} }),
    })
    expect(silent).toEqual({ ok: false, reason: 'timeout' })
    const refused = await mountSpotify('client-1', {
      fetch: fakeFetch({ '/api/token': () => ({ body: { error: 'invalid_grant' }, status: 400 }) }).fetch,
      openUrl: () => {},
      listen: async () => ({ port: 1, code: async () => 'c', close: () => {} }),
    })
    expect(refused).toEqual({ ok: false, reason: 'login-required' })
  })
})

const ENTRY = { clientId: 'client-1', refreshToken: '<redacted-refresh>', accessToken: '<redacted-access>', expiresAt: '2026-09-06T11:00:00.000Z' }

const TOP_ARTISTS = { items: [{ name: 'Bon Iver' }, { name: 'Ryuichi Sakamoto' }] }
const TOP_TRACKS = { items: [{ name: 'Holocene', artists: [{ name: 'Bon Iver' }], album: { name: 'Bon Iver' } }] }
const SAVED = (offset: number) => ({
  items: offset === 0 ? [{ added_at: '2026-09-01T00:00:00Z', track: { name: 'Re: Stacks', artists: [{ name: 'Bon Iver' }], album: { name: 'For Emma' } } }] : [],
  next: offset === 0 ? 'https://api.spotify.com/v1/me/tracks?offset=50&limit=50' : null,
})
const PLAYLISTS = { items: [{ name: 'late drive' }, { name: 'deep focus' }] }

describe('SpotifySource', () => {
  it('reads the top lists, the liked tracks (paged) and the playlist names with the bearer', async () => {
    const { fetch, calls } = fakeFetch({
      '/v1/me': ME,
      '/v1/me/top/artists': TOP_ARTISTS,
      '/v1/me/top/tracks': TOP_TRACKS,
      '/v1/me/tracks': (call: Call) => ({ body: SAVED(Number(new URL(call.url).searchParams.get('offset') ?? '0')) }),
      '/v1/me/playlists': PLAYLISTS,
    })
    const source = new SpotifySource(ENTRY, { fetch, now: () => new Date('2026-09-06T10:00:00Z'), onTokens: () => {} })
    expect(await source.verify()).toEqual({ ok: true, who: 'Listener' })
    const snapshot = await source.snapshot()
    expect(snapshot.items).toEqual([
      { kind: 'top-artist', title: 'Bon Iver' },
      { kind: 'top-artist', title: 'Ryuichi Sakamoto' },
      { kind: 'top-track', title: 'Holocene', artist: 'Bon Iver', album: 'Bon Iver' },
      { kind: 'liked', title: 'Re: Stacks', artist: 'Bon Iver', album: 'For Emma', at: '2026-09-01T00:00:00Z' },
      { kind: 'playlist', title: 'late drive' },
      { kind: 'playlist', title: 'deep focus' },
    ])
    const top = calls.find((c) => c.url.includes('/v1/me/top/artists'))!
    expect(new URL(top.url).searchParams.get('time_range')).toBe('medium_term')
    expect(new URL(top.url).searchParams.get('limit')).toBe('50')
    expect(top.headers.Authorization).toBe('Bearer <redacted-access>')
    expect(calls.filter((c) => c.url.includes('/v1/me/tracks'))).toHaveLength(2)
  })

  it('refreshes an expired token first and hands the rotated pair back to the store', async () => {
    const { fetch, calls } = fakeFetch({ '/api/token': { access_token: '<new-access>', refresh_token: '<new-refresh>', expires_in: 3600 }, '/v1/me': ME })
    const rotated: unknown[] = []
    const source = new SpotifySource(ENTRY, { fetch, now: () => new Date('2026-09-06T12:00:00Z'), onTokens: (t) => void rotated.push(t) })
    expect(await source.verify()).toEqual({ ok: true, who: 'Listener' })
    expect(calls[0]!.url).toContain('/api/token')
    expect(new URLSearchParams(calls[0]!.body).get('grant_type')).toBe('refresh_token')
    expect(rotated).toEqual([{ accessToken: '<new-access>', refreshToken: '<new-refresh>', expiresAt: '2026-09-06T13:00:00.000Z' }])
    expect(calls[1]!.headers.Authorization).toBe('Bearer <new-access>')
  })

  it('a 401 on a fresh token refreshes once; a refresh the platform refuses is expired', async () => {
    let meCalls = 0
    const { fetch } = fakeFetch({
      '/api/token': { access_token: '<new-access>', expires_in: 3600 },
      '/v1/me': () => (++meCalls === 1 ? { body: { error: { status: 401 } }, status: 401 } : { body: ME }),
    })
    const source = new SpotifySource(ENTRY, { fetch, now: () => new Date('2026-09-06T10:00:00Z'), onTokens: () => {} })
    expect(await source.verify()).toEqual({ ok: true, who: 'Listener' })
    const dead = new SpotifySource(ENTRY, {
      fetch: fakeFetch({ '/api/token': () => ({ body: { error: 'invalid_grant' }, status: 400 }) }).fetch,
      now: () => new Date('2026-09-06T12:00:00Z'),
      onTokens: () => {},
    })
    expect(await dead.verify()).toEqual({ ok: false, reason: 'expired' })
    await expect(dead.snapshot()).rejects.toMatchObject({ source: 'spotify', reason: 'expired' })
  })

  it('a 429 is rate limiting', async () => {
    const source = new SpotifySource(ENTRY, { fetch: fakeFetch({ '/v1/me/top/artists': () => ({ body: {}, status: 429 }) }).fetch, now: () => new Date('2026-09-06T10:00:00Z'), onTokens: () => {} })
    await expect(source.snapshot()).rejects.toMatchObject({ source: 'spotify', reason: 'rate-limited' })
  })
})
