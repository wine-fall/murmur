// Spotify (spec 14 §2.8): OAuth 2.0 PKCE against the listener's own app, a
// local callback, refresh on expiry, and the four read-only lists. Shapes
// follow the Web API reference; the user's account is the smoke (§5.7).
import { describe, expect, it } from 'vitest'

import { BUNDLED_CLIENT_ID, listenForCallback, mountSpotify, pkcePair, redirectUri, SPOTIFY_CALLBACK_PORT, spotifyAuthUrl, SpotifySource, type SpotifyFetch } from '../src/music/sources/spotify.ts'

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
    const url = new URL(spotifyAuthUrl('client-1', redirectUri(SPOTIFY_CALLBACK_PORT, 'client-1'), 'state-1', 'chal'))
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

  it('prints the consent URL for a listener whose browser did not open, and Esc cancels the wait', async () => {
    const urls: string[] = []
    let cancelled = false
    const result = await mountSpotify('client-1', {
      fetch: fakeFetch({}).fetch,
      openUrl: () => {},
      onUrl: (url) => void urls.push(url),
      cancelled: () => cancelled,
      listen: async () => ({
        port: 39917,
        code: () =>
          new Promise((resolve) => {
            cancelled = true
            setTimeout(() => resolve('late'), 2_000).unref()
          }),
        close: () => {},
      }),
    })
    expect(result).toEqual({ ok: false, reason: 'cancelled' })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('https://accounts.spotify.com/authorize')
  })

  it('stops watching for the cancel once the wait is settled', async () => {
    // Promise.race does not cancel its loser: a poll left running would wake
    // up every 250 ms for the rest of the session, once per Spotify attempt.
    let polls = 0
    await mountSpotify('client-1', {
      fetch: fakeFetch({ '/api/token': TOKENS, '/v1/me': ME }).fetch,
      openUrl: () => {},
      cancelled: () => (polls++, false),
      listen: async () => ({ port: 1, code: async () => 'code-1', close: () => {} }),
    })
    const settled = polls
    await new Promise((r) => setTimeout(r, 900))
    expect(polls).toBe(settled)
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

describe('the redirect URI follows the client id that will be used', () => {
  // OAuth matches a loopback redirect on its path — the port is ignored
  // (RFC 8252 §7.3) — so the bundled id has to be sent to the path it was
  // registered against, which is librespot's /login, not our own /callback.
  it('the bundled id redirects to /login, an app of the listener\'s own to /callback', () => {
    expect(redirectUri(SPOTIFY_CALLBACK_PORT, BUNDLED_CLIENT_ID)).toBe('http://127.0.0.1:39917/login')
    expect(redirectUri(SPOTIFY_CALLBACK_PORT, 'an-app-of-their-own')).toBe('http://127.0.0.1:39917/callback')
  })

  it('mounting on the bundled id asks Spotify for /login and answers there', async () => {
    let consent = ''
    const listen = async () => {
      const real = await listenForCallback(0)
      return real
    }
    const listener = await listen()
    try {
      const mounting = mountSpotify(BUNDLED_CLIENT_ID, {
        listen: async () => listener,
        openUrl: (url) => (consent = url),
        timeoutMs: 2000,
        fetch: async (url) =>
          new Response(
            JSON.stringify(
              String(url).includes('/api/token')
                ? { access_token: 'a', refresh_token: 'r', expires_in: 3600 }
                : { display_name: 'Listener', id: 'listener-1' },
            ),
          ),
      })
      // Wait for the consent URL, then knock on the path it named.
      while (consent === '') await new Promise((r) => setTimeout(r, 5))
      const redirect = new URL(new URL(consent).searchParams.get('redirect_uri')!)
      expect(redirect.pathname).toBe('/login')
      const state = new URL(consent).searchParams.get('state')!
      const answer = await fetch(`http://127.0.0.1:${listener.port}${redirect.pathname}?state=${encodeURIComponent(state)}&code=the-code`)
      expect(answer.status).toBe(200)
      await mounting
    } finally {
      listener.close()
    }
  })
})

describe('a throttled read waits rather than throwing the mount away (spec 14 §3.7)', () => {
  // The bundled client id is shared with every other librespot-based tool,
  // so a short 429 is ordinary weather. Discarding a completed consent over
  // seven seconds would cost the listener the whole authorization.
  const entry = { clientId: BUNDLED_CLIENT_ID, refreshToken: 'r', accessToken: 'a', expiresAt: '2099-01-01T00:00:00.000Z' }

  it('honours Retry-After and returns the read that follows', async () => {
    const waits: number[] = []
    let calls = 0
    const fetch: SpotifyFetch = async () => {
      calls++
      return calls === 1
        ? new Response('{"error":{"status":429}}', { status: 429, headers: { 'retry-after': '2' } })
        : new Response(JSON.stringify({ display_name: 'Listener', id: 'l1' }))
    }
    const source = new SpotifySource(entry, { fetch, sleep: async (ms) => void waits.push(ms), onTokens: () => {} })
    expect(await source.verify()).toEqual({ ok: true, who: 'Listener' })
    expect(waits).toEqual([2000])
    expect(calls).toBe(2)
  })

  it('gives up as rate-limited when the throttle outlasts the budget', async () => {
    const waits: number[] = []
    const fetch: SpotifyFetch = async () => new Response('{"error":{"status":429}}', { status: 429, headers: { 'retry-after': '30' } })
    const source = new SpotifySource(entry, { fetch, sleep: async (ms) => void waits.push(ms), onTokens: () => {} })
    await expect(source.snapshot()).rejects.toMatchObject({ source: 'spotify', reason: 'rate-limited' })
    // A wait longer than the budget is never taken: it fails fast instead.
    expect(waits).toEqual([])
  })
  it('a throttle on the identity read does not throw away a consent already given', async () => {
    // Observed on the real platform (2026-09-08): consent granted, code
    // exchanged, and then /me answered 429 with Retry-After 7 — which used
    // to surface as "could not reach Spotify" and lose the whole mount.
    const waits: number[] = []
    let me = 0
    const listener = await listenForCallback(0)
    let consent = ''
    try {
      const mounting = mountSpotify(BUNDLED_CLIENT_ID, {
        listen: async () => listener,
        openUrl: (url) => (consent = url),
        timeoutMs: 2000,
        sleep: async (ms) => void waits.push(ms),
        fetch: async (url) => {
          if (String(url).includes('/api/token')) return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
          me++
          return me === 1
            ? new Response('{"error":{"status":429}}', { status: 429, headers: { 'retry-after': '7' } })
            : new Response(JSON.stringify({ display_name: 'Listener', id: 'l1' }))
        },
      })
      while (consent === '') await new Promise((r) => setTimeout(r, 5))
      const state = new URL(consent).searchParams.get('state')!
      await fetch(`http://127.0.0.1:${listener.port}/login?state=${encodeURIComponent(state)}&code=the-code`)
      const result = await mounting
      expect(result).toMatchObject({ ok: true, who: 'Listener' })
      expect(waits).toEqual([7000])
    } finally {
      listener.close()
    }
  })
})
