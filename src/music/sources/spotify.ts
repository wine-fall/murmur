// Spotify as a read-only taste source (spec 14 §2.8, §6): OAuth 2.0 PKCE
// against the listener's OWN registered app (no client secret, no bundled
// client id — Development Mode ties quota to the app), a local redirect on
// 127.0.0.1, refresh on expiry, and the platform's own rankings: top
// artists, top tracks (medium term), liked tracks, playlist names. A free
// account is enough; playback is out of scope by decision.
//
// Every response is an untrusted boundary: zod at the edge, a refused
// refresh as the typed failure.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { z } from 'zod'

import { SourceAuthError } from './auth.ts'
import type { MountResult } from './netease.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

const ACCOUNTS = 'https://accounts.spotify.com'
const API = 'https://api.spotify.com/v1'
const SCOPES = ['user-top-read', 'user-library-read', 'playlist-read-private']
const DEFAULT_TIMEOUT_MS = 15_000
// The callback wait (spec 14 §3.7): three minutes, then "didn't hear back".
export const CALLBACK_TIMEOUT_MS = 3 * 60_000
// A registered redirect URI must match exactly, port included, so the port
// is fixed and only falls back to an ephemeral one when it is taken.
export const SPOTIFY_CALLBACK_PORT = 39917
const PAGE = 50
// A token about to expire is refreshed rather than raced.
const EXPIRY_SLACK_MS = 60_000

export type SpotifyFetch = (url: string, init?: RequestInit) => Promise<Response>

export type SpotifyEntry = { clientId: string; refreshToken: string; accessToken: string; expiresAt: string }
export type SpotifyTokens = Pick<SpotifyEntry, 'accessToken' | 'refreshToken' | 'expiresAt'>

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`
}

const base64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(bytes: Buffer = randomBytes(32)): { verifier: string; challenge: string } {
  const verifier = base64url(bytes)
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

export function spotifyAuthUrl(clientId: string, redirect: string, state: string, challenge: string): string {
  const url = new URL(`${ACCOUNTS}/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', SCOPES.join(' '))
  return url.toString()
}

// The local callback listener: bound on the fixed port (an ephemeral one if
// taken), answers the browser with a plain line, hands the code over once.
export type CallbackListener = {
  port: number
  // Resolves the code for a callback whose state matches; null on timeout
  // or a denied consent.
  code: (state: string, timeoutMs?: number) => Promise<string | null>
  close: () => void
}

export async function listenForCallback(preferredPort = SPOTIFY_CALLBACK_PORT): Promise<CallbackListener> {
  let resolveCode: ((code: string | null) => void) | null = null
  let expectedState = ''
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const ok = url.searchParams.get('state') === expectedState && url.searchParams.get('code') !== null
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(ok ? 'murmur has what it needs — you can close this tab.' : 'murmur did not get a code from Spotify — back in the terminal, try /sources again.')
    resolveCode?.(ok ? url.searchParams.get('code') : null)
  })
  const bind = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
  if (!(await bind(preferredPort))) await bind(0)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : preferredPort
  return {
    port,
    code: (state, timeoutMs = CALLBACK_TIMEOUT_MS) =>
      new Promise((resolve) => {
        expectedState = state
        const timer = setTimeout(() => resolve(null), timeoutMs)
        timer.unref()
        resolveCode = (code) => {
          clearTimeout(timer)
          resolve(code)
        }
      }),
    close: () => server.close(),
  }
}

export type SpotifyDeps = {
  fetch?: SpotifyFetch
  timeoutMs?: number
  now?: () => Date
}

export type SpotifyMountDeps = SpotifyDeps & {
  openUrl: (url: string) => void
  listen?: () => Promise<CallbackListener>
  random?: () => Buffer
  // The redirect URI, once bound — the flow prints it for the dashboard.
  onRedirect?: (uri: string) => void
  // The consent URL — printed too, for a browser that did not open (ssh, a
  // dead opener): the spawn's failure is invisible from here.
  onUrl?: (url: string) => void
  // Polled while waiting for the callback: the listener's Esc.
  cancelled?: () => boolean
  timeoutMs?: number
}

// How often the wait looks at the cancel flag.
const CANCEL_POLL_MS = 250

const TokenSchema = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number() })
const MeSchema = z.object({ id: z.string(), display_name: z.string().nullish() })
const NamedSchema = z.object({ name: z.string() })
const TrackSchema = z.object({ name: z.string(), artists: z.array(NamedSchema).optional(), album: z.object({ name: z.string().optional() }).nullish() })
const ItemsSchema = z.object({ items: z.array(z.unknown()), next: z.string().nullish() })
const SavedSchema = z.object({ added_at: z.string().optional(), track: z.unknown() })

