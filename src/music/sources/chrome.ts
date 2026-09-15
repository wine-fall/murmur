// Which Chrome profile murmur uses (spec 14 §3.1). A mount binds one account
// on one site, and that account lives in one Chrome profile — so the profile
// is resolved once, at mount, written into the entry, and every later read
// hands that pin back here. Re-guessing per read is the bug this replaces: a
// refresh could quietly move a mount to a different profile's (empty) login.
//
// Left unnamed, yt-dlp reads the newest Cookies file under the whole user-data
// directory (yt_dlp/cookies.py), which with several profiles open at once is
// a coin toss — and murmur then opened the sign-in page in whatever window
// happened to be in front. Both halves name the profile now.
//
// The order: the profile pinned in the entry → Chrome's own
// `profile.last_used` → 'Default'. The pin comes first because the entry also
// holds the account's own identifiers (a Bilibili `mid`, a NetEase `userId`):
// reading another profile's cookies against them would mix two accounts into
// one snapshot. A knob that disagrees with a pin sends that mount down the
// reconnect road (`knobDisagrees`) rather than quietly changing account.
//
// `$MURMUR_CHROME_PROFILE` is NOT in that order any more. The listener now
// chooses the profile on the sign-in card (spec 14 §3.1, revised), so the
// knob preselects a row there (`preselectProfile`) and nothing else — a guess
// that is one keypress away from being corrected, instead of one that decides
// silently. `profiles()` is what that card lists.
//
// Local State is read for those keys, which are directory names and the
// display names Chrome already shows in its own profile menu. It sits beside
// the cookie store murmur already reads, so reading it grants nothing new;
// when it cannot be read there is no separate complaint — the cookie read
// that follows fails with yt-dlp's own words (no-browser / no-permission).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import { expandUser } from '../../paths.ts'

export const CHROME_PROFILE_ENV = 'MURMUR_CHROME_PROFILE'
export const DEFAULT_PROFILE = 'Default'

// The three keys. Everything else in Local State — the encryption key, the
// per-profile avatars and counters — is dropped here at the parse.
const ProfileInfo = z.object({ name: z.string().optional(), user_name: z.string().optional() })
const LocalState = z.object({
  profile: z.object({ last_used: z.string().optional(), info_cache: z.record(z.string(), ProfileInfo).optional() }).optional(),
})

export type ChromeDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  readFile?: (path: string) => string
  exists?: (path: string) => boolean
}

// One row of the sign-in card: the directory yt-dlp is told to read, and the
// two words a listener recognises it by. `email` absent = Chrome holds none
// for that profile (a local one), and the row says the name alone.
export type ChromeProfileInfo = { dir: string; name: string; email?: string }

export function localStatePath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Local State')
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data', 'Local State')
  // The same root yt-dlp resolves the cookie store under (`_config_home`), so
  // a listener with XDG_CONFIG_HOME set is not read from two different Chromes.
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'google-chrome', 'Local State')
}

// `last_used` is read once per run and held. Two resolutions of the same
// mount — the cookie read, and the write-back that pins what that read used —
// must agree, and they would not if Chrome changed profiles in between. It
// also keeps the file off the playback path, which resolves per track.
let lastUsed: string | null = null

export function chromeProfile(pinned?: string | undefined, deps: ChromeDeps = {}): string {
  const env = deps.env ?? process.env
  if (pinned !== undefined && pinned.trim() !== '') return pinned
  // Only the real read is held; an injected one belongs to its caller.
  const live = deps.readFile === undefined
  if (live && lastUsed !== null) return lastUsed
  const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, 'utf-8'))
  try {
    const parsed = LocalState.safeParse(JSON.parse(readFile(localStatePath(deps.platform ?? process.platform, deps.home ?? expandUser('~'), env))))
    const last = parsed.success ? parsed.data.profile?.last_used : undefined
    if (last !== undefined && last.trim() !== '') {
      if (live) lastUsed = last
      return last
    }
  } catch {
    // Absent, locked or not JSON: Default is the profile Chrome itself starts
    // with, and the cookie read that follows says what is wrong if anything is.
  }
  if (live) lastUsed = DEFAULT_PROFILE
  return DEFAULT_PROFILE
}

// The knob names one profile and the mount is pinned to another. murmur reads
// neither mixture: the mount takes the same road as a lost login, and ticking
// it again is a fresh mount, resolved by the knob (spec 14 §3.1).
export function knobDisagrees(pinned: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const named = env[CHROME_PROFILE_ENV]?.trim()
  if (named === undefined || named === '') return false
  return pinned !== undefined && pinned.trim() !== '' && named !== pinned
}

// Read Local State whole, once, for whatever the caller wants out of it.
// Absent, locked or not JSON is not an error here: every caller has a
// fallback, and the cookie read that follows says what is wrong if anything is.
function localState(deps: ChromeDeps): z.infer<typeof LocalState> | null {
  const env = deps.env ?? process.env
  const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, 'utf-8'))
  try {
    const parsed = LocalState.safeParse(JSON.parse(readFile(localStatePath(deps.platform ?? process.platform, deps.home ?? expandUser('~'), env))))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// The Chrome profiles the sign-in card offers (spec 14 §3.1). Chrome's own
// profile menu is the model: the display name the listener gave the profile,
// and the account signed in to it, which is the half that tells a work
// profile from a personal one.
//
// `Default` leads, then Chrome's own order — a listener reads the card in the
// order their browser trained them to. A directory Local State still lists
// but Chrome no longer has is dropped: choosing it would mount an account
// that is not there. The list is never empty — with nothing readable there is
// still `Default`, which is the profile Chrome itself starts with.
export function profiles(deps: ChromeDeps = {}): ChromeProfileInfo[] {
  const cache = localState(deps)?.profile?.info_cache
  const rows: ChromeProfileInfo[] = []
  if (cache !== undefined) {
    const root = dirname(localStatePath(deps.platform ?? process.platform, deps.home ?? expandUser('~'), deps.env ?? process.env))
    const exists = deps.exists ?? ((path: string): boolean => existsSync(path))
    const dirs = Object.keys(cache).sort((a, b) => (a === DEFAULT_PROFILE ? -1 : b === DEFAULT_PROFILE ? 1 : 0))
    for (const dir of dirs) {
      if (!exists(join(root, dir))) continue
      const email = cache[dir]?.user_name?.trim()
      rows.push({ dir, name: cache[dir]?.name?.trim() || dir, ...(email !== undefined && email !== '' && { email }) })
    }
  }
  return rows.length > 0 ? rows : [{ dir: DEFAULT_PROFILE, name: DEFAULT_PROFILE }]
}

// Which row the sign-in card opens on (spec 14 §3.1). Only a preselection:
// every arm below is a guess, and the listener overrules any of them with one
// keypress — which is the whole point of asking. The pin leads because a
// mount already bound to an account is not a guess at all; then the knob, for
// a listener who set one; then what this same submit already chose, so three
// sources in a row are one account and not three questions; then Chrome's own
// last_used, and Default.
export function preselectProfile(pinned: string | undefined, previous: string | undefined, deps: ChromeDeps = {}): string {
  const env = deps.env ?? process.env
  if (pinned !== undefined && pinned.trim() !== '') return pinned
  const named = env[CHROME_PROFILE_ENV]?.trim()
  if (named !== undefined && named !== '') return named
  if (previous !== undefined && previous.trim() !== '') return previous
  return chromeProfile(undefined, deps)
}
