// The /sources conversation (spec 14 §3.1): a deterministic state machine
// over Host.ask / info with a scripted host and fake platform adapters — no
// model, no network.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SourceAuthWatch } from '../src/music/sources/auth.ts'
import { runSources, SOURCES_ONBOARDING_LINE, type SourceMounts, type SourcesFlowDeps } from '../src/music/sources/flow.ts'
import { TasteRefresher } from '../src/music/sources/refresh.ts'
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

function build(lines: string[], over: Partial<Omit<SourcesFlowDeps, 'mounts'>> & { mounts?: Partial<SourceMounts> } = {}) {
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
    netease: async (b) => (mounted.push(`netease:${b.browser}`), { ok: true, who: 'Chen X', entry: { browser: b.browser, userId: '1', likedPlaylistId: '2' } }),
    spotify: async (clientId, hooks) => {
      hooks.onRedirect('http://127.0.0.1:39917/callback')
      hooks.onUrl('https://accounts.spotify.com/authorize?client_id=x')
      mounted.push(`spotify:${clientId}`)
      if (clientId === 'esc') {
        host.pressEsc()
        return hooks.cancelled() ? { ok: false, reason: 'cancelled' } : { ok: true, who: 'x', entry: { clientId, refreshToken: 'r', accessToken: 'a', expiresAt: 'x' } }
      }
      return clientId === 'timeout' ? { ok: false, reason: 'timeout' } : { ok: true, who: 'Listener', entry: { clientId, refreshToken: 'r', accessToken: 'a', expiresAt: 'x' } }
    },
    qishui: async (show, cancelled) => {
      show('https://example.com/qr')
      mounted.push('qishui')
      if (cancelled()) return { ok: false, reason: 'cancelled' }
      return { ok: true, who: 'Soda Listener', entry: { sessionCookie: 's', deviceId: 'd', installId: 'i' } }
    },
    ...over.mounts,
  }
  const { mounts: _mounts, ...rest } = over
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
    ...rest,
  }
  return { store, host, mounted, deps, sources }
}

