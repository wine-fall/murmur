// Typed auth failure (spec 14 §2.6): the reason a source stopped answering,
// classified once from captured text, carried as one error type through the
// resolve path, and said on screen exactly once per source per session — an
// expired cookie names a login instead of being "pick another" in silence.

import type { Host } from '../../host/host.ts'
import type { SourceId } from './taste.ts'
import { SOURCE_NAMES } from './taste.ts'
import type { SourcesStore } from './store.ts'

export type AuthFailure = 'login-required' | 'expired' | 'geo' | 'rate-limited'

export class SourceAuthError extends Error {
  readonly source: SourceId
  readonly reason: AuthFailure

  constructor(source: SourceId, reason: AuthFailure, detail: string) {
    super(`${SOURCE_NAMES[source]}: ${reason} (${detail})`)
    this.name = 'SourceAuthError'
    this.source = source
    this.reason = reason
  }
}

// The captured shapes, in the order a text must be tried: yt-dlp's cookie
// rotation warning names "login" too, and a 429 page can mention signing in.
const EXPIRED = /cookies are no longer valid|cookies? (?:has|have) expired|session (?:has )?expired/i
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i
const GEO = /geo.?restrict|not available from your location|not available in your (?:country|region)/i
const LOGIN = /login required|requires? (?:a )?login|only available for registered users|sign in to confirm|\bcode"?\s*:\s*-462\b|\b-462\b|not logged in|need login|please log ?in/i

export function classifyAuthFailure(text: string): AuthFailure | null {
  if (EXPIRED.test(text)) return 'expired'
  if (RATE_LIMITED.test(text)) return 'rate-limited'
  if (GEO.test(text)) return 'geo'
  if (LOGIN.test(text)) return 'login-required'
  return null
}

// The preview trap (yt-dlp issue 14142): NetEase answers a rights-less
// request with a 30 s preview and no error. A clip this short against a
// candidate this long is a login problem; an unknown number on either side is
// never turned into one.
export const PREVIEW_MAX_S = 45
export const PREVIEW_CANDIDATE_MIN_S = 90

export function previewTrap(candidateS: number, probedS: number | null): boolean {
  if (probedS === null || candidateS <= PREVIEW_CANDIDATE_MIN_S) return false
  return probedS > 0 && probedS < PREVIEW_MAX_S
}

// The listener-facing lines (spec 14 §3.7), exact.
export const AUTH_LINES = {
  expired: (site: string): string => `your ${site} login has expired — /sources to renew; picking from elsewhere for now.`,
  'login-required': (site: string): string => `your ${site} login has expired — /sources to renew; picking from elsewhere for now.`,
  geo: (site: string): string => `${site} says that one is not available from here — picking from elsewhere for now.`,
  'rate-limited': (site: string): string => `${site} is asking us to slow down — I'll try again later.`,
} as const satisfies Record<AuthFailure, (site: string) => string>

// What the file records for each reason: a lost login flips the mount to
// expired (the /sources list shows "renew"); the others keep it mounted and
// note the error, because nothing about the login is known to be wrong.
const STATUS: Record<AuthFailure, 'expired' | 'error'> = {
  expired: 'expired',
  'login-required': 'expired',
  geo: 'error',
  'rate-limited': 'error',
}

export type SourceAuthWatchDeps = { store: SourcesStore; host: Pick<Host, 'info' | 'debug'> }

export class SourceAuthWatch {
  private deps: SourceAuthWatchDeps
  private said = new Set<SourceId>()

  constructor(deps: SourceAuthWatchDeps) {
    this.deps = deps
  }

  note(err: SourceAuthError): void {
    const { store, host } = this.deps
    // Reason only — the detail may quote a cookie or a token (spec 14 §3.6).
    host.debug?.(`sources.auth ${err.source} ${err.reason}`)
    store.setStatus(err.source, STATUS[err.reason], err.reason)
    if (this.said.has(err.source)) return
    this.said.add(err.source)
    host.info(AUTH_LINES[err.reason](SOURCE_NAMES[err.source]))
  }

  // A renewed mount may fail again later, and deserves its own line then.
  reset(source: SourceId): void {
    this.said.delete(source)
  }
}