function trackItem(kind: 'top-track' | 'liked', raw: unknown, at?: string): TasteItem | null {
  const track = TrackSchema.safeParse(raw)
  if (!track.success || track.data.name.trim() === '') return null
  const artist = (track.data.artists ?? [])
    .map((a) => a.name.trim())
    .filter((n) => n !== '')
    .join(' / ')
  const album = track.data.album?.name?.trim()
  return { kind, title: track.data.name, ...(artist !== '' && { artist }), ...(album && { album }), ...(at !== undefined && { at }) }
}

async function timed(fetchImpl: SpotifyFetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// The token endpoint, for the exchange and the refresh. null = the platform
// refused (invalid_grant: a revoked app, a spent code).
async function tokenCall(deps: SpotifyDeps, form: Record<string, string>): Promise<SpotifyTokens | null> {
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init))
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  }
  let response: Response
  try {
    response = await timed(fetchImpl, `${ACCOUNTS}/api/token`, init, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch {
    response = await timed(fetchImpl, `${ACCOUNTS}/api/token`, init, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }
  if (response.status === 429) throw new SourceAuthError('spotify', 'rate-limited', 'HTTP 429 on token')
  if (response.status === 400 || response.status === 401) return null
  if (!response.ok) throw new Error(`spotify token: HTTP ${response.status}`)
  const parsed = TokenSchema.safeParse(await response.json())
  if (!parsed.success) return null
  const now = (deps.now ?? (() => new Date()))()
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? form.refresh_token ?? '',
    expiresAt: new Date(now.getTime() + parsed.data.expires_in * 1000).toISOString(),
  }
}

export type SpotifyMountResult = MountResult<SpotifyEntry> | { ok: false; reason: 'timeout' | 'cancelled' }

// The mount (spec 14 §3.1): bind the callback, open the consent page in the
// listener's browser, wait for the code, exchange it, read who.
export async function mountSpotify(clientId: string, deps: SpotifyMountDeps): Promise<SpotifyMountResult> {
  const listener = await (deps.listen ?? listenForCallback)()
  try {
    const redirect = redirectUri(listener.port)
    deps.onRedirect?.(redirect)
    const { verifier, challenge } = pkcePair(deps.random?.())
    const state = base64url(deps.random?.() ?? randomBytes(16))
    const url = spotifyAuthUrl(clientId, redirect, state, challenge)
    deps.onUrl?.(url)
    deps.openUrl(url)
    // Promise.race does not cancel its loser, so the watch is told when the
    // wait is over: otherwise every Spotify attempt would leave a timer
    // waking up every quarter second for the rest of the session.
    let settled = false
    const code = await Promise.race([
      listener.code(state, deps.timeoutMs ?? CALLBACK_TIMEOUT_MS).finally(() => (settled = true)),
      (async (): Promise<'cancelled' | null> => {
        while (!settled) {
          if (deps.cancelled?.() === true) return 'cancelled'
          await new Promise((resolve) => setTimeout(resolve, CANCEL_POLL_MS).unref())
        }
        // The callback settled first: hand the race back to it.
        return new Promise<never>(() => {})
      })(),
    ])
    if (code === 'cancelled') return { ok: false, reason: 'cancelled' }
    if (code === null) return { ok: false, reason: 'timeout' }
    const tokens = await tokenCall(deps, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    })
    if (tokens === null) return { ok: false, reason: 'login-required' }
    const entry: SpotifyEntry = { clientId, ...tokens }
    const client = new SpotifyClient(entry, { ...deps, onTokens: () => {} })
    const me = await client.me()
    return { ok: true, who: me, entry }
  } finally {
    listener.close()
  }
}

export type SpotifySourceDeps = SpotifyDeps & {
  // A rotated pair lands in sources.json through the store (single writer).
  onTokens: (tokens: SpotifyTokens) => void
}

class SpotifyClient {
  private entry: SpotifyEntry
  private deps: SpotifySourceDeps
  private fetch: SpotifyFetch

  constructor(entry: SpotifyEntry, deps: SpotifySourceDeps) {
    this.entry = { ...entry }
    this.deps = deps
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
  }

  async me(): Promise<string> {
    const parsed = MeSchema.parse(await this.get('/me'))
    const name = parsed.display_name?.trim()
    return name ? name : parsed.id
  }

