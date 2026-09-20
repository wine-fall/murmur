// The refresh policy (spec 14 §3.4/§3.5): background, single-flight, only
// what is stale, never while the /sources conversation holds the store, and
// a failure keeps the last snapshot.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SourceAuthError, SourceAuthWatch } from '../src/music/sources/auth.ts'
import { CHROME_PROFILE_ENV } from '../src/music/sources/chrome.ts'
import { BrowserCookieError } from '../src/music/sources/cookies.ts'
import { emptyLedger } from '../src/music/sources/ledger.ts'
import { TasteRefresher } from '../src/music/sources/refresh.ts'
import { SourcesStore } from '../src/music/sources/store.ts'
import type { SourceId, TasteItem, TasteKind, TasteSnapshot, TasteSource } from '../src/music/sources/taste.ts'
import { FakeHost, until } from './fakes.ts'

const NOW = new Date('2026-09-06T12:00:00Z')

class FakeSource implements TasteSource {
  readonly id: SourceId
  kinds: readonly TasteKind[] = ['liked']
  snapshots = 0
  // What each call was asked for, so a test can see the clock's decision
  // rather than infer it from the rows.
  asked: (readonly TasteKind[] | undefined)[] = []
  fail: Error | null = null
  hang = false
  items: TasteItem[] = [{ kind: 'liked', title: 'a', artist: 'b' }]

  constructor(id: SourceId, kinds?: readonly TasteKind[]) {
    this.id = id
    if (kinds !== undefined) this.kinds = kinds
  }

  async verify() {
    return { ok: true as const, who: 'me' }
  }

  async snapshot(kinds?: readonly TasteKind[]): Promise<TasteSnapshot> {
    this.snapshots++
    this.asked.push(kinds)
    if (this.hang) await new Promise<never>(() => {})
    if (this.fail !== null) throw this.fail
    const wanted = this.items.filter((i) => kinds === undefined || kinds.includes(i.kind))
    return { source: this.id, takenAt: NOW.toISOString(), items: wanted }
  }
}

function build(over: { now?: Date } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-refresh-'))
  const store = new SourcesStore({ path: join(dir, 'sources.json'), tasteDir: join(dir, 'taste') })
  const host = new FakeHost()
  const sources = new Map<SourceId, FakeSource>()
  const refresher = new TasteRefresher({
    store,
    source: (id) => sources.get(id) ?? null,
    watch: new SourceAuthWatch({ store, host }),
    host,
    now: () => over.now ?? NOW,
  })
  return { store, host, sources, refresher }
}

// The read clock lives in the ledger file (spec 14 §2.11), so a test that
// wants a list to look already-read stamps it there.
function markRead(store: SourcesStore, id: SourceId, lastRead: Partial<Record<TasteKind, string>>): void {
  store.writeLedger({ ...(store.readLedger(id) ?? emptyLedger(id)), lastRead })
}

