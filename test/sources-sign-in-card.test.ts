// The "how do I sign in" card (spec 14 §3.1, revised 2026-09-15): before every
// mount that has more than one road, the listener says which one — a phone
// scan, or a NAMED Chrome profile. Two real failures, both from dogfooding:
// a YouTube mount silently read whichever profile Chrome touched last (the
// work account, when the listener meant the personal one) with no step to say
// so; and since #242 NetEase and Bilibili could only be scanned, with the
// browser road they had before gone.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SourceAuthError, SourceAuthWatch } from '../src/music/sources/auth.ts'
import { CHROME_PROFILE_ENV, type ChromeDeps } from '../src/music/sources/chrome.ts'
import { QQMUSIC_VIP_NOTE, runSources, type SourceMounts, type SourcesFlowDeps } from '../src/music/sources/flow.ts'
import { TasteRefresher } from '../src/music/sources/refresh.ts'
import { SourcesStore } from '../src/music/sources/store.ts'
import type { SourceId, TasteSnapshot, TasteSource } from '../src/music/sources/taste.ts'
import { quitLatch } from '../src/setup/guide.ts'
import { FakeHost } from './fakes.ts'

const NOW = new Date('2026-09-15T12:00:00Z')

const THREE = JSON.stringify({
  profile: {
    last_used: 'Profile 3',
    info_cache: {
      'Profile 3': { name: 'Personal', user_name: 'fawinell@gmail.com' },
      Default: { name: 'Work', user_name: 'zach.guo@opus.pro' },
    },
  },
})
const ONE = JSON.stringify({ profile: { last_used: 'Default', info_cache: { Default: { name: 'Work', user_name: 'zach.guo@opus.pro' } } } })

function chrome(state: string, env: NodeJS.ProcessEnv = {}): ChromeDeps {
  return { env, platform: 'linux', home: '/home/someone', readFile: () => state, exists: () => true }
}

class FakeSource implements TasteSource {
  readonly id: SourceId
  constructor(id: SourceId) {
    this.id = id
  }
  async verify() {
    return { ok: true as const, who: 'me' }
  }
  async snapshot(): Promise<TasteSnapshot> {
    return { source: this.id, takenAt: NOW.toISOString(), items: [{ kind: 'liked', title: 't', artist: 'a' }] }
  }
}

