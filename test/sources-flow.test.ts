// The /sources conversation (spec 14 §3.1): a deterministic state machine
// over Host.ask / info with a scripted host and fake platform adapters — no
// model, no network.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SourceAuthWatch } from '../src/music/sources/auth.ts'
import { runSources, SOURCES_OFFER, type BrowserMounts, type SourceMounts, type SourcesFlowDeps } from '../src/music/sources/flow.ts'
import { TasteRefresher } from '../src/music/sources/refresh.ts'
import { BUNDLED_CLIENT_ID, CLIENT_ID_ENV } from '../src/music/sources/spotify.ts'
import { BrowserCookieError } from '../src/music/sources/cookies.ts'
import { CHROME_PROFILE_ENV, type ChromeDeps } from '../src/music/sources/chrome.ts'
import { SourcesStore } from '../src/music/sources/store.ts'
import type { SourceId, TasteSnapshot, TasteSource } from '../src/music/sources/taste.ts'
import { quitLatch } from '../src/setup/guide.ts'
import { FakeHost } from './fakes.ts'

const NOW = new Date('2026-09-06T12:00:00Z')

// Two Chrome profiles, fixed, so the sign-in card is drawn from a file the
// test owns and never from the machine running it. 'Profile 2' is last_used,
// which makes it the row every card here opens on — and '' answers the card
// by taking that row, the plain host's Enter on a preselected list.
const LOCAL_STATE = JSON.stringify({
  profile: { last_used: 'Profile 2', info_cache: { Default: { name: 'Work' }, 'Profile 2': { name: 'Personal' } } },
})
const CHROME: ChromeDeps = { env: {}, platform: 'linux', home: '/home/someone', readFile: () => LOCAL_STATE, exists: () => true }

class FakeSource implements TasteSource {
  readonly id: SourceId
  fail: Error | null = null
  constructor(id: SourceId) {
    this.id = id
  }
  async verify() {
    return { ok: true as const, who: 'me' }
  }
  async snapshot(): Promise<TasteSnapshot> {
    if (this.fail !== null) throw this.fail
    return { source: this.id, takenAt: NOW.toISOString(), items: [{ kind: 'liked', title: 't', artist: 'a' }, { kind: 'playlist', title: 'p' }] }
  }
}

type SpotifyOutcome = 'ok' | 'timeout' | 'esc'

function build(
  lines: string[],
  over: Partial<Omit<SourcesFlowDeps, 'mounts'>> & { mounts?: Partial<SourceMounts>; browser?: Partial<BrowserMounts>; onCookieDrop?: () => void } = {},
  spotifyOutcome: SpotifyOutcome = 'ok',
) {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-flow-'))
  const store = new SourcesStore({ path: join(dir, 'sources.json'), tasteDir: join(dir, 'taste') })
  const host = new FakeHost()
  // Scripted, never EOF: a closed stdin would answer every read with ''
  // ahead of the queued lines (the reader's EOF fast-forward).
  for (const line of lines) host.type(line)
  const watch = new SourceAuthWatch({ store, host })
  const sources = new Map<SourceId, FakeSource>()
  const refresher = new TasteRefresher({ store, source: (id) => sources.get(id) ?? null, watch, host, now: () => NOW })
  const mounted: string[] = []
  const mounts: SourceMounts = {
    browser: {
      youtube: async (b) => (mounted.push(`youtube:${b.browser}:${b.profile ?? ''}`), { ok: true, who: 'Zach G', entry: { browser: b.browser, ...(b.profile !== undefined && { profile: b.profile }) } }),
      netease: async (b) => (mounted.push(`netease:${b.browser}:${b.profile ?? ''}`), { ok: true, who: 'Chen X', entry: { auth: 'browser', browser: b.browser, userId: '1', likedPlaylistId: '2' } }),
      bilibili: async (b) => (mounted.push(`bilibili:${b.browser}:${b.profile ?? ''}`), { ok: true, who: 'Bili', entry: { auth: 'browser', browser: b.browser, mid: '9' } }),
      qqmusic: async (b) => (mounted.push(`qqmusic:${b.browser}:${b.profile ?? ''}`), { ok: true, who: 'Wine', entry: { auth: 'browser', browser: b.browser } }),
      ...over.browser,
    },
    bilibili: async (show, cancelled) => {
      show('https://account.bilibili.com/h5/scan?qrcode_key=k')
      mounted.push('bilibili:qr')
      if (cancelled()) return { ok: false, reason: 'cancelled' }
      return { ok: false, reason: 'login-required' }
    },
    netease: async (show, cancelled) => {
      show('https://music.163.com/login?codekey=k')
      mounted.push('netease:qr')
      if (cancelled()) return { ok: false, reason: 'cancelled' }
      return { ok: true, who: 'Chen X', entry: { auth: 'qr', cookie: 'MUSIC_U=<redacted>', userId: '1', likedPlaylistId: '2' } }
    },
    spotify: async (clientId, hooks) => {
      hooks.onRedirect('http://127.0.0.1:39917/callback')
      hooks.onUrl('https://accounts.spotify.com/authorize?client_id=x')
      mounted.push(`spotify:${clientId}`)
      if (spotifyOutcome === 'esc') {
        host.pressEsc()
        return hooks.cancelled() ? { ok: false, reason: 'cancelled' } : { ok: true, who: 'x', entry: { clientId, refreshToken: 'r', accessToken: 'a', expiresAt: 'x' } }
      }
      return spotifyOutcome === 'timeout' ? { ok: false, reason: 'timeout' } : { ok: true, who: 'Listener', entry: { clientId, refreshToken: 'r', accessToken: 'a', expiresAt: 'x' } }
    },
    qqmusic: async (show) => (show('https://open.weixin.qq.com/connect/confirm?uuid=u'), mounted.push('qqmusic:qr'), { ok: true, who: 'Wine', entry: { auth: 'qr', cookie: 'uin=1; qm_keyst=<redacted>; euin=e' } }),
    qishui: async (show, cancelled) => {
      show('https://example.com/qr')
      mounted.push('qishui')
      if (cancelled()) return { ok: false, reason: 'cancelled' }
      return { ok: true, who: 'Soda Listener', entry: { sessionCookie: 's', deviceId: 'd', installId: 'i' } }
    },
    ...over.mounts,
  }
  const { mounts: _mounts, browser: _browser, onCookieDrop, ...rest } = over
  const deps: SourcesFlowDeps = {
    host,
    store,
    quit: quitLatch(),
    refresher,
    watch,
    mounts,
    build: (id) => {
      const s = new FakeSource(id)
      sources.set(id, s)
      return s
    },
    platform: 'linux',
    now: () => NOW,
    chrome: CHROME,
    forgetCookies: onCookieDrop ?? (() => {}),
    ...rest,
  }
  return { store, host, mounted, deps, sources }
}

