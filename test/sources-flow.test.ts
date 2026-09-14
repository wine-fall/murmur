// The /sources conversation (spec 14 §3.1): a deterministic state machine
// over Host.ask / info with a scripted host and fake platform adapters — no
// model, no network.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SourceAuthWatch } from '../src/music/sources/auth.ts'
import { runSources, SOURCES_OFFER, type SourceMounts, type SourcesFlowDeps } from '../src/music/sources/flow.ts'
import { TasteRefresher } from '../src/music/sources/refresh.ts'
import { BUNDLED_CLIENT_ID, CLIENT_ID_ENV } from '../src/music/sources/spotify.ts'
import { BrowserCookieError } from '../src/music/sources/cookies.ts'
import { CHROME_PROFILE_ENV } from '../src/music/sources/flow.ts'
import { SourcesStore } from '../src/music/sources/store.ts'
import type { SourceId, TasteSnapshot, TasteSource } from '../src/music/sources/taste.ts'
import { quitLatch } from '../src/setup/guide.ts'
import { FakeHost } from './fakes.ts'

const NOW = new Date('2026-09-06T12:00:00Z')

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
  over: Partial<Omit<SourcesFlowDeps, 'mounts'>> & { mounts?: Partial<SourceMounts>; onCookieDrop?: () => void } = {},
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
    youtube: async (b) => (mounted.push(`youtube:${b.browser}:${b.profile ?? ''}`), { ok: true, who: 'Zach G', entry: { browser: b.browser, ...(b.profile !== undefined && { profile: b.profile }) } }),
    bilibili: async (b) => (mounted.push(`bilibili:${b.browser}`), { ok: false, reason: 'login-required' }),
    netease: async (b) => (
      mounted.push(`netease:${b.browser}`),
      { ok: true, who: 'Chen X', entry: { browser: b.browser, ...(b.profile !== undefined && { profile: b.profile }), userId: '1', likedPlaylistId: '2' } }
    ),
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
    qishui: async (show, cancelled) => {
      show('https://example.com/qr')
      mounted.push('qishui')
      if (cancelled()) return { ok: false, reason: 'cancelled' }
      return { ok: true, who: 'Soda Listener', entry: { sessionCookie: 's', deviceId: 'd', installId: 'i' } }
    },
    ...over.mounts,
  }
  const { mounts: _mounts, onCookieDrop, ...rest } = over
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
      ],
      multi: true,
    })
    expect(store.busy).toBe(false)
  })

  it('mounts a cookie source without asking anything: Chrome is read, verified, snapshotted, said', async () => {
    const { host, deps, store, mounted } = build(['youtube', 'youtube'], { platform: 'darwin' })
    await runSources(deps)
    // The browser question is gone entirely — murmur reads the one browser
    // it also opens for signing in, so there is nothing to get wrong.
    expect(host.asks.some((a) => /which browser/i.test(a.text))).toBe(false)
    expect(mounted).toEqual(['youtube:chrome:'])
    expect(host.infos).toContain('signed in as Zach G')
    expect(host.infos.some((l) => /^done — 2 items from YouTube; I'll keep it fresh\.$/.test(l))).toBe(true)
    expect(store.read().youtube).toMatchObject({ browser: 'chrome', status: 'ok' })
    expect(store.readSnapshot('youtube')?.items).toHaveLength(2)
    expect(host.debugs).toContain('sources.mount youtube')
    // Back at the menu: the result is a status row IN the card (never an
    // info line the card then covers — #231), the mounted one is ticked
    // with its counts, and the refresh row appears.
    const menu = host.asks.at(-1)!.text.split('\n')
    expect(menu[1]).toBe('ok YouTube — signed in as Zach G · 1 liked, 1 playlist')
    expect(menu).toContain('>> 1) [x] YouTube - 1 liked, 1 playlist · read just now')
    expect(menu).toContain('>> 3) [ ] NetEase - not connected')
    expect(menu).toContain('>> 6) [ ] refresh - re-read every connected account now')
    const options = host.asks.at(-1)!.choices!.options
    expect(options[0]).toEqual({ key: 'youtube', label: 'YouTube', note: '1 liked, 1 playlist · read just now', checked: true })
    expect(options.at(-1)).toEqual({ key: 'refresh', label: 'refresh', note: 're-read every connected account now', checked: false })
  })

  it('a remount drops the previous account\'s snapshot before reading the new one', async () => {
    // A signed-in mount is not re-run from the list; an expired one is, and
    // that is the remount.
    const { host, deps, store } = build(['netease', 'netease'])
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
    const { host, deps, store } = build(['bilibili', '', 'bilibili'], {
      onCookieDrop: () => dropped.push(1),
      openUrl: (url) => opened.push(url),
      mounts: {
        bilibili: async () => (attempt++ === 0 ? { ok: false, reason: 'login-required' } : { ok: true, who: 'Zach G', entry: { browser: 'chrome', mid: '42' } }),
      },
    })
    await runSources(deps)
    expect(opened).toEqual(['https://passport.bilibili.com/login'])
    expect(host.infos.some((l) => /opened Bilibili in Chrome/.test(l))).toBe(true)
    expect(host.asks.some((a) => /press enter/i.test(a.text))).toBe(true)
    // The cached export is dropped, or the retry would answer from the read
    // taken before they signed in.
    expect(dropped).toHaveLength(1)
    expect(host.infos).toContain('signed in as Zach G')
    expect(store.read().bilibili).toMatchObject({ browser: 'chrome', status: 'ok' })
  })

  it('still no login after the wait says so plainly and writes nothing', async () => {
    const { host, deps, store } = build(['bilibili', '', ''], {
      openUrl: () => {},
      mounts: { bilibili: async () => ({ ok: false, reason: 'login-required' }) },
    })
    await runSources(deps)
    expect(host.infos).toContain('still no Bilibili login in Chrome — /sources when you have signed in.')
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
    ] as const
    for (const [reason, matcher] of cases) {
      const { host, deps, store } = build(['netease', ''], {
        platform: 'darwin',
        mounts: {
          netease: async () => {
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
      expect(row.startsWith('-- NetEase — ')).toBe(true)
      expect(matcher.test(row)).toBe(true)
    }
  })

  // A profile named by MURMUR_CHROME_PROFILE that Chrome has never opened:
  // Chrome is here, so "install it" is the wrong advice; name the profile and
  // the knob that picked it.
  it('names the missing profile and the env knob when Chrome is here but the profile is not', async () => {
    const { host, deps, store } = build(['netease', ''], {
      platform: 'darwin',
      mounts: {
        netease: async () => {
          throw new BrowserCookieError('chrome', 'no-profile', 'could not find chrome cookies database in "/x/Chrome/Murmur Fresh"', 'Murmur Fresh')
        },
      },
    })
    await runSources(deps)
    const line = host.infos.find((l) => /no profile named/.test(l))
    expect(line).toContain('"Murmur Fresh"')
    expect(line).toContain('MURMUR_CHROME_PROFILE')
    expect(host.infos.some((l) => /install|sign in there/.test(l))).toBe(false)
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
    const built = build(['bilibili', '', ''], {
      openUrl: () => {},
      mounts: {
        bilibili: async () => {
          attempts++
          if (attempts === 1) {
            escape()
            return { ok: false, reason: 'login-required' }
          }
          return { ok: true, who: 'Zach G', entry: { browser: 'chrome', mid: '42' } }
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
    const { host, deps } = build(['netease', ''], {
      platform: 'win32',
      mounts: {
        netease: async () => {
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
      const { deps, store } = build(['netease', 'netease'])
      await runSources(deps)
      expect(store.read().netease).toMatchObject({ browser: 'chrome', profile: 'Profile 2' })
    } finally {
      if (before === undefined) delete process.env[CHROME_PROFILE_ENV]
      else process.env[CHROME_PROFILE_ENV] = before
    }
  })

  it('mounts Spotify straight into the browser: no app to register, no client id asked for', async () => {
    const { host, deps, store, mounted } = build(['spotify', 'spotify'])
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
    const { deps, mounted } = build(['spotify', 'spotify'])
    await withClientIdEnv('client-of-their-own', () => runSources(deps))
    expect(mounted).toEqual(['spotify:client-of-their-own'])
  })

  it('a Spotify callback that never arrives is the §3.7 line; the consent URL is printed either way', async () => {
    const { host, deps, store } = build(['spotify', ''], {}, 'timeout')
    await runSources(deps)
    expect(host.infos).toContain("didn't hear back from Spotify — /sources to try again.")
    expect(host.infos.some((l) => l.includes('https://accounts.spotify.com/authorize'))).toBe(true)
    expect(store.read()).toEqual({})
  })

  it('Esc during the Spotify wait cancels and writes nothing', async () => {
    const { host, deps, store } = build(['spotify', ''], {}, 'esc')
    await runSources(deps)
    expect(host.infos).toContain('cancelled — nothing was written.')
    expect(store.read()).toEqual({})
  })

  it('mounts Soda: the QR on the unlogged surface, the Douyin instruction, who', async () => {
    const { host, deps, store, mounted } = build(['soda', 'soda'])
    await runSources(deps)
    expect(mounted).toEqual(['qishui'])
    // The QR encodes an authorization URL, so it goes to the screen only —
    // host.info mirrors into the diagnostics a /bug report attaches (§3.6).
    const qr = host.privates.find((l) => l.includes('█'))!
    expect(qr.split('\n').length).toBeGreaterThan(10)
    expect(host.infos.join('\n')).not.toContain('█')
    expect(host.infos.some((l) => /Douyin/.test(l))).toBe(true)
    expect(store.read().qishui).toMatchObject({ sessionCookie: 's', status: 'ok' })
  })

  it('refuses the Soda mount on a host that cannot show a line off the record', async () => {
    const { host, deps, store, mounted } = build(['soda', ''])
    host.showPrivate = undefined
    await runSources(deps)
    expect(mounted).toEqual([])
    expect(host.infos.some((l) => /cannot show the code here/.test(l))).toBe(true)
    expect(store.read()).toEqual({})
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
    expect(afterRefresh.slice(1, 3)).toEqual(['ok NetEase — 2 items', '-- Spotify — could not read it (down)'])
    const afterUnmount = host.asks[2]!.text.split('\n')
    expect(afterUnmount[1]).toBe('ok NetEase — unmounted; its snapshot is gone.')
    expect(afterUnmount[2]!.startsWith('ok Spotify — unmounted;')).toBe(true)
    expect(host.asks).toHaveLength(3)
  })

  it('with everything mounted the menu is all status rows — no option left, still the menu', async () => {
    const { host, deps, store } = build(['youtube bilibili netease spotify qishui'])
    store.mount('youtube', { browser: 'chrome' })
    store.mount('bilibili', { browser: 'chrome', mid: '7' })
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' })
    store.mount('qishui', { sessionCookie: 's', deviceId: 'd', installId: 'i' })
    await runSources(deps)
    const menu = host.asks[0]!.text.split('\n')
    expect(menu.filter((l) => l.startsWith('>> ') && l.includes('[x]'))).toHaveLength(5)
    expect(host.asks[0]!.choices!.options.map((o) => o.checked)).toEqual([true, true, true, true, true, false])
    // The unchanged submit leaves: one card, nothing done.
    expect(host.asks).toHaveLength(1)
    expect(host.infos).toEqual([])
  })

  it('lists an expired mount as one to renew', async () => {
    // An expired login rests unticked — ticking it signs in again; an
    // unchanged submit leaves it alone rather than unmounting it.
    const { host, deps, store, mounted } = build([''])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.setStatus('netease', 'expired')
    await runSources(deps)
    expect(host.asks[0]!.text.split('\n')).toContain('>> 3) [ ] NetEase - expired — tick to sign in again')
    expect(host.asks).toHaveLength(1)
    expect(mounted).toEqual([])
    expect(store.read().netease?.status).toBe('expired')
    const renew = build(['netease', 'netease'])
    renew.store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    renew.store.setStatus('netease', 'expired')
    await runSources(renew.deps)
    expect(renew.mounted).toEqual(['netease:chrome'])
    expect(renew.store.read().netease?.status).toBe('ok')
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
    const { deps, store, host } = build(['netease', 'netease'], {
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
    const { host, deps, store, mounted } = build(['spotify netease', 'netease spotify'])
    await runSources(deps)
    expect(mounted).toEqual(['netease:chrome', `spotify:${BUNDLED_CLIENT_ID}`])
    expect(store.mounted()).toEqual(['netease', 'spotify'])
    const rows = host.asks[1]!.text.split('\n')
    expect(rows.slice(1, 3)).toEqual([
      'ok NetEase — signed in as Chen X · 1 liked, 1 playlist',
      'ok Spotify — signed in as Listener · 1 liked, 1 playlist',
    ])
    expect(host.asks).toHaveLength(2)
  })

  it('unticking a mounted one unmounts it; the rest are left alone', async () => {
    const { host, deps, store, mounted } = build(['spotify', 'spotify'])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' })
    await runSources(deps)
    expect(mounted).toEqual([])
    expect(store.mounted()).toEqual(['spotify'])
    expect(host.asks[1]!.text.split('\n')[1]).toBe('ok NetEase — unmounted; its snapshot is gone.')
  })

  it('a mount that fails leaves its reason as a gap row, and a stopped one says so', async () => {
    const failing = build(['spotify', ''], {}, 'timeout')
    await runSources(failing.deps)
    expect(failing.host.asks[1]!.text.split('\n')[1]).toBe("-- Spotify — didn't hear back from Spotify — /sources to try again.")
    // Esc mid-mount stops the rest of the submit: Soda was still to come.
    const stopped = build(['spotify soda', ''], {}, 'esc')
    await runSources(stopped.deps)
    expect(stopped.mounted).toEqual([`spotify:${BUNDLED_CLIENT_ID}`])
    expect(stopped.host.asks[1]!.text.split('\n')[1]).toBe('-- Spotify — stopped — nothing was written')
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
      const { host, deps, store, mounted } = build([answer, ''])
      Object.defineProperty(host, 'ask', { value: undefined })
      await runSources(deps)
      expect(mounted).toEqual(['netease:chrome'])
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