  async topArtists(): Promise<TasteItem[]> {
    const parsed = ItemsSchema.parse(await this.get('/me/top/artists', { time_range: 'medium_term', limit: String(BOUNDS.top) }))
    return parsed.items.flatMap((raw): TasteItem[] => {
      const a = NamedSchema.safeParse(raw)
      return a.success && a.data.name.trim() !== '' ? [{ kind: 'top-artist', title: a.data.name }] : []
    })
  }

  async topTracks(): Promise<TasteItem[]> {
    const parsed = ItemsSchema.parse(await this.get('/me/top/tracks', { time_range: 'medium_term', limit: String(BOUNDS.top) }))
    return parsed.items.flatMap((raw): TasteItem[] => {
      const item = trackItem('top-track', raw)
      return item === null ? [] : [item]
    })
  }

  async savedTracks(): Promise<TasteItem[]> {
    const items: TasteItem[] = []
    for (let offset = 0; items.length < BOUNDS.liked; offset += PAGE) {
      const parsed = ItemsSchema.parse(await this.get('/me/tracks', { limit: String(PAGE), offset: String(offset) }))
      for (const raw of parsed.items) {
        const saved = SavedSchema.safeParse(raw)
        if (!saved.success) continue
        const item = trackItem('liked', saved.data.track, saved.data.added_at)
        if (item !== null) items.push(item)
      }
      if (parsed.next == null || parsed.items.length === 0) break
    }
    return items.slice(0, BOUNDS.liked)
  }

  async playlists(): Promise<TasteItem[]> {
    const parsed = ItemsSchema.parse(await this.get('/me/playlists', { limit: String(BOUNDS.playlist) }))
    return parsed.items.flatMap((raw): TasteItem[] => {
      const p = NamedSchema.safeParse(raw)
      return p.success && p.data.name.trim() !== '' ? [{ kind: 'playlist', title: p.data.name }] : []
    })
  }

  // A GET with a live bearer: refreshed ahead of expiry, and once more on a
  // 401 the platform answers anyway. A refresh the platform refuses is the
  // login gone.
  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (new Date(this.entry.expiresAt).getTime() - this.now().getTime() < EXPIRY_SLACK_MS) await this.refresh()
    let response = await this.bearer(path, query)
    if (response.status === 401) {
      await this.refresh()
      response = await this.bearer(path, query)
    }
    if (response.status === 429) throw new SourceAuthError('spotify', 'rate-limited', `HTTP 429 on ${path}`)
    if (response.status === 401 || response.status === 403) throw new SourceAuthError('spotify', 'expired', `HTTP ${response.status} on ${path}`)
    if (!response.ok) throw new Error(`spotify ${path}: HTTP ${response.status}`)
    return response.json()
  }

  private async bearer(path: string, query: Record<string, string>): Promise<Response> {
    const url = new URL(`${API}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const init: RequestInit = { headers: { Authorization: `Bearer ${this.entry.accessToken}` } }
    const timeout = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    try {
      return await timed(this.fetch, url.toString(), init, timeout)
    } catch {
      return await timed(this.fetch, url.toString(), init, timeout)
    }
  }

  private async refresh(): Promise<void> {
    const tokens = await tokenCall(this.deps, { grant_type: 'refresh_token', refresh_token: this.entry.refreshToken, client_id: this.entry.clientId })
    if (tokens === null) throw new SourceAuthError('spotify', 'expired', 'the platform refused the refresh')
    this.entry = { ...this.entry, ...tokens }
    this.deps.onTokens(tokens)
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }
}

export class SpotifySource implements TasteSource {
  readonly id = 'spotify' as const
  private client: SpotifyClient
  private now: () => Date

  constructor(entry: SpotifyEntry, deps: SpotifySourceDeps) {
    this.client = new SpotifyClient(entry, deps)
    this.now = deps.now ?? (() => new Date())
  }

  async verify(): Promise<VerifyResult> {
    try {
      return { ok: true, who: await this.client.me() }
    } catch (err) {
      if (err instanceof SourceAuthError) return { ok: false, reason: err.reason }
      throw err
    }
  }

  async snapshot(): Promise<TasteSnapshot> {
    const artists = await this.client.topArtists()
    const tracks = await this.client.topTracks()
    const liked = await this.client.savedTracks()
    const playlists = await this.client.playlists()
    return { source: 'spotify', takenAt: this.now().toISOString(), items: [...artists, ...tracks, ...liked, ...playlists] }
  }
}