describe('runSources (spec 14 §3.1)', () => {
  it('opens with the status, offers the menu, and done leaves', async () => {
    const { host, deps, store } = build([''])
    await runSources(deps)
    // The status lives IN the card text: the TUI floats the card over the
    // log, so a status printed as info sat exactly where the card hid it
    // (user screenshot: 'available: You' cut off, no name left to type).
    expect(host.infos).toEqual([])
    const menu = host.asks[0]!.text.split('\n')
    expect(menu[0]).toBe('which accounts should I read? Enter with nothing changed leaves')
    // The same rows numbered in the text, for a host without a list surface.
    expect(menu.slice(1)).toEqual([
      '>> 1) [ ] YouTube - not connected',
      '>> 2) [ ] Bilibili - not connected',
      '>> 3) [ ] NetEase - not connected',
      '>> 4) [ ] Spotify - not connected',
      '>> 5) [ ] Soda Music - not connected',
      '>> 6) [ ] QQ Music - not connected',
    ])
    expect(host.asks[0]!.kind).toBe('question')
    // The rows to tick (spec 10 §3.2-D): nothing mounted, so nothing ticked
    // and no refresh row.
    expect(host.asks[0]!.choices).toEqual({
      options: [
        { key: 'youtube', label: 'YouTube', note: 'not connected', checked: false },
        { key: 'bilibili', label: 'Bilibili', note: 'not connected', checked: false },
        { key: 'netease', label: 'NetEase', note: 'not connected', checked: false },
        { key: 'spotify', label: 'Spotify', note: 'not connected', checked: false },
        { key: 'qishui', label: 'Soda Music', note: 'not connected', checked: false },
        { key: 'qqmusic', label: 'QQ Music', note: 'not connected', checked: false },
      ],
      multi: true,
    })
    expect(store.busy).toBe(false)
  })

  it('mounts a cookie source once the profile is picked: Chrome is read, verified, snapshotted, said', async () => {
    const { host, deps, store, mounted } = build(['youtube', '', 'youtube'], { platform: 'darwin' })
    await runSources(deps)
    // The browser question is gone entirely — murmur reads the one browser
    // it also opens for signing in, so there is nothing to get wrong.
    expect(host.asks.some((a) => /which browser/i.test(a.text))).toBe(false)
    // Chrome is read by a NAMED profile, whatever this machine's is: bare
    // `chrome` let yt-dlp pick the newest Cookies file of any profile.
    expect(mounted[0]).toMatch(/^youtube:chrome:.+$/)
    expect(host.infos).toContain('signed in as Zach G')
    expect(host.infos.some((l) => /^done — 2 items from YouTube; I'll keep it fresh\.$/.test(l))).toBe(true)
    expect(store.read().youtube).toMatchObject({ browser: 'chrome', status: 'ok', profile: expect.any(String) })
    expect(store.readSnapshot('youtube')?.items).toHaveLength(2)
    // The profile is in the log, so a listener's report says which one it read.
    expect(host.debugs.some((l) => /^sources\.mount youtube profile=.+$/.test(l))).toBe(true)
    // Back at the menu: the result is a status row IN the card (never an
    // info line the card then covers — #231), the mounted one is ticked
    // with its counts, and the refresh row appears.
    const menu = host.asks.at(-1)!.text.split('\n')
    expect(menu[1]).toBe('ok connected YouTube — signed in as Zach G · 1 liked, 1 playlist')
    expect(menu).toContain('>> 1) [x] YouTube - 1 liked, 1 playlist · read just now')
    expect(menu).toContain('>> 3) [ ] NetEase - not connected')
    // Refresh is an ACTION, not a state (spec 14 §3.1, 2026-09-16): no box
    // to tick, on the card or in the numbered rows a plain host reads.
    expect(menu).toContain('>> 7) ( refresh now ) - re-read every connected account now')
    expect(menu.some((row) => /refresh/.test(row) && /\[[ x]\]/.test(row))).toBe(false)
    const options = host.asks.at(-1)!.choices!.options!
    expect(options[0]).toEqual({ key: 'youtube', label: 'YouTube', note: '1 liked, 1 playlist · read just now', checked: true })
    expect(options.at(-1)).toEqual({ key: 'refresh', label: 'refresh now', note: 're-read every connected account now', checked: false, action: true })
  })

  // spec 14 §2.3: Bilibili's snapshot is a watch history and a follow list
  // now, so the row has to count those — "1 liked" for an account with 200
  // watched rows is the card telling the listener nothing.
  it('the menu row counts what the snapshot actually holds, watches and follows included', async () => {
    const { host, deps, store } = build(['bilibili'])
    store.mount('bilibili', { browser: 'chrome', mid: '4486056' })
    store.writeSnapshot({
      source: 'bilibili',
      takenAt: NOW.toISOString(),
      items: [
        { kind: 'history', title: 'a city pop set' },
        { kind: 'history', title: 'braised pork' },
        { kind: 'follows', title: 'Night Tape' },
        { kind: 'frequents', title: 'Night Tape' },
        { kind: 'liked', title: 'My upload' },
      ],
    })
    await runSources(deps)
    expect(host.asks.at(-1)!.text.split('\n').find((l) => l.includes('Bilibili'))).toBe('>> 2) [x] Bilibili - 1 liked, 2 watched, 1 followed · never read')
  })

  it('a remount drops the previous account\'s snapshot before reading the new one', async () => {
    // A signed-in mount is not re-run from the list; an expired one is
    // renewed by refresh, and that is the remount.
    const { host, deps, store } = build(['netease refresh', 'scan', 'netease'])
    store.mount('netease', { browser: 'chrome', userId: 'old', likedPlaylistId: '1' })
    store.setStatus('netease', 'expired')
    store.writeSnapshot({ source: 'netease', takenAt: '2026-09-01T00:00:00.000Z', items: [{ kind: 'liked', title: 'the old account' }] })
    // The first read of the new account fails: better no taste than the
    // previous account's taste under a fresh mount date.
    deps.build = () => {
      const source = new FakeSource('netease')
      source.fail = new Error('down')
      return source
    }
    await runSources(deps)
    expect(store.readSnapshot('netease')).toBeNull()
    expect(store.read().netease?.userId).toBe('1')
    expect(host.infos.some((l) => l.includes('could not read NetEase right now'))).toBe(true)
  })

  it('no login opens the sign-in page in Chrome and waits, instead of sending the listener away', async () => {
    const dropped: number[] = []
    const opened: string[] = []
    // First read finds no login; after the listener signs in and presses
    // Enter, the second read finds one.
    let attempt = 0
    const { host, deps, store } = build(['youtube', '', '', 'youtube'], {
      onCookieDrop: () => dropped.push(1),
      openUrl: (url) => opened.push(url),
      browser: {
        youtube: async () => (attempt++ === 0 ? { ok: false, reason: 'login-required' } : { ok: true, who: 'Zach G', entry: { browser: 'chrome' } }),
      },
    })
    await runSources(deps)
    expect(opened).toEqual(['https://accounts.google.com/ServiceLogin?service=youtube'])
    expect(host.infos.some((l) => /opened YouTube in Chrome/.test(l))).toBe(true)
    expect(host.asks.some((a) => /press enter/i.test(a.text))).toBe(true)
    // The cached export is dropped, or the retry would answer from the read
    // taken before they signed in.
    expect(dropped).toHaveLength(1)
    expect(host.infos).toContain('signed in as Zach G')
    expect(store.read().youtube).toMatchObject({ browser: 'chrome', status: 'ok' })
  })

  it('still no login after the wait says so plainly and writes nothing', async () => {
    const { host, deps, store } = build(['youtube', '', '', ''], {
      openUrl: () => {},
      browser: { youtube: async () => ({ ok: false, reason: 'login-required' }) },
    })
    await runSources(deps)
    expect(host.infos).toContain('still no YouTube login in Chrome — /sources when you have signed in.')
    expect(store.read()).toEqual({})
  })

  // The four lies: a browser that is not installed, a cookie store the
  // terminal may not read, and a missing yt-dlp all used to read as "you are
  // not signed in", which is advice that cannot work.
  it('names the real obstacle when the cookie store cannot be read at all', async () => {
    const cases = [
      ['no-browser', /I could not find Chrome/],
      ['no-permission', /Full Disk Access|permission/i],
      ['no-ytdlp', /yt-dlp/],
      // A yt-dlp that never came back: the kill leaves no jar and no words of
      // its own, so it used to be quoted at the listener as an unreadable
      // store. The timeout's own sentence carries instead (user report).
      ['timed-out', /yt-dlp said so Either way, \/sources again once it is moving\./],
    ] as const
    for (const [reason, matcher] of cases) {
      const { host, deps, store } = build(['youtube', '', ''], {
        platform: 'darwin',
        browser: {
          youtube: async () => {
            throw new BrowserCookieError('chrome', reason, 'yt-dlp said so')
          },
        },
      })
      await runSources(deps)
      expect(host.infos.some((l) => matcher.test(l))).toBe(true)
      // Never the advice that cannot work.
      expect(host.infos.some((l) => /sign in there/.test(l))).toBe(false)
      expect(store.read()).toEqual({})
      // The obstacle is a gap row in the next card, in obstacleLine's words.
      const row = host.asks.at(-1)!.text.split('\n')[1]!
      expect(row.startsWith('-- could not connect YouTube — ')).toBe(true)
      expect(matcher.test(row)).toBe(true)
    }
  })

  // "checking YouTube in Chrome..." against a yt-dlp that never answers: the
  // wait did not look at the latch, so Esc did nothing and the only way out
  // was killing murmur (user report). The stop now lands while the mount is
  // still in flight, and the account it was about to verify is not written.
  it('an Esc while the cookie mount is in flight stops it and writes nothing', async () => {
    const { host, deps, store } = build(['youtube', '', ''], {
      browser: {
        // A yt-dlp hung on a slow network or a keychain prompt behind another
        // window: the call simply never settles.
        youtube: () => (host.pressEsc(), new Promise(() => {})),
      },
    })
    await runSources(deps)
    expect(store.read()).toEqual({})
    expect(host.infos.some((l) => /signed in as/.test(l))).toBe(false)
    expect(host.asks.at(-1)!.text.split('\n')[1]).toBe('-- could not connect YouTube — stopped — nothing was written')
  })

  // A profile named by MURMUR_CHROME_PROFILE that Chrome has never opened is
  // the same thing to a listener as not being signed in: Chrome makes the
  // profile when it opens the sign-in page in it, so it is the sign-in path.
  it('a profile Chrome has never opened takes the sign-in path, not an obstacle', async () => {
    const opened: string[] = []
    const dropped: number[] = []
    let attempt = 0
    const { host, deps, store } = build(['youtube', '', '', 'youtube'], {
      platform: 'darwin',
      openUrl: (url) => opened.push(url),
      onCookieDrop: () => dropped.push(1),
      browser: {
        youtube: async () => {
          if (attempt++ === 0) throw new BrowserCookieError('chrome', 'no-profile', 'could not find chrome cookies database in "/x/Chrome/Murmur Fresh"', 'Murmur Fresh')
          return { ok: true, who: 'Zach G', entry: { browser: 'chrome' } }
        },
      },
    })
    await runSources(deps)
    expect(opened).toEqual(['https://accounts.google.com/ServiceLogin?service=youtube'])
    expect(host.asks.some((a) => /press enter/i.test(a.text))).toBe(true)
    expect(dropped).toHaveLength(1)
    expect(host.infos.some((l) => /no profile named/.test(l))).toBe(false)
    expect(host.infos).toContain('signed in as Zach G')
    expect(store.read().youtube).toMatchObject({ browser: 'chrome', status: 'ok' })
  })

  it('a profile still absent after the wait ends in the plain no-login word', async () => {
    const { host, deps, store } = build(['youtube', '', '', ''], {
      platform: 'darwin',
      openUrl: () => {},
      browser: {
        youtube: async () => {
          throw new BrowserCookieError('chrome', 'no-profile', 'could not find chrome cookies database in "/x/Chrome/Murmur Fresh"', 'Murmur Fresh')
        },
      },
    })
    await runSources(deps)
    expect(host.infos).toContain('still no YouTube login in Chrome — /sources when you have signed in.')
    expect(host.infos.some((l) => /no profile named/.test(l))).toBe(false)
    expect(store.read()).toEqual({})
  })

  // The bundled id is what an unconfigured machine mounts on — so the two
  // tests below own the variable outright rather than reading whatever the
  // developer running them has set.
  const withClientIdEnv = async (value: string | undefined, body: () => Promise<void>): Promise<void> => {
    const before = process.env[CLIENT_ID_ENV]
    if (value === undefined) delete process.env[CLIENT_ID_ENV]
    else process.env[CLIENT_ID_ENV] = value
    try {
      await body()
    } finally {
      if (before === undefined) delete process.env[CLIENT_ID_ENV]
      else process.env[CLIENT_ID_ENV] = before
    }
  }

  it('Esc during the sign-in wait cancels: nothing is re-read and nothing is written', async () => {
    // Esc and Enter both hand back an empty line, so the flow has to consult
    // the cancel latch — or an Esc would mount the account anyway.
    let attempts = 0
    let escape: () => void = () => {}
    const built = build(['youtube', '', '', ''], {
      openUrl: () => {},
      browser: {
        youtube: async () => {
          attempts++
          if (attempts === 1) {
            escape()
            return { ok: false, reason: 'login-required' }
          }
          return { ok: true, who: 'Zach G', entry: { browser: 'chrome' } }
        },
      },
    })
    const { host, deps, store } = built
    escape = () => host.pressEsc()
    await runSources(deps)
    expect(attempts).toBe(1)
    expect(store.read()).toEqual({})
    expect(host.infos).not.toContain('signed in as Zach G')
  })

  it('an unreadable cookie store quotes yt-dlp rather than claiming Chrome is missing', async () => {
    const { host, deps } = build(['youtube', '', ''], {
      platform: 'win32',
      browser: {
        youtube: async () => {
          throw new BrowserCookieError('chrome', 'unreadable', 'ERROR: Failed to decrypt with DPAPI')
        },
      },
    })
    await runSources(deps)
    expect(host.infos.some((l) => /DPAPI/.test(l))).toBe(true)
    expect(host.infos.some((l) => /could not find Chrome/i.test(l))).toBe(false)
  })

  // yt-dlp reads "the most recently accessed profile" when none is named, so
  // a second Chrome profile can silently move a mount to another account.
  // The question used to let a listener pin one; the environment does now.
  it('pins the Chrome profile named in the environment', async () => {
    const before = process.env[CHROME_PROFILE_ENV]
    process.env[CHROME_PROFILE_ENV] = 'Profile 2'
    try {
      const { deps, store } = build(['youtube', '', 'youtube'])
      await runSources(deps)
      expect(store.read().youtube).toMatchObject({ browser: 'chrome', profile: 'Profile 2' })
    } finally {
      if (before === undefined) delete process.env[CHROME_PROFILE_ENV]
      else process.env[CHROME_PROFILE_ENV] = before
    }
  })

  it('mounts Spotify straight into the browser: no app to register, no client id asked for', async () => {
    // The one thing asked is which Chrome profile the consent page opens in.
    const { host, deps, store, mounted } = build(['spotify', '', 'spotify'])
    await withClientIdEnv(undefined, () => runSources(deps))
    // The developer-portal walkthrough and its question are both gone: the
    // bundled client id carries the read-only scopes on its own.
    expect(host.infos.some((l) => l.includes('developer.spotify.com'))).toBe(false)
    expect(host.asks.some((a) => /client id/i.test(a.text))).toBe(false)
    expect(mounted).toEqual([`spotify:${BUNDLED_CLIENT_ID}`])
    expect(host.infos).toContain('signed in as Listener')
    expect(store.read().spotify).toMatchObject({ clientId: BUNDLED_CLIENT_ID, status: 'ok' })
  })

  it('a listener with their own app overrides the bundled client id through the environment', async () => {
    const { deps, mounted } = build(['spotify', '', 'spotify'])
    await withClientIdEnv('client-of-their-own', () => runSources(deps))
    expect(mounted).toEqual(['spotify:client-of-their-own'])
  })

  it('a Spotify callback that never arrives is the §3.7 line; the consent URL is printed either way', async () => {
    const { host, deps, store } = build(['spotify', '', ''], {}, 'timeout')
    await runSources(deps)
    expect(host.infos).toContain("didn't hear back from Spotify — /sources to try again.")
    expect(host.infos.some((l) => l.includes('https://accounts.spotify.com/authorize'))).toBe(true)
    expect(store.read()).toEqual({})
  })

  it('Esc during the Spotify wait cancels and writes nothing', async () => {
    const { host, deps, store } = build(['spotify', '', ''], {}, 'esc')
    await runSources(deps)
    expect(host.infos).toContain('cancelled — nothing was written.')
    expect(store.read()).toEqual({})
  })

  it('mounts Soda: the QR on the unlogged surface, the Douyin instruction, who', async () => {
    const { host, deps, store, mounted } = build(['soda', 'soda'])
    await runSources(deps)
    expect(mounted).toEqual(['qishui'])
    // The QR encodes an authorization URL, so it goes to the notice card only
    // — host.info mirrors into the diagnostics a /bug report attaches (§3.6).
    const qr = host.notices.find((n) => n.body.some((row) => row.includes('█')))!
    expect(qr.body.length).toBeGreaterThan(10)
    expect(host.infos.join('\n')).not.toContain('█')
    expect(host.infos.some((l) => /Douyin/.test(l))).toBe(true)
    expect(store.read().qishui).toMatchObject({ sessionCookie: 's', status: 'ok' })
  })

  // NetEase and Bilibili mount by scanning, exactly as Soda does — no
  // browser, so none of the browser obstacles can reach this path (#221).
  it('mounts NetEase by scan: the code on the unlogged surface, the app named, no browser anywhere', async () => {
    const { host, deps, store, mounted } = build(['netease', 'scan', 'netease'])
    await runSources(deps)
    expect(mounted).toEqual(['netease:qr'])
    expect(host.notices.find((n) => n.body.some((row) => row.includes('█')))!.body.length).toBeGreaterThan(10)
    expect(host.infos.join('\n')).not.toContain('█')
    expect(host.infos.some((l) => /open the NetEase Cloud Music app/.test(l))).toBe(true)
    expect(host.infos.some((l) => /Chrome/.test(l))).toBe(false)
    expect(host.infos).toContain('signed in as Chen X')
    expect(store.read().netease).toMatchObject({ auth: 'qr', status: 'ok' })
    // §3.6: the code's URL and the cookie are authorization artifacts, and
    // the diagnostics a /bug report attaches must carry neither.
    const log = [...host.debugs, ...host.infos].join('\n')
    expect(log).not.toContain('codekey')
    expect(log).not.toContain('MUSIC_U')
    expect(host.debugs).toContain('sources.mount netease')
  })

  it('mounts Bilibili by scan, and a code nobody scans is a timeout with nothing written', async () => {
    const { host, deps, store } = build(['bilibili', 'scan', ''], {
      mounts: { bilibili: async (show) => (show('https://account.bilibili.com/h5/scan?qrcode_key=k'), { ok: false, reason: 'timeout' }) },
    })
    await runSources(deps)
    expect(host.infos.some((l) => /open the Bilibili app/.test(l))).toBe(true)
    expect(host.infos).toContain('the code timed out — /sources to get a fresh one.')
    expect(store.read()).toEqual({})
    expect([...host.debugs, ...host.infos].join('\n')).not.toContain('qrcode_key')
  })

  it('Esc during a NetEase scan cancels and writes nothing', async () => {
    const { host, deps, store } = build(['netease', 'scan', ''], {
      mounts: {
        netease: async (show, cancelled) => {
          show('https://music.163.com/login?codekey=k')
          host.pressEsc()
          return cancelled() ? { ok: false, reason: 'cancelled' } : { ok: true, who: 'Chen X', entry: { auth: 'qr', cookie: 'c', userId: '1', likedPlaylistId: '2' } }
        },
      },
    })
    await runSources(deps)
    expect(host.infos).toContain('cancelled — nothing was written.')
    expect(store.read()).toEqual({})
  })

  it('Esc while the scan is confirming writes nothing, even though the sign-in itself succeeded', async () => {
    const { host, deps, store } = build(['netease', 'scan', ''], {
      mounts: {
        // The platform confirms, but the listener pressed Esc while the poll
        // and the account read were in flight (codex review).
        netease: async (show) => {
          show('https://music.163.com/login?codekey=k')
          host.pressEsc()
          return { ok: true, who: 'Chen X', entry: { auth: 'qr', cookie: 'MUSIC_U=<redacted>', userId: '1', likedPlaylistId: '2' } }
        },
      },
    })
    await runSources(deps)
    expect(store.read()).toEqual({})
    expect(host.infos).not.toContain('signed in as Chen X')
  })

  it('a typed /quit while a scan is waiting stops it and writes nothing', async () => {
    const quit = quitLatch()
    let seenByTheScan: boolean | undefined
    const { host, deps, store } = build(['netease', 'scan', ''], {
      quit,
      mounts: {
        // The engine fires the latch as the /quit arrives — no read is open
        // during a scan, so the flag the scan polls is the only way out.
        netease: async (show, cancelled) => {
          show('https://music.163.com/login?codekey=k')
          quit.fire()
          seenByTheScan = cancelled()
          return cancelled() ? { ok: false, reason: 'cancelled' } : { ok: true, who: 'Chen X', entry: { auth: 'qr', cookie: 'c', userId: '1', likedPlaylistId: '2' } }
        },
      },
    })
    await runSources(deps)
    expect(seenByTheScan).toBe(true)
    expect(host.infos).toContain('cancelled — nothing was written.')
    expect(store.read()).toEqual({})
  })

  it('a typed /quit while Spotify consent is pending stops the wait and writes nothing', async () => {
    const quit = quitLatch()
    let seenByTheWait: boolean | undefined
    const { deps, store } = build(['spotify', '', ''], {
      quit,
      mounts: {
        spotify: async (clientId, hooks) => {
          hooks.onUrl('https://accounts.spotify.com/authorize?client_id=x')
          quit.fire()
          seenByTheWait = hooks.cancelled()
          return seenByTheWait
            ? { ok: false, reason: 'cancelled' }
            : { ok: true, who: 'Listener', entry: { clientId, refreshToken: 'r', accessToken: 'a', expiresAt: 'x' } }
        },
      },
    })
    await runSources(deps)
    expect(seenByTheWait).toBe(true)
    expect(store.read()).toEqual({})
  })

  it('refuses a NetEase or Bilibili mount on a host that cannot show a line off the record', async () => {
    for (const id of ['netease', 'bilibili'] as const) {
      const { host, deps, store, mounted } = build([id, 'scan', ''])
      host.notice = undefined
      await runSources(deps)
      expect(mounted).toEqual([])
      expect(host.infos.some((l) => /cannot show the code here/.test(l))).toBe(true)
      expect(store.read()).toEqual({})
    }
  })

  it('refuses the Soda mount on a host that cannot show a line off the record', async () => {
    const { host, deps, store, mounted } = build(['soda', ''])
    host.notice = undefined
    await runSources(deps)
    expect(mounted).toEqual([])
    expect(host.infos.some((l) => /cannot show the code here/.test(l))).toBe(true)
    expect(store.read()).toEqual({})
  })

  // The bug this card exists for (2026-09-15, screenshot-verified): drawn as
  // an `info` line the 25-row Bilibili code landed in a program log with ~8
  // rows under the portrait, so the listener came back from their phone to
  // half a code with the instruction scrolled off above it.
  it('draws the scan code in a notice card — progress in the title, the way out in the footer', async () => {
    const { host, deps } = build(['netease bilibili', 'scan', 'scan', 'netease bilibili'], {
      mounts: {
        bilibili: async (show) => {
          show('https://account.bilibili.com/h5/scan?qrcode_key=k')
          return { ok: true, who: 'Bili Listener', entry: { auth: 'qr', cookie: 'c', mid: '1' } }
        },
      },
    })
    await runSources(deps)
    const drawn = host.notices.filter((n) => n.body.length > 0)
    expect(drawn.map((n) => n.title)).toEqual([
      '1/2 Bilibili — scan with the Bilibili app',
      '2/2 NetEase — scan with the NetEase Cloud Music app',
    ])
    for (const card of drawn) {
      expect(card.footer).toBe('waiting for the scan · esc - cancel')
      // Verbatim half-block rows, wide enough to scan — never wrapped.
      expect(card.body.length).toBeGreaterThan(10)
      expect(card.body.every((row) => /^[█▀▄ ]+$/.test(row))).toBe(true)
    }
    // Each card is closed when its mount ends, so no dead code is left up.
    expect(host.notices.filter((n) => n.body.length === 0)).toHaveLength(2)
    // And the code itself reached neither the program log nor the diagnostics.
    expect([...host.infos, ...host.debugs, ...host.asks.map((a) => a.text)].join('\n')).not.toContain('█')
  })

  it('a single mount carries no counter, and a scanned code says to confirm on the phone', async () => {
    const { host, deps } = build(['netease', 'scan', 'netease'], {
      mounts: {
        netease: async (show, _cancelled, onStatus) => {
          show('https://music.163.com/login?codekey=k')
          onStatus('scanned')
          return { ok: true, who: 'Chen X', entry: { auth: 'qr', cookie: 'c', userId: '1', likedPlaylistId: '2' } }
        },
      },
    })
    await runSources(deps)
    const drawn = host.notices.filter((n) => n.body.length > 0)
    expect(drawn.map((n) => n.title)).toEqual([
      'NetEase — scan with the NetEase Cloud Music app',
      'NetEase — scan with the NetEase Cloud Music app',
    ])
    expect(drawn.map((n) => n.footer)).toEqual(['waiting for the scan · esc - cancel', 'scanned — confirm on your phone'])
    // The body is redrawn unchanged: only the footer moved.
    expect(drawn[1]!.body).toEqual(drawn[0]!.body)
  })

  it('Esc during the QR wait cancels and writes nothing', async () => {
    const { host, deps, store } = build(['qishui', ''], {
      mounts: {
        qishui: async (show, cancelled) => {
          show('https://example.com/qr')
          host.pressEsc()
          return cancelled() ? { ok: false, reason: 'cancelled' } : { ok: true, who: 'x', entry: { sessionCookie: 's', deviceId: 'd', installId: 'i' } }
        },
      },
    })
    await runSources(deps)
    expect(store.read()).toEqual({})
    expect(host.infos.some((l) => /cancelled/.test(l))).toBe(true)
  })

  // The button is drawn `( refresh now )`, so that is what a plain-host
  // listener types — and one word the flow cannot place fails the WHOLE line
  // (codex review), which would have left them typing a row they can read.
  it('takes the refresh row typed as it is drawn, two words and all', async () => {
    const { host, deps, store, sources } = build(['netease refresh now', 'netease'])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    sources.set('netease', new FakeSource('netease'))
    await runSources(deps)
    expect(host.infos.some((l) => /didn't catch/.test(l))).toBe(false)
    expect(host.asks[1]!.text.split('\n')[1]).toBe('ok refreshed NetEase — 2 items')
  })

  it('refresh re-reads every mounted source in the foreground with counts; unmount deletes entry and snapshot', async () => {
    // Ticking refresh re-reads; unticking both then leaves nothing ticked,
    // and the empty submit is that — not an exit — on a host with a list.
    const { host, deps, store, sources } = build(['netease spotify refresh', '', ''])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' })
    sources.set('netease', new FakeSource('netease'))
    const sp = new FakeSource('spotify')
    sp.fail = new Error('down')
    sources.set('spotify', sp)
    await runSources(deps)
    expect(host.infos).toContain('NetEase: 2 items')
    expect(host.infos).toContain('Spotify: could not read it (down)')
    expect(host.infos).toContain('NetEase unmounted; its snapshot is gone.')
    expect(host.infos.some((l) => l.startsWith('Spotify unmounted') && /no remote revoke/.test(l))).toBe(true)
    expect(store.read()).toEqual({})
    // Each result is a row in the card that follows it.
    const afterRefresh = host.asks[1]!.text.split('\n')
    expect(afterRefresh.slice(1, 3)).toEqual(['ok refreshed NetEase — 2 items', '-- could not refresh Spotify — could not read it (down)'])
    const afterUnmount = host.asks[2]!.text.split('\n')
    expect(afterUnmount[1]).toBe('ok disconnected NetEase — its snapshot is gone.')
    expect(afterUnmount[2]!.startsWith('ok disconnected Spotify — its tokens are dropped here')).toBe(true)
    expect(host.asks).toHaveLength(3)
  })

  it('with everything mounted the menu is all status rows — no option left, still the menu', async () => {
    const { host, deps, store } = build(['youtube bilibili netease spotify qishui qqmusic'])
    store.mount('youtube', { browser: 'chrome' })
    store.mount('bilibili', { browser: 'chrome', mid: '7' })
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' })
    store.mount('qishui', { sessionCookie: 's', deviceId: 'd', installId: 'i' })
    store.mount('qqmusic', { browser: 'chrome' })
    await runSources(deps)
    const menu = host.asks[0]!.text.split('\n')
    expect(menu.filter((l) => l.startsWith('>> ') && l.includes('[x]'))).toHaveLength(6)
    expect(host.asks[0]!.choices!.options!.map((o) => o.checked)).toEqual([true, true, true, true, true, true, false])
    // The unchanged submit leaves: one card, nothing done.
    expect(host.asks).toHaveLength(1)
    expect(host.infos).toEqual([])
  })

  it('lists an expired mount as one to renew', async () => {
    // An expired login stays ticked (it is mounted): an unchanged submit
    // leaves it alone, unticking forgets it, refresh signs it in again.
    const { host, deps, store, mounted } = build(['netease'])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.setStatus('netease', 'expired')
    await runSources(deps)
    expect(host.asks[0]!.text.split('\n')).toContain('>> 3) [x] NetEase - expired — untick to forget it, tick refresh to sign in again')
    expect(host.asks).toHaveLength(1)
    expect(mounted).toEqual([])
    expect(store.read().netease?.status).toBe('expired')
    // Forgetting needs no sign-in: the entry and the snapshot go (codex review).
    const forget = build(['', ''])
    forget.store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    forget.store.setStatus('netease', 'expired')
    await runSources(forget.deps)
    expect(forget.store.read()).toEqual({})
    expect(forget.mounted).toEqual([])
    const renew = build(['netease refresh', 'scan', 'netease'])
    renew.store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    renew.store.setStatus('netease', 'expired')
    await runSources(renew.deps)
    expect(renew.mounted).toEqual(['netease:qr'])
    expect(renew.store.read().netease?.status).toBe('ok')
    expect(renew.host.asks.at(-1)!.text.split('\n')[1]).toBe('ok connected NetEase — signed in as Chen X · 1 liked, 1 playlist')
  })

  it('a line it does not understand asks again with the miss in the card; /quit leaves through the latch', async () => {
    const { host, deps, mounted } = build(['what', ''])
    await runSources(deps)
    // In the card, not under it (#231): the log keeps a copy.
    expect(host.asks[1]!.text.split('\n')[1]).toBe('-- I didn\'t catch "what" — numbers or names from the list')
    expect(host.infos.some((l) => /didn't catch/.test(l))).toBe(true)
    expect(mounted).toEqual([])
    const quitting = build(['/quit'])
    await runSources(quitting.deps)
    expect(quitting.deps.quit.requested).toBe(true)
  })

  it('holds the store for the whole conversation and hands the interrupt seam back', async () => {
    let busyDuring: boolean | null = null
    const { deps, store, host } = build(['netease', 'scan', 'netease'], {
      build: (id) => {
        busyDuring = store.busy
        return new FakeSource(id)
      },
    })
    await runSources(deps)
    expect(busyDuring).toBe(true)
    expect(store.busy).toBe(false)
    host.pressEsc() // nothing registered any more: noise
  })

  it('a submit with two new ticks mounts them in row order, each result a row in the next card', async () => {
    const { host, deps, store, mounted } = build(['spotify netease', 'scan', '', 'netease spotify'])
    await runSources(deps)
    expect(mounted).toEqual(['netease:qr', `spotify:${BUNDLED_CLIENT_ID}`])
    expect(store.mounted()).toEqual(['netease', 'spotify'])
    const rows = host.asks.at(-1)!.text.split('\n')
    expect(rows.slice(1, 3)).toEqual([
      'ok connected NetEase — signed in as Chen X · 1 liked, 1 playlist',
      'ok connected Spotify — signed in as Listener · 1 liked, 1 playlist',
    ])
    expect(host.asks).toHaveLength(4)
  })

  it('unticking a mounted one unmounts it; the rest are left alone', async () => {
    const { host, deps, store, mounted } = build(['spotify', 'spotify'])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' })
    await runSources(deps)
    expect(mounted).toEqual([])
    expect(store.mounted()).toEqual(['spotify'])
    expect(host.asks[1]!.text.split('\n')[1]).toBe('ok disconnected NetEase — its snapshot is gone.')
  })

  it('a mount that fails leaves its reason as a gap row, and a stopped one says so', async () => {
    const failing = build(['spotify', '', ''], {}, 'timeout')
    await runSources(failing.deps)
    expect(failing.host.asks.at(-1)!.text.split('\n')[1]).toBe("-- could not connect Spotify — didn't hear back from Spotify — /sources to try again.")
    // Esc mid-mount stops the rest of the submit: Soda was still to come.
    const stopped = build(['spotify soda', '', ''], {}, 'esc')
    await runSources(stopped.deps)
    expect(stopped.mounted).toEqual([`spotify:${BUNDLED_CLIENT_ID}`])
    expect(stopped.host.asks.at(-1)!.text.split('\n')[1]).toBe('-- could not connect Spotify — stopped — nothing was written')
  })

  it('Esc during a refresh ends the submit before the mounts that were still to come (codex review)', async () => {
    const { host, deps, store, mounted, sources } = build(['youtube netease refresh', 'youtube'])
    store.mount('youtube', { browser: 'chrome' })
    const yt = new FakeSource('youtube')
    yt.snapshot = async () => {
      host.pressEsc()
      return { source: 'youtube', takenAt: NOW.toISOString(), items: [] }
    }
    sources.set('youtube', yt)
    await runSources(deps)
    expect(mounted).toEqual([])
    expect(store.mounted()).toEqual(['youtube'])
  })

  it('sources that fail for one reason share one row, so three failures fit an 80x24 card (codex review)', async () => {
    const { host, deps, store } = build(['youtube bilibili netease', '', 'scan', 'scan', ''], {
      platform: 'darwin',
      browser: {
        youtube: async () => {
          throw new BrowserCookieError('chrome', 'no-permission', '')
        },
      },
      mounts: {
        bilibili: async (show) => (show('https://account.bilibili.com/h5/scan?qrcode_key=k'), { ok: false, reason: 'timeout' }),
        netease: async (show) => (show('https://music.163.com/login?codekey=k'), { ok: false, reason: 'timeout' }),
      },
    })
    await runSources(deps)
    const rows = host.asks.at(-1)!.text.split('\n').filter((l) => l.startsWith('-- '))
    // Two kinds of failure, two rows: YouTube's browser obstacle, and the
    // two codes that timed out — which share one row because they end the
    // same way.
    expect(rows).toHaveLength(2)
    expect(rows[0]!.startsWith('-- could not connect YouTube — Chrome is here, but I am not allowed')).toBe(true)
    expect(rows[1]).toBe('-- could not connect Bilibili, NetEase — the code timed out — /sources to get a fresh one.')
    expect(store.read()).toEqual({})
  })

  it('Esc on the menu leaves without touching anything — the empty line it produces is not an empty selection', async () => {
    const { host, deps, store } = build([])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    const run = runSources(deps)
    await new Promise((r) => setTimeout(r, 0))
    host.pressEsc()
    await run
    expect(store.mounted()).toEqual(['netease'])
    expect(host.asks).toHaveLength(1)
  })

  it('on a host without a list surface the numbers and the names both pick, and Enter leaves', async () => {
    // The plain front-end (TUI=0): the ask falls back to info, the rows are
    // numbered in the text, and the listener types numbers or names.
    for (const answer of ['3', 'netease', 'NetEase']) {
      const { host, deps, store, mounted } = build([answer, 'scan', ''])
      Object.defineProperty(host, 'ask', { value: undefined })
      await runSources(deps)
      expect(mounted).toEqual(['netease:qr'])
      expect(store.mounted()).toEqual(['netease'])
      // Enter on the plain host keeps things as they are — there is no
      // selection to submit, so '' cannot mean "nothing ticked".
      expect(store.mounted()).toEqual(['netease'])
      const menus = host.infos.filter((l) => l.startsWith('which accounts'))
      expect(menus).toHaveLength(2)
      expect(menus[0]).toContain('>> 3) [ ] NetEase - not connected')
      expect(menus[1]).toContain('>> 3) [x] NetEase - ')
      expect(menus[1]).toContain('numbers or names')
    }
  })

  it('the onboarding card names every source and the way back, and asks nothing else', () => {
    // One consent ask (spec 14 §3.9): the question, then two quiet notes.
    expect(SOURCES_OFFER).toHaveLength(3)
    expect(SOURCES_OFFER[0]).toMatch(/\? \[y\/N\]$/)
    for (const name of ['NetEase', 'Spotify', 'YouTube', 'Bilibili', 'Soda']) expect(SOURCES_OFFER[1]).toContain(name)
    expect(SOURCES_OFFER[2]).toContain('/sources')
  })
})
