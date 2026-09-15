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
// The order: the profile pinned in the entry → MURMUR_CHROME_PROFILE →
// Chrome's own `profile.last_used` → 'Default'. The pin comes first because
// the entry also holds the account's own identifiers (a Bilibili `mid`, a
// NetEase `userId`): reading another profile's cookies against them would mix
// two accounts into one snapshot. So the knob only decides for a mount that
// has no pin yet, and a knob that disagrees with one sends that mount down
// the reconnect road (`knobDisagrees`) rather than quietly changing account.
//
// Local State is read for that one key, which is a directory name. It sits
// beside the cookie store murmur already reads, so reading it grants nothing
// new; when it cannot be read there is no separate complaint — the cookie read
// that follows fails with yt-dlp's own words (no-browser / no-permission).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { expandUser } from '../../paths.ts'

export const CHROME_PROFILE_ENV = 'MURMUR_CHROME_PROFILE'
export const DEFAULT_PROFILE = 'Default'

// The one key. Everything else in Local State — the profile list, the
// encryption key — is dropped here at the parse.
const LocalState = z.object({ profile: z.object({ last_used: z.string().optional() }).optional() })

export type ChromeDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  readFile?: (path: string) => string
}

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
  const named = env[CHROME_PROFILE_ENV]?.trim()
  if (named !== undefined && named !== '') return named
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
