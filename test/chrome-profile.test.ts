// Which Chrome profile murmur reads and signs in to (spec 14 §3.1). The bug
// this locks out: left unnamed, yt-dlp picks whichever profile's Cookies file
// was written last, so a listener with three profiles open had a mount read an
// empty one and a sign-in page open in a fourth window.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CHROME_PROFILE_ENV, chromeProfile, localStatePath, preselectProfile, profiles } from '../src/music/sources/chrome.ts'
import { browserArgs, SourcesStore } from '../src/music/sources/store.ts'

const HOME = '/home/someone'
const LAST_USED = JSON.stringify({ profile: { last_used: 'Profile 3', info_cache: {} }, os_crypt: {} })

// A listener with three profiles, one of them listed but no longer on disk —
// the shape the sign-in card is drawn from (spec 14 §3.1).
const THREE = JSON.stringify({
  profile: {
    last_used: 'Profile 3',
    info_cache: {
      'Profile 3': { name: 'Personal', user_name: 'fawinell@gmail.com', avatar_icon: 'chrome://x' },
      Default: { name: 'Work', user_name: 'zach.guo@opus.pro' },
      'Profile 7': { name: 'Spare', user_name: '' },
      'Profile 9': { name: 'Deleted', user_name: 'gone@example.com' },
    },
  },
  os_crypt: {},
})

const GONE = '/home/someone/Library/Application Support/Google/Chrome/Profile 9'

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
    exists: (path: string): boolean => path !== GONE,
  }
}