describe('TasteRefresher.maybeRefresh (boot policy)', () => {
  it('refreshes a mounted source with no snapshot, writes it, stamps the entry, logs counts only', async () => {
    const { store, host, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    sources.set('netease', new FakeSource('netease'))
    expect(refresher.maybeRefresh()).toBe(true)
    await until(() => store.readSnapshot('netease') !== null, 'the snapshot')
    await until(() => store.read().netease?.lastRefresh !== undefined, 'the stamp')
    expect(store.read().netease?.lastRefresh).toBe(NOW.toISOString())
    const line = host.debugs.find((d) => d.startsWith('sources.refresh netease'))!
    expect(line).toMatch(/^sources\.refresh netease n=1 \d+ms$/)
    expect(host.debugs.join('\n')).not.toContain('"a"')
  })

  it('leaves a fresh snapshot alone and refreshes a stale one', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' }, new Date('2026-09-06T00:00:00Z'))
    store.writeSnapshot({ source: 'youtube', takenAt: '2026-09-06T11:30:00.000Z', items: [] })
    // Both of YouTube's lists read half an hour ago: nothing is due.
    markRead(store, 'youtube', { history: '2026-09-06T11:30:00.000Z', subscription: '2026-09-06T11:30:00.000Z' })
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' }, new Date('2026-09-01T00:00:00Z'))
    markRead(store, 'spotify', { liked: '2026-09-04T00:00:00.000Z' }) // 2 days ago: stale
    const yt = new FakeSource('youtube', ['history', 'subscription'])
    const sp = new FakeSource('spotify')
    sources.set('youtube', yt)
    sources.set('spotify', sp)
    expect(refresher.maybeRefresh()).toBe(true)
    await until(() => sp.snapshots === 1, 'the stale one read')
    await new Promise((r) => setTimeout(r, 20))
    expect(yt.snapshots).toBe(0)
  })

  it('is single-flight and stays out while the conversation holds the store', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' }, new Date('2026-09-01T00:00:00Z'))
    const yt = new FakeSource('youtube')
    yt.hang = true
    sources.set('youtube', yt)
    expect(refresher.maybeRefresh()).toBe(true)
    expect(refresher.maybeRefresh()).toBe(false) // still running
    const idle = build()
    idle.store.mount('youtube', { browser: 'chrome' }, new Date('2026-09-01T00:00:00Z'))
    idle.sources.set('youtube', new FakeSource('youtube'))
    idle.store.busy = true
    expect(idle.refresher.maybeRefresh()).toBe(false)
    expect(idle.sources.get('youtube')!.snapshots).toBe(0)
  })

  it('a failed read keeps the old snapshot; an auth failure flips the file and says so once', async () => {
    const { store, host, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    const old: TasteSnapshot = { source: 'netease', takenAt: '2026-08-30T00:00:00.000Z', items: [{ kind: 'liked', title: 'old' }] }
    store.writeSnapshot(old)
    const ne = new FakeSource('netease')
    ne.fail = new Error('network down')
    sources.set('netease', ne)
    await refresher.refreshAll()
    expect(store.readSnapshot('netease')).toEqual(old)
    expect(host.debugs.some((d) => d.startsWith('sources.refresh netease failed'))).toBe(true)
    expect(host.infos).toEqual([])
    ne.fail = new SourceAuthError('netease', 'expired', 'x')
    await refresher.refreshAll()
    await refresher.refreshAll()
    expect(store.read().netease?.status).toBe('expired')
    expect(host.infos).toEqual(['your NetEase login has expired — /sources to renew; picking from elsewhere for now.'])
    expect(store.readSnapshot('netease')).toEqual(old)
  })

  it('a snapshot older than 30 days that keeps failing says what it is going on, once', async () => {
    const { store, host, sources, refresher } = build()
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' }, new Date('2026-07-01T00:00:00Z'))
    store.writeSnapshot({ source: 'spotify', takenAt: '2026-07-20T00:00:00.000Z', items: [] })
    const sp = new FakeSource('spotify')
    sp.fail = new Error('down')
    sources.set('spotify', sp)
    await refresher.refreshAll()
    await refresher.refreshAll()
    expect(host.infos).toEqual(['still going on what I knew about your Spotify music as of 2026-07-20.'])
  })

  it('a read that succeeds after an error clears the status and re-arms the once-per-session line', async () => {
    const { store, host, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    store.setStatus('netease', 'error', 'rate-limited')
    sources.set('netease', new FakeSource('netease'))
    await refresher.refreshAll()
    expect(store.read().netease?.status).toBe('ok')
    expect(store.read().netease).not.toHaveProperty('lastError')
    sources.get('netease')!.fail = new SourceAuthError('netease', 'rate-limited', 'x')
    await refresher.refreshAll()
    expect(host.infos).toHaveLength(1)
  })

  it('never re-reads an expired mount (that needs /sources), and backs off a failed read for an hour', async () => {
    const clock = { now: NOW }
    const { store, sources, refresher } = build()
    Object.assign(refresher, { deps: { ...(refresher as unknown as { deps: object }).deps, now: () => clock.now } })
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    store.setStatus('netease', 'expired', 'expired')
    const ne = new FakeSource('netease')
    sources.set('netease', ne)
    expect(refresher.maybeRefresh()).toBe(false)
    expect(ne.snapshots).toBe(0)
    store.setStatus('netease', 'ok')
    ne.fail = new Error('down')
    expect(refresher.maybeRefresh()).toBe(true)
    await until(() => ne.snapshots === 1, 'the first attempt')
    await new Promise((r) => setTimeout(r, 10))
    // Poked again on the next segment: the failure is fresh, so nothing runs.
    expect(refresher.maybeRefresh()).toBe(false)
    clock.now = new Date(NOW.getTime() + 61 * 60_000)
    expect(refresher.maybeRefresh()).toBe(true)
    await until(() => ne.snapshots === 2, 'the retry an hour on')
  })

  it('a read that finishes after the listener remounted the source writes nothing', async () => {
    // The conversation can unmount and mount again — a different account —
    // while a background read is still awaiting the platform. Its snapshot
    // belongs to the account that is gone.
    const { store, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: 'old', likedPlaylistId: '1' }, new Date('2026-09-01T00:00:00Z'))
    const ne = new FakeSource('netease')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ne.snapshot = async () => {
      await gate
      return { source: 'netease', takenAt: NOW.toISOString(), items: [{ kind: 'liked', title: 'the old account' }] }
    }
    sources.set('netease', ne)
    const running = refresher.refreshAll()
    store.unmount('netease')
    store.mount('netease', { browser: 'firefox', userId: 'new', likedPlaylistId: '2' })
    release()
    await running
    expect(store.readSnapshot('netease')).toBeNull()
    expect(store.read().netease?.userId).toBe('new')
  })

  it('a read that finishes after the source was unmounted writes nothing', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' }, new Date('2026-09-01T00:00:00Z'))
    const yt = new FakeSource('youtube')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    yt.snapshot = async () => {
      await gate
      return { source: 'youtube', takenAt: NOW.toISOString(), items: yt.items }
    }
    sources.set('youtube', yt)
    const running = refresher.refreshAll()
    store.unmount('youtube')
    release()
    await running
    expect(store.readSnapshot('youtube')).toBeNull()
    expect(store.read()).toEqual({})
  })

  it('refreshAll reports per-source outcomes for the foreground /sources refresh', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' })
    store.mount('bilibili', { auth: 'qr', cookie: 'SESSDATA=x', mid: '1' })
    sources.set('youtube', new FakeSource('youtube'))
    const bili = new FakeSource('bilibili')
    bili.fail = new Error('down')
    sources.set('bilibili', bili)
    expect(await refresher.refreshAll()).toEqual([
      { id: 'youtube', ok: true, count: 1 },
      { id: 'bilibili', ok: false, error: 'down' },
    ])
    store.setStatus('bilibili', 'expired')
    expect((await refresher.refreshAll()).at(-1)).toEqual({ id: 'bilibili', ok: false, error: 'expired' })
    expect(bili.snapshots).toBe(1)
  })
})