describe('runSources (spec 14 §3.1)', () => {
  it('opens with the status, offers the menu, and done leaves', async () => {
    const { host, deps, store } = build(['done'])
    await runSources(deps)
    expect(host.infos[0]).toBe('nothing mounted yet · available: YouTube, Bilibili, NetEase, Spotify, Soda Music')
    expect(host.asks[0]!.text).toMatch(/^what would you like to do\?/)
    expect(host.asks[0]!.kind).toBe('question')
    expect(store.busy).toBe(false)
  })

  it('mounts a cookie source: browser question, verify, first snapshot, written, said', async () => {
    const { host, deps, store, mounted } = build(['mount youtube', 'chrome:Profile 1', 'done'], { platform: 'darwin' })
    await runSources(deps)
    const browserAsk = host.asks[1]!.text
    expect(browserAsk).toMatch(/Which browser are you signed in to YouTube with\?/)
    expect(browserAsk).toMatch(/Keychain/)
    expect(browserAsk).toMatch(/Full Disk Access/)
    expect(browserAsk).toMatch(/Firefox/)
    expect(mounted).toEqual(['youtube:chrome:Profile 1'])
    expect(host.infos).toContain('signed in as Zach G')
    expect(host.infos.some((l) => /^done — 2 items from YouTube; I'll keep it fresh\.$/.test(l))).toBe(true)
    expect(store.read().youtube).toMatchObject({ browser: 'chrome', profile: 'Profile 1', status: 'ok' })
    expect(store.readSnapshot('youtube')?.items).toHaveLength(2)
    expect(host.debugs).toContain('sources.mount youtube')
    // The menu comes back with the mount listed.
    expect(host.infos.some((l) => l.startsWith('mounted: YouTube (1 liked, 1 playlist · read just now)'))).toBe(true)
  })

  it('a browser with no login says so in the §3.7 words and writes nothing', async () => {
    const { host, deps, store } = build(['mount bilibili', 'firefox', 'done'])
    await runSources(deps)
    expect(host.infos).toContain('no Bilibili login in firefox — sign in there, then try /sources again.')
    expect(store.read()).toEqual({})
  })

  it('an unknown browser name is refused without a call', async () => {
    const { host, deps, mounted } = build(['mount netease', 'netscape', 'done'])
    await runSources(deps)
    expect(mounted).toEqual([])
    expect(host.infos.some((l) => l.includes('one of chrome, chromium, brave, edge, firefox, safari, vivaldi, opera'))).toBe(true)
  })

  it('mounts Spotify: the four steps, the redirect URI verbatim, the client id, who', async () => {
    const { host, deps, store, mounted } = build(['mount spotify', 'client-xyz', 'done'])
    await runSources(deps)
    const steps = host.infos.find((l) => l.includes('developer.spotify.com/dashboard'))!
    expect(steps).toContain('http://127.0.0.1:39917/callback')
    expect(host.asks.some((a) => /client id/i.test(a.text))).toBe(true)
    expect(mounted).toEqual(['spotify:client-xyz'])
    expect(host.infos).toContain('signed in as Listener')
    expect(store.read().spotify).toMatchObject({ clientId: 'client-xyz', status: 'ok' })
  })

  it('a Spotify callback that never arrives is the §3.7 line; the consent URL is printed either way', async () => {
    const { host, deps, store } = build(['mount spotify', 'timeout', 'done'])
    await runSources(deps)
    expect(host.infos).toContain("didn't hear back from Spotify — /sources to try again.")
    expect(host.infos.some((l) => l.includes('https://accounts.spotify.com/authorize'))).toBe(true)
    expect(store.read()).toEqual({})
  })

  it('Esc during the Spotify wait cancels and writes nothing', async () => {
    const { host, deps, store } = build(['mount spotify', 'esc', 'done'])
    await runSources(deps)
    expect(host.infos).toContain('cancelled — nothing was written.')
    expect(store.read()).toEqual({})
  })

  it('mounts Soda: the QR as half-blocks, the Douyin instruction, who', async () => {
    const { host, deps, store, mounted } = build(['mount soda', 'done'])
    await runSources(deps)
    expect(mounted).toEqual(['qishui'])
    const qr = host.infos.find((l) => l.includes('█'))!
    expect(qr.split('\n').length).toBeGreaterThan(10)
    expect(host.infos.some((l) => /Douyin/.test(l))).toBe(true)
    expect(store.read().qishui).toMatchObject({ sessionCookie: 's', status: 'ok' })
  })

  it('Esc during the QR wait cancels and writes nothing', async () => {
    const { host, deps, store } = build(['mount qishui', 'done'], {
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
    const { host, deps, store, sources } = build(['refresh', 'unmount netease', 'unmount spotify', 'done'])
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
  })

  it('lists an expired mount as one to renew', async () => {
    const { host, deps, store } = build(['done'])
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    store.setStatus('netease', 'expired')
    await runSources(deps)
    expect(host.infos[0]).toMatch(/mounted: NetEase \(expired — mount it again to renew\)/)
  })

  it('a line it does not understand asks again; /quit leaves through the latch', async () => {
    const { host, deps } = build(['what', 'done'])
    await runSources(deps)
    expect(host.infos.some((l) => /didn't catch that/.test(l))).toBe(true)
    const quitting = build(['/quit'])
    await runSources(quitting.deps)
    expect(quitting.deps.quit.requested).toBe(true)
  })

  it('holds the store for the whole conversation and hands the interrupt seam back', async () => {
    let busyDuring: boolean | null = null
    const { deps, store, host } = build(['mount netease', 'chrome', 'done'], {
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

  it('the onboarding line names the option without asking for anything', () => {
    expect(SOURCES_ONBOARDING_LINE).toBe('when you like, /sources connects your NetEase, Spotify or YouTube likes so I pick better. Nothing is read until you do.')
  })
})