describe('chromeProfile (spec 14 §3.1)', () => {
  it("takes Chrome's own last_used when nothing is pinned or named", () => {
    expect(chromeProfile(undefined, deps())).toBe('Profile 3')
  })

  it('prefers the profile pinned at mount over last_used — a mount binds one account, and re-guessing is what moved it', () => {
    expect(chromeProfile('Default', deps())).toBe('Default')
  })

  // The profile is CHOSEN on the sign-in card now (spec 14 §3.1, revised):
  // resolving a mount is the pin or Chrome's own last_used, never the knob,
  // which only preselects a row on that card.
  it('never resolves a mount from the knob — the knob preselects the card, it does not decide', () => {
    expect(chromeProfile(undefined, deps({ env: { [CHROME_PROFILE_ENV]: '  Work  ' } }))).toBe('Profile 3')
    expect(chromeProfile(undefined, deps({ env: { [CHROME_PROFILE_ENV]: '  ' } }))).toBe('Profile 3')
  })

  it('never lets the knob move a pinned mount: the entry holds that account\'s own ids, and a mixed snapshot is worse than none', () => {
    expect(chromeProfile('Default', deps({ env: { [CHROME_PROFILE_ENV]: 'Work' } }))).toBe('Default')
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

// The rows of the sign-in card (spec 14 §3.1): the listener picks the Chrome
// profile instead of inheriting whichever one Chrome touched last — the bug
// this closes is a mount that read the work account with no step to say so.
describe('profiles() — the Chrome profiles a listener can choose (spec 14 §3.1)', () => {
  it('lists name and email per profile, Default first, then Chrome\'s own order', () => {
    expect(profiles(deps({ state: THREE }))).toEqual([
      { dir: 'Default', name: 'Work', email: 'zach.guo@opus.pro' },
      { dir: 'Profile 3', name: 'Personal', email: 'fawinell@gmail.com' },
      { dir: 'Profile 7', name: 'Spare' },
    ])
  })

  it('drops a profile Local State still lists but Chrome no longer has on disk', () => {
    expect(profiles(deps({ state: THREE })).map((p) => p.dir)).not.toContain('Profile 9')
  })

  it('omits the email when the profile has none — a row reading "Chrome — Spare ()" would be noise', () => {
    expect(profiles(deps({ state: THREE })).find((p) => p.dir === 'Profile 7')).not.toHaveProperty('email')
  })

  it('names a profile by its directory when Chrome kept no display name for it', () => {
    const state = JSON.stringify({ profile: { info_cache: { 'Profile 4': { name: '  ' } } } })
    expect(profiles(deps({ state }))).toEqual([{ dir: 'Profile 4', name: 'Profile 4' }])
  })

  it('never hands back an empty list: Local State missing, unreadable or listing nothing still offers Default', () => {
    expect(profiles(deps({ state: new Error('ENOENT') }))).toEqual([{ dir: 'Default', name: 'Default' }])
    expect(profiles(deps({ state: '{ not json' }))).toEqual([{ dir: 'Default', name: 'Default' }])
    expect(profiles(deps({ state: LAST_USED }))).toEqual([{ dir: 'Default', name: 'Default' }])
  })
})

describe('preselectProfile() — which row the card opens on (spec 14 §3.1)', () => {
  const knob = { [CHROME_PROFILE_ENV]: 'Profile 7' }

  it('takes the pin first: a mount binds one account, and its own pin is the truest guess', () => {
    expect(preselectProfile('Profile 5', 'Profile 6', deps({ env: knob }))).toBe('Profile 5')
  })

  it('then the knob — which now only preselects, so a wrong guess is one keypress away from fixed', () => {
    expect(preselectProfile(undefined, 'Profile 6', deps({ env: knob }))).toBe('Profile 7')
    // An empty knob is not an answer.
    expect(preselectProfile(undefined, 'Profile 6', deps({ env: { [CHROME_PROFILE_ENV]: '  ' } }))).toBe('Profile 6')
  })

  it('then what this submit already chose: three sources in a row are one account, not three questions', () => {
    expect(preselectProfile(undefined, 'Profile 6', deps())).toBe('Profile 6')
  })

  it("then Chrome's own last_used, and Default when there is nothing to go on", () => {
    expect(preselectProfile(undefined, undefined, deps())).toBe('Profile 3')
    expect(preselectProfile(undefined, undefined, deps({ state: new Error('ENOENT') }))).toBe('Default')
    expect(preselectProfile('  ', '  ', deps())).toBe('Profile 3')
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

})

function store(): SourcesStore {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-chrome-'))
  return new SourcesStore({ path: join(dir, 'sources.json'), tasteDir: join(dir, 'taste') })
}

describe('pinning the profile in the entry (spec 14 §3.1)', () => {
  it('writes the resolved profile back into a mount made before murmur named profiles', () => {
    const s = store()
    s.mount('youtube', { browser: 'chrome' })
    expect(s.read().youtube?.profile).toBeUndefined()
    s.pinChromeProfile('youtube', (pinned) => pinned ?? 'Profile 3')
    expect(s.read().youtube?.profile).toBe('Profile 3')
  })

  it('leaves a pin that is already there alone — refresh reads it, it never re-guesses', () => {
    const s = store()
    s.mount('youtube', { browser: 'chrome', profile: 'Default' })
    s.pinChromeProfile('youtube', (pinned) => pinned ?? 'Profile 3')
    expect(s.read().youtube?.profile).toBe('Default')
  })

  it('a fresh mount takes the knob: ticking the row again is how a listener changes profile', () => {
    const s = store()
    s.mount('youtube', { browser: 'chrome', profile: 'Work' })
    s.pinChromeProfile('youtube', (pinned) => pinned ?? 'Default')
    expect(s.read().youtube?.profile).toBe('Work')
  })

  it('touches nothing for a non-Chrome mount or a source that has no browser at all', () => {
    const s = store()
    s.mount('youtube', { browser: 'firefox' })
    s.mount('netease', { auth: 'qr', cookie: 'MUSIC_U=x', userId: '4', likedPlaylistId: '7' })
    s.pinChromeProfile('youtube', () => 'Work')
    s.pinChromeProfile('netease', () => 'Work')
    expect(s.read().youtube?.profile).toBeUndefined()
    // A scanned mount has no browser to pin a profile in.
    expect(s.read().netease).not.toHaveProperty('profile')
  })

  it('does nothing for a source that is not mounted', () => {
    const s = store()
    s.pinChromeProfile('youtube', () => 'Work')
    expect(s.read().youtube).toBeUndefined()
  })
})