function build(lines: string[], over: Partial<SourcesFlowDeps> & { mounts?: Partial<SourceMounts> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-signin-'))
  const store = new SourcesStore({ path: join(dir, 'sources.json'), tasteDir: join(dir, 'taste') })
  const host = new FakeHost()
  for (const line of lines) host.type(line)
  const watch = new SourceAuthWatch({ store, host })
  const refresher = new TasteRefresher({ store, source: () => null, watch, host, now: () => NOW })
  // Every road a mount can take, recorded as it is taken: the assertions are
  // about WHICH road the card sent the mount down, and with what profile.
  const took: string[] = []
  const opened: [string, string][] = []
  const mounts: SourceMounts = {
    browser: {
      youtube: async (b) => (took.push(`youtube:browser:${b.profile ?? ''}`), { ok: true, who: 'Zach G', entry: { browser: b.browser, ...(b.profile !== undefined && { profile: b.profile }) } }),
      netease: async (b) => (
        took.push(`netease:browser:${b.profile ?? ''}`),
        { ok: true, who: 'Chen X', entry: { auth: 'browser', browser: b.browser, ...(b.profile !== undefined && { profile: b.profile }), userId: '1', likedPlaylistId: '2' } }
      ),
      bilibili: async (b) => (
        took.push(`bilibili:browser:${b.profile ?? ''}`),
        { ok: true, who: 'Bili Me', entry: { auth: 'browser', browser: b.browser, ...(b.profile !== undefined && { profile: b.profile }), mid: '9' } }
      ),
      qqmusic: async (b) => (
        took.push(`qqmusic:browser:${b.profile ?? ''}`),
        { ok: true, who: 'Wine', entry: { auth: 'browser', browser: b.browser, ...(b.profile !== undefined && { profile: b.profile }) } }
      ),
    },
    netease: async (show) => (
      show('https://music.163.com/login?codekey=k'),
      took.push('netease:qr'),
      { ok: true, who: 'Chen X', entry: { auth: 'qr', cookie: 'MUSIC_U=<redacted>', userId: '1', likedPlaylistId: '2' } }
    ),
    bilibili: async (show) => (show('https://account.bilibili.com/h5/scan?qrcode_key=k'), took.push('bilibili:qr'), { ok: false, reason: 'login-required' }),
    spotify: async (clientId, hooks) => (
      hooks.onRedirect('http://127.0.0.1:39917/callback'),
      hooks.onUrl('https://accounts.spotify.com/authorize?client_id=x'),
      hooks.openUrl?.('https://accounts.spotify.com/authorize?client_id=x'),
      took.push('spotify'),
      { ok: true, who: 'Listener', entry: { clientId, refreshToken: 'r', accessToken: 'a', expiresAt: 'x' } }
    ),
    qishui: async (show) => (show('https://example.com/qr'), took.push('qishui:qr'), { ok: true, who: 'Soda Listener', entry: { sessionCookie: 's', deviceId: 'd', installId: 'i' } }),
    qqmusic: async (show) => (
      show('https://open.weixin.qq.com/connect/confirm?uuid=u'),
      took.push('qqmusic:qr'),
      { ok: true, who: 'Wine', entry: { auth: 'qr', cookie: 'uin=1; qm_keyst=<redacted>; euin=e' } }
    ),
    ...over.mounts,
  }
  const { mounts: _m, ...rest } = over
  const deps: SourcesFlowDeps = {
    host,
    store,
    quit: quitLatch(),
    refresher,
    watch,
    mounts,
    build: (id) => new FakeSource(id),
    platform: 'linux',
    now: () => NOW,
    chrome: chrome(THREE),
    openUrl: (url, profile) => void opened.push([url, profile]),
    ...rest,
  }
  return { store, host, deps, took, opened }
}

// Esc while the card's read is pending: the flow is mid-await, so the press
// waits for the card to actually be up rather than racing it.
async function escWhenAsked(host: FakeHost): Promise<void> {
  for (let i = 0; i < 200 && !host.asks.some((a) => a.text.startsWith('How should I sign in')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  host.pressEsc()
  // Esc hands the LIST back, not the way out — so the menu is answered once
  // more to leave the conversation. A tick later, so the Esc settles its own
  // read first rather than racing the typed line into it.
  await new Promise((resolve) => setTimeout(resolve, 5))
  host.type('')
}

// The card a mount pops, as a test reads it: its text and its rows.
function card(host: FakeHost, n = 0) {
  const asks = host.asks.filter((a) => a.text.startsWith('How should I sign in'))
  return asks[n]!
}

describe('the sign-in card (spec 14 §3.1)', () => {
  it('asks before a YouTube mount, listing one row per Chrome profile — the listener never inherits last_used silently', async () => {
    const { host, deps } = build(['youtube', 'chrome:Profile 3', 'youtube'])
    await runSources(deps)
    const asked = card(host)
    expect(asked.kind).toBe('question')
    expect(asked.text.split('\n')).toEqual([
      'How should I sign in to YouTube?',
      'signed in to the wrong account there? sign out on the site in that Chrome window, then pick it again.',
      '>> 1) [ ] Chrome — Work (zach.guo@opus.pro)',
      '>> 2) [x] Chrome — Personal (fawinell@gmail.com)',
    ])
    // One pick, not a tick list: picking a second road would mean two mounts.
    expect(asked.choices?.multi).toBe(false)
    expect(asked.choices?.options).toEqual([
      // Default leads the list (Chrome's own order), and last_used is the
      // row it opens on — the two are different profiles here on purpose.
      { key: 'chrome:Default', label: 'Chrome — Work (zach.guo@opus.pro)', checked: false },
      { key: 'chrome:Profile 3', label: 'Chrome — Personal (fawinell@gmail.com)', checked: true },
    ])
  })

  it('pins the chosen profile into the entry and reads that one — not the one Chrome touched last', async () => {
    const { store, deps, took } = build(['youtube', 'chrome:Profile 3', 'youtube'])
    await runSources(deps)
    expect(took).toEqual(['youtube:browser:Profile 3'])
    expect(store.read().youtube).toMatchObject({ browser: 'chrome', profile: 'Profile 3' })
  })

  it('asks even when Chrome has exactly one profile — the listener may want to sign in as someone else there', async () => {
    const { host, deps } = build(['youtube', 'chrome:Default', 'youtube'], { chrome: chrome(ONE) })
    await runSources(deps)
    expect(card(host).choices?.options).toHaveLength(1)
  })

  it('offers NetEase the scan first and the Chrome profiles under it — the browser road #242 narrowed is a choice again', async () => {
    const { host, deps } = build(['netease', 'scan', 'netease'])
    await runSources(deps)
    expect(card(host).choices?.options?.map((o) => o.key)).toEqual(['scan', 'chrome:Default', 'chrome:Profile 3'])
    expect(card(host).choices?.options?.[0]?.label).toBe('scan with the NetEase Cloud Music app')
  })

  // Scanning is the road that needs no Chrome permission, no cookie store
  // and no Full Disk Access — and the listener reached for it. A source that
  // can scan and has never been mounted opens on it; the profile chain is
  // for the sources that have no other road.
  it('opens a never-mounted NetEase on the scan row, not on a Chrome profile', async () => {
    const { host, deps } = build(['netease', '', 'netease'])
    await runSources(deps)
    expect(card(host).choices?.options?.find((o) => o.checked === true)?.key).toBe('scan')
    // Enter with nothing changed takes it.
    expect(card(host).text.split('\n')[2]).toBe('>> 1) [x] scan with the NetEase Cloud Music app')
  })

  it('opens a reconnect on the Chrome profile it was pinned to — that mount already answered the question', async () => {
    const { host, deps, store } = build(['netease refresh', '', 'netease'])
    store.mount('netease', { auth: 'browser', browser: 'chrome', profile: 'Profile 3', userId: '1', likedPlaylistId: '2' })
    store.setStatus('netease', 'expired')
    await runSources(deps)
    expect(card(host).choices?.options?.find((o) => o.checked === true)?.key).toBe('chrome:Profile 3')
  })

  it('YouTube has no scan row, so it still opens on a profile', async () => {
    const { host, deps } = build(['youtube', '', 'youtube'])
    await runSources(deps)
    expect(card(host).choices?.options?.find((o) => o.checked === true)?.key).toBe('chrome:Profile 3')
  })

  // QQ Music signs in with a WeChat scan or out of Chrome (spec 14 §2.10).
  // The row names WeChat, not QQ: the code is issued on the WeChat open
  // platform, and a QQ app pointed at it simply will not take.
  it('offers QQ Music the WeChat scan first and the Chrome profiles under it', async () => {
    const { host, deps } = build(['qqmusic', '', 'qqmusic'])
    await runSources(deps)
    expect(card(host).choices?.options?.map((o) => o.key)).toEqual(['scan', 'chrome:Default', 'chrome:Profile 3'])
    expect(card(host).choices?.options?.[0]?.label).toBe('scan with WeChat')
    // Never mounted and carrying no browser pin: it opens on the scan.
    expect(card(host).choices?.options?.find((o) => o.checked === true)?.key).toBe('scan')
  })

  it('sends a picked WeChat scan down the scan road, the credential kept here and no browser read', async () => {
    const { host, store, deps, took } = build(['qqmusic', 'scan', 'qqmusic'])
    await runSources(deps)
    expect(took).toEqual(['qqmusic:qr'])
    expect(host.notices.some((n) => n.body.some((row) => row.includes('█')))).toBe(true)
    expect(store.read().qqmusic).toMatchObject({ auth: 'qr' })
    // The scan road reads no browser, so nothing is pinned to a profile.
    expect(store.read().qqmusic).not.toHaveProperty('profile')
  })

  // QQ Music plays now (spec 14 §2.5), but not its VIP half — and a listener
  // who connects it has no other way to learn why the track they went looking
  // for never comes up. The mount says it itself, not only the spec.
  it('says what QQ Music can and cannot play, before anything is read — whichever road', async () => {
    const { host, deps } = build(['qqmusic', 'scan', 'qqmusic'])
    await runSources(deps)
    expect(host.infos).toContain(QQMUSIC_VIP_NOTE)
    // The promise the notice must not make: this used to claim QQ Music could
    // not be played at all, which stopped being true when playback landed.
    expect(QQMUSIC_VIP_NOTE).not.toMatch(/taste only|can't play from it/i)
    expect(QQMUSIC_VIP_NOTE).toMatch(/VIP/)
    // Said before the mount's own progress lines, so it frames the result.
    expect(host.infos.indexOf(QQMUSIC_VIP_NOTE)).toBeLessThan(host.infos.findIndex((l) => l.startsWith('signed in as')))
  })

  it('sends QQ Music down the cookie road, with the chosen profile pinned into the entry', async () => {
    const { store, deps, took } = build(['qqmusic', 'chrome:Default', 'qqmusic'])
    await runSources(deps)
    expect(took).toEqual(['qqmusic:browser:Default'])
    expect(store.read().qqmusic).toMatchObject({ auth: 'browser', browser: 'chrome', profile: 'Default' })
  })

  it('sends a picked scan down the scan road, unchanged: the code on the notice card, the cookie kept here', async () => {
    const { host, store, deps, took } = build(['netease', 'scan', 'netease'])
    await runSources(deps)
    expect(took).toEqual(['netease:qr'])
    expect(host.notices.some((n) => n.body.some((row) => row.includes('█')))).toBe(true)
    expect(store.read().netease).toMatchObject({ auth: 'qr', userId: '1' })
  })

  it('sends a picked Chrome row down the cookie road, with that profile pinned into the entry', async () => {
    const { store, deps, took } = build(['netease', 'chrome:Profile 3', 'netease'])
    await runSources(deps)
    expect(took).toEqual(['netease:browser:Profile 3'])
    expect(store.read().netease).toMatchObject({ auth: 'browser', browser: 'chrome', profile: 'Profile 3', userId: '1' })
  })

  it('names the Bilibili app on its own scan row', async () => {
    const { host, deps } = build(['bilibili', 'scan', ''])
    await runSources(deps)
    expect(card(host).choices?.options?.[0]?.label).toBe('scan with the Bilibili app')
  })

  it('Esc on the card writes nothing and hands the list back with the row unconnected', async () => {
    const { host, store, deps, took } = build(['youtube'])
    // The card is up and the read is pending; Esc answers it exactly as the
    // menu's own Esc does — the submit stops and nothing is written.
    await Promise.all([runSources(deps), escWhenAsked(host)])
    expect(took).toEqual([])
    expect(store.read()).toEqual({})
    expect(host.infos.some((l) => l.includes('stopped') || l.includes('cancelled'))).toBe(false)
  })

  it('preselects the profile this submit already chose, so two sources in a row are one account', async () => {
    const { host, deps, took } = build(['youtube spotify', 'chrome:Profile 3', '', 'youtube spotify'])
    await runSources(deps)
    // The second card opens on Profile 3 — what the first one chose.
    expect(card(host, 1).choices?.options?.find((o) => o.checked === true)?.key).toBe('chrome:Profile 3')
    expect(took).toEqual(['youtube:browser:Profile 3', 'spotify'])
  })

  // The carry-over is about which PROFILE, not which road: a scannable source
  // still opens on its scan row even after a Chrome profile was just chosen.
  it('does not let a carried profile pull a scannable source onto the browser road', async () => {
    const { host, deps, took } = build(['youtube netease', 'chrome:Profile 3', '', 'youtube netease'])
    await runSources(deps)
    expect(card(host, 1).choices?.options?.find((o) => o.checked === true)?.key).toBe('scan')
    expect(took).toEqual(['youtube:browser:Profile 3', 'netease:qr'])
  })

  it('preselects the knob when one is set — it preselects now, it no longer decides', async () => {
    const { host, deps } = build(['youtube', 'chrome:Default', 'youtube'], { chrome: chrome(THREE, { [CHROME_PROFILE_ENV]: 'Profile 3' }) })
    await runSources(deps)
    expect(card(host).choices?.options?.find((o) => o.checked === true)?.key).toBe('chrome:Profile 3')
  })

  it('offers a profile the knob names that Chrome no longer lists — the #240 road stays reachable', async () => {
    const { host, deps } = build(['youtube', 'chrome:Profile 9', 'youtube'], { chrome: chrome(THREE, { [CHROME_PROFILE_ENV]: 'Profile 9' }) })
    await runSources(deps)
    expect(card(host).choices?.options?.map((o) => o.key)).toContain('chrome:Profile 9')
  })

  it('takes a number or a bare profile name from a host with no list surface', async () => {
    const { deps, took } = build(['youtube', '2', 'youtube'])
    await runSources(deps)
    expect(took).toEqual(['youtube:browser:Profile 3'])
  })

  it("says it didn't catch a word it cannot place, and asks again rather than guessing an account", async () => {
    const { host, deps, took } = build(['youtube', 'whatever', 'chrome:Default', 'youtube'])
    await runSources(deps)
    expect(host.infos.some((l) => l.includes('I didn\'t catch "whatever"'))).toBe(true)
    expect(took).toEqual(['youtube:browser:Default'])
  })

  it('never asks Soda Music: it has no browser road at all, and a one-row card is noise', async () => {
    const { host, deps, took } = build(['soda', 'soda'])
    await runSources(deps)
    expect(host.asks.some((a) => a.text.startsWith('How should I sign in'))).toBe(false)
    expect(took).toEqual(['qishui:qr'])
  })

  // A front-end that goes away answers the pending read with '' — which on
  // this card would mean "take the preselected profile", so a listener whose
  // TUI died came back to a mount they never chose (codex review).
  it('a front-end that leaves while the card is up mounts nothing', async () => {
    const { host, store, deps, took } = build(['youtube'])
    await Promise.all([
      runSources(deps),
      (async () => {
        for (let i = 0; i < 200 && !host.asks.some((a) => a.text.startsWith('How should I sign in')); i++) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        host.endInput()
      })(),
    ])
    expect(took).toEqual([])
    expect(store.read()).toEqual({})
  })

  // The scan road re-checks the latch before it persists anything; the
  // browser road did not, so an Esc while the account read was in flight
  // still wrote the mount and said "connected" (codex review).
  it('Esc while the browser mount is in flight writes nothing, even though the read itself succeeded', async () => {
    const { host, store, deps } = build(['netease', 'chrome:Default', ''])
    deps.mounts.browser.netease = async (b) => {
      host.pressEsc()
      return { ok: true, who: 'Chen X', entry: { auth: 'browser', browser: b.browser, userId: '1', likedPlaylistId: '2' } }
    }
    await runSources(deps)
    expect(store.read()).toEqual({})
    expect(host.infos).not.toContain('signed in as Chen X')
  })

  // NetEase answers an expired cookie with `code: 301`, which the client
  // RAISES. Reported as "could not reach", it left the listener with no
  // sign-in page and nothing to do — it is the plain no-login road (codex
  // review).
  it('a login-required the client raises opens the sign-in page, it does not read as "could not reach"', async () => {
    const opened: [string, string][] = []
    const { host, deps } = build(['netease', 'chrome:Default', '', ''], { openUrl: (url, profile) => void opened.push([url, profile]) })
    deps.mounts.browser.netease = async () => {
      throw new SourceAuthError('netease', 'login-required', 'code 301 on /nuser/account/get')
    }
    await runSources(deps)
    expect(opened).toEqual([['https://music.163.com/', 'Default']])
    expect(host.infos.some((l) => l.includes('no NetEase login yet'))).toBe(true)
    expect(host.infos.some((l) => /could not reach/.test(l))).toBe(false)
  })

  it('asks Spotify which profile the consent page opens in — murmur never reads a Spotify cookie', async () => {
    const { host, deps, opened, took } = build(['spotify', 'chrome:Profile 3', 'spotify'])
    await runSources(deps)
    // No scan row: Spotify has no code to scan.
    expect(card(host).choices?.options?.map((o) => o.key)).toEqual(['chrome:Default', 'chrome:Profile 3'])
    expect(took).toEqual(['spotify'])
    expect(opened).toEqual([['https://accounts.spotify.com/authorize?client_id=x', 'Profile 3']])
  })
})