// A mount binds one account, and the account lives in one Chrome profile
// (spec 14 §3.1). Refresh reads the pin; it never re-guesses, because
// re-guessing is what quietly moved a mount to another profile's login.
// spec 14 §3.4, the per-kind clock: what the listener is on right now is a
// different question from what they have collected, and asking both at the
// same cadence meant either a stale afternoon or eight needless collection
// reads a day.
describe('the per-kind refresh clock', () => {
  const HOURS = (n: number): string => new Date(NOW.getTime() - n * 3_600_000).toISOString()

  it('asks only for the lists that are due, and stamps the ones it asked for', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' }, new Date('2026-09-01T00:00:00Z'))
    // The watch history is 4 h old (due at 3 h); the subscriptions were read
    // 4 h ago too but ride the same 3 h clock, so both are due. The liked
    // collection of the source beside it is 4 h old and is not.
    markRead(store, 'youtube', { history: HOURS(4), subscription: HOURS(4) })
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    markRead(store, 'netease', { liked: HOURS(4), playlist: HOURS(4) })
    const yt = new FakeSource('youtube', ['history', 'subscription'])
    const ne = new FakeSource('netease', ['liked', 'playlist'])
    sources.set('youtube', yt)
    sources.set('netease', ne)
    expect(refresher.maybeRefresh()).toBe(true)
    await until(() => yt.snapshots === 1, 'the due lists read')
    await new Promise((r) => setTimeout(r, 20))
    expect(yt.asked).toEqual([['history', 'subscription']])
    expect(ne.snapshots).toBe(0)
    expect(store.readLedger('youtube')?.lastRead).toEqual({ history: NOW.toISOString(), subscription: NOW.toISOString() })
  })

  it('asks for the collection too once a day has passed', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' }, new Date('2026-09-01T00:00:00Z'))
    markRead(store, 'youtube', { history: HOURS(4), subscription: HOURS(25) })
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    markRead(store, 'netease', { liked: HOURS(25), playlist: HOURS(2) })
    const ne = new FakeSource('netease', ['liked', 'playlist'])
    sources.set('youtube', new FakeSource('youtube', ['history', 'subscription']))
    sources.set('netease', ne)
    refresher.maybeRefresh()
    await until(() => ne.snapshots === 1, 'the collection read')
    // The playlists were read two hours ago and ride the 24 h clock, so they
    // are not asked for again just because the liked list is due.
    expect(ne.asked).toEqual([['liked']])
  })

  it('asks for everything when no list has ever been read', async () => {
    const { store, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    const ne = new FakeSource('netease', ['liked', 'playlist'])
    sources.set('netease', ne)
    refresher.maybeRefresh()
    await until(() => ne.snapshots === 1, 'the first read')
    expect(ne.asked).toEqual([['liked', 'playlist']])
  })

  it('never asks an expired mount, whatever its clock says', async () => {
    const { store, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    store.setStatus('netease', 'expired')
    const ne = new FakeSource('netease', ['liked', 'playlist'])
    sources.set('netease', ne)
    expect(refresher.maybeRefresh()).toBe(false)
    expect(ne.snapshots).toBe(0)
  })

  it('a partial read replaces its own kinds and leaves the rest of the snapshot standing', async () => {
    const { store, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    store.writeSnapshot({
      source: 'netease',
      takenAt: HOURS(30),
      items: [
        { kind: 'liked', title: 'an old song', artist: 'a band' },
        { kind: 'playlist', title: 'late drive' },
      ],
    })
    markRead(store, 'netease', { liked: HOURS(30), playlist: HOURS(2) })
    const ne = new FakeSource('netease', ['liked', 'playlist'])
    ne.items = [
      { kind: 'liked', title: 'a new song', artist: 'a band' },
      { kind: 'playlist', title: 'a playlist this read never asked for' },
    ]
    sources.set('netease', ne)
    refresher.maybeRefresh()
    await until(() => ne.snapshots === 1, 'the partial read')
    await until(() => store.readSnapshot('netease')?.items.some((i) => i.title === 'a new song') === true, 'the new rows')
    const items = store.readSnapshot('netease')!.items
    // The liked rows are replaced; the playlist row nobody re-read is kept.
    expect(items.filter((i) => i.kind === 'liked').map((i) => i.title)).toEqual(['a new song'])
    expect(items.filter((i) => i.kind === 'playlist').map((i) => i.title)).toEqual(['late drive'])
  })

  it('folds every read into the ledger, which only grows', async () => {
    const { store, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    const ne = new FakeSource('netease', ['liked'])
    ne.items = [{ kind: 'liked', title: 'one', artist: 'a band' }]
    sources.set('netease', ne)
    await refresher.refreshAll()
    ne.items = [{ kind: 'liked', title: 'two', artist: 'a band' }]
    await refresher.refreshAll()
    // The snapshot is the latest read; the ledger is both.
    expect(store.readSnapshot('netease')!.items.map((i) => i.title)).toEqual(['two'])
    expect(store.readLedger('netease')!.entries.map((e) => e.title).sort()).toEqual(['one', 'two'])
  })

  it('drops the ledger with the snapshot when the account goes', async () => {
    const { store, sources, refresher } = build()
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' }, new Date('2026-09-01T00:00:00Z'))
    sources.set('netease', new FakeSource('netease', ['liked']))
    await refresher.refreshAll()
    expect(store.readLedger('netease')).not.toBeNull()
    store.unmount('netease')
    // A remount of a different account must not inherit this one's history.
    expect(store.readLedger('netease')).toBeNull()
  })
})

describe('the Chrome profile a refresh reads', () => {
  // Awaited, not just called: restoring the knob before the refresh has
  // finished would leave the read looking at the developer's own setting.
  async function withoutKnob<T>(fn: () => Promise<T>): Promise<T> {
    const before = process.env[CHROME_PROFILE_ENV]
    delete process.env[CHROME_PROFILE_ENV]
    try {
      return await fn()
    } finally {
      if (before !== undefined) process.env[CHROME_PROFILE_ENV] = before
    }
  }

  it('pins a profile into a mount that carries none, once a read has worked', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' })
    expect(store.read().youtube?.profile).toBeUndefined()
    sources.set('youtube', new FakeSource('youtube'))
    await withoutKnob(() => refresher.refreshAll())
    expect(store.read().youtube?.profile).toEqual(expect.any(String))
  })

  it('keeps the pin a mount was made with', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome', profile: 'Default' })
    sources.set('youtube', new FakeSource('youtube'))
    await withoutKnob(() => refresher.refreshAll())
    expect(store.read().youtube?.profile).toBe('Default')
  })

  it('writes nothing back when the read failed', async () => {
    const { store, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome' })
    const yt = new FakeSource('youtube')
    yt.fail = new Error('down')
    sources.set('youtube', yt)
    await withoutKnob(() => refresher.refreshAll())
    expect(store.read().youtube?.profile).toBeUndefined()
  })

  // The knob used to RESOLVE a mount, so a pin it disagreed with meant the
  // mount had drifted and had to be reconnected. Since the sign-in card
  // (spec 14 §3.1) the pin is the listener's own answer, and the knob only
  // preselects — so a knob that disagrees is a stale preference, not a
  // drifted mount. Vetoing here put an explicitly chosen profile in a
  // reconnect loop it could never leave (codex review).
  it('never expires a pinned mount because the knob names another profile — the pin is the listener\'s own choice now', async () => {
    const { store, host, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome', profile: 'Default' })
    const yt = new FakeSource('youtube')
    sources.set('youtube', yt)
    const before = process.env[CHROME_PROFILE_ENV]
    process.env[CHROME_PROFILE_ENV] = 'Work'
    try {
      expect(await refresher.refreshAll()).toEqual([{ id: 'youtube', ok: true, count: 1 }])
    } finally {
      if (before === undefined) delete process.env[CHROME_PROFILE_ENV]
      else process.env[CHROME_PROFILE_ENV] = before
    }
    // Read under the pin, and the pin stands.
    expect(yt.snapshots).toBe(1)
    expect(store.read().youtube?.profile).toBe('Default')
    expect(store.read().youtube?.status).toBe('ok')
    expect(host.infos.some((l) => /YouTube login has expired/.test(l))).toBe(false)
  })

  it('takes the expired road when the pinned profile is gone — never another profile', async () => {
    const { store, host, sources, refresher } = build()
    store.mount('youtube', { browser: 'chrome', profile: 'Murmur Fresh' })
    const yt = new FakeSource('youtube')
    yt.fail = new BrowserCookieError('chrome', 'no-profile', 'could not find chrome cookies database', 'Murmur Fresh')
    sources.set('youtube', yt)
    expect(await refresher.refreshAll()).toEqual([{ id: 'youtube', ok: false, error: 'no-profile' }])
    expect(store.read().youtube?.status).toBe('expired')
    expect(store.read().youtube?.profile).toBe('Murmur Fresh')
    expect(host.infos.some((l) => /YouTube login has expired/.test(l))).toBe(true)
  })
})
