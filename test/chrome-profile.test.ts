// Which Chrome profile murmur reads and signs in to (spec 14 §3.1). The bug
// this locks out: left unnamed, yt-dlp picks whichever profile's Cookies file
// was written last, so a listener with three profiles open had a mount read an
// empty one and a sign-in page open in a fourth window.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CHROME_PROFILE_ENV, chromeProfile, localStatePath } from '../src/music/sources/chrome.ts'
import { browserArgs, cookieArgs, SourcesStore } from '../src/music/sources/store.ts'

const HOME = '/home/someone'
const LAST_USED = JSON.stringify({ profile: { last_used: 'Profile 3', info_cache: {} }, os_crypt: {} })

function deps(over: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; state?: string | Error } = {}) {
  const state = over.state ?? LAST_USED
  return {
    env: over.env ?? {},
    platform: over.platform ?? ('darwin' as NodeJS.Platform),
    home: HOME,
    readFile: (): string => {
      if (state instanceof Error) throw state
      return state
    },
  }
}

describe('chromeProfile (spec 14 §3.1)', () => {
  it("takes Chrome's own last_used when nothing is pinned or named", () => {
    expect(chromeProfile(undefined, deps())).toBe('Profile 3')
  })

  it('prefers the profile pinned at mount over last_used — a mount binds one account, and re-guessing is what moved it', () => {
    expect(chromeProfile('Default', deps())).toBe('Default')
  })

  it('lets the environment knob override even a pinned profile: naming one is explicit intent', () => {
    expect(chromeProfile('Default', deps({ env: { [CHROME_PROFILE_ENV]: 'Work' } }))).toBe('Work')
    expect(chromeProfile(undefined, deps({ env: { [CHROME_PROFILE_ENV]: '  Work  ' } }))).toBe('Work')
    // An empty knob is not an answer.
    expect(chromeProfile(undefined, deps({ env: { [CHROME_PROFILE_ENV]: '  ' } }))).toBe('Profile 3')
  })

  it('falls back to Default when Local State is missing, unreadable, not JSON, or has no last_used', () => {
    expect(chromeProfile(undefined, deps({ state: new Error('ENOENT') }))).toBe('Default')
    expect(chromeProfile(undefined, deps({ state: '{ not json' }))).toBe('Default')
    expect(chromeProfile(undefined, deps({ state: JSON.stringify({ profile: {} }) }))).toBe('Default')
    expect(chromeProfile(undefined, deps({ state: JSON.stringify({ profile: { last_used: '  ' } }) }))).toBe('Default')
    expect(chromeProfile(undefined, deps({ state: JSON.stringify({ profile: { last_used: 7 } }) }))).toBe('Default')
  })

  it("knows where Chrome keeps Local State on each platform, and reads nothing else there", () => {
    expect(localStatePath('darwin', HOME, {})).toBe('/home/someone/Library/Application Support/Google/Chrome/Local State')
    expect(localStatePath('linux', HOME, {})).toBe('/home/someone/.config/google-chrome/Local State')
    // yt-dlp resolves the cookie store under XDG_CONFIG_HOME too; reading
    // Local State from elsewhere would name a profile of a different Chrome.
    expect(localStatePath('linux', HOME, { XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/google-chrome/Local State')
    expect(localStatePath('win32', HOME, { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toContain('Google')
    expect(localStatePath('win32', HOME, { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toContain('Local State')
    // No LOCALAPPDATA: the conventional place under the home directory.
    expect(localStatePath('win32', HOME, {})).toContain('AppData')
  })
})

describe('yt-dlp cookie arguments always name a Chrome profile (spec 14 §3.1)', () => {
  const resolve = (pinned?: string): string => pinned ?? 'Profile 3'

  it('names the pinned profile for a Chrome entry', () => {
    expect(browserArgs({ browser: 'chrome', profile: 'Default' }, resolve)).toEqual(['--cookies-from-browser', 'chrome:Default'])
  })

  it('names a resolved profile for a Chrome entry that has none — never bare `chrome`', () => {
    expect(browserArgs({ browser: 'chrome' }, resolve)).toEqual(['--cookies-from-browser', 'chrome:Profile 3'])
  })

  it('leaves every other browser exactly as it was: only Chrome is resolved', () => {
    expect(browserArgs({ browser: 'brave', profile: 'Profile 1' }, resolve)).toEqual(['--cookies-from-browser', 'brave:Profile 1'])
    expect(browserArgs({ browser: 'firefox' }, resolve)).toEqual(['--cookies-from-browser', 'firefox'])
    expect(browserArgs(undefined, resolve)).toEqual([])
  })

  it('carries through to playback', () => {
    const file = { netease: { browser: 'chrome' as const, userId: '4', likedPlaylistId: '7', mountedAt: 'x', status: 'ok' as const } }
    expect(cookieArgs('https://music.163.com/#/song?id=1', file, resolve)).toEqual(['--cookies-from-browser', 'chrome:Profile 3'])
  })
})

function store(): SourcesStore {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-chrome-'))
  return new SourcesStore({ path: join(dir, 'sources.json'), tasteDir: join(dir, 'taste') })
}

describe('pinning the profile in the entry (spec 14 §3.1)', () => {
  it('writes the resolved profile back into a mount made before murmur named profiles', () => {
    const s = store()
    s.mount('netease', { browser: 'chrome', userId: '4', likedPlaylistId: '7' })
    expect(s.read().netease?.profile).toBeUndefined()
    s.pinChromeProfile('netease', (pinned) => pinned ?? 'Profile 3')
    expect(s.read().netease?.profile).toBe('Profile 3')
  })

  it('leaves a pin that is already there alone — refresh reads it, it never re-guesses', () => {
    const s = store()
    s.mount('youtube', { browser: 'chrome', profile: 'Default' })
    s.pinChromeProfile('youtube', (pinned) => pinned ?? 'Profile 3')
    expect(s.read().youtube?.profile).toBe('Default')
  })

  it('writes the knob back over a stale pin: the knob is what the read just used', () => {
    const s = store()
    s.mount('youtube', { browser: 'chrome', profile: 'Default' })
    s.pinChromeProfile('youtube', () => 'Work')
    expect(s.read().youtube?.profile).toBe('Work')
  })

  it('touches nothing for a non-Chrome mount or a source that has no browser at all', () => {
    const s = store()
    s.mount('youtube', { browser: 'firefox' })
    s.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'z' })
    s.pinChromeProfile('youtube', () => 'Work')
    s.pinChromeProfile('spotify', () => 'Work')
    expect(s.read().youtube?.profile).toBeUndefined()
    expect(s.read().spotify).not.toHaveProperty('profile')
  })

  it('does nothing for a source that is not mounted', () => {
    const s = store()
    s.pinChromeProfile('youtube', () => 'Work')
    expect(s.read().youtube).toBeUndefined()
  })
})
