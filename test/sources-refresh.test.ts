// The refresh policy (spec 14 §3.4/§3.5): background, single-flight, only
// what is stale, never while the /sources conversation holds the store, and
// a failure keeps the last snapshot.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SourceAuthError, SourceAuthWatch } from '../src/music/sources/auth.ts'
import { TasteRefresher } from '../src/music/sources/refresh.ts'
import { SourcesStore } from '../src/music/sources/store.ts'
import type { SourceId, TasteSnapshot, TasteSource } from '../src/music/sources/taste.ts'
import { FakeHost, until } from './fakes.ts'

const NOW = new Date('2026-09-06T12:00:00Z')

class FakeSource implements TasteSource {
  readonly id: SourceId
  snapshots = 0
  fail: Error | null = null
  hang = false
  items = [{ kind: 'liked' as const, title: 'a', artist: 'b' }]

  constructor(id: SourceId) {
    this.id = id
  }

  async verify() {
    return { ok: true as const, who: 'me' }
  }

  async snapshot(): Promise<TasteSnapshot> {
    this.snapshots++
    if (this.hang) await new Promise<never>(() => {})
    if (this.fail !== null) throw this.fail
    return { source: this.id, takenAt: NOW.toISOString(), items: this.items }
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
    store.writeSnapshot({ source: 'youtube', takenAt: '2026-09-06T00:00:00.000Z', items: [] })
    store.markRefreshed('youtube', new Date('2026-09-06T00:00:00Z')) // 12 h ago: fresh
    store.mount('spotify', { clientId: 'c', refreshToken: 'r', accessToken: 'a', expiresAt: 'x' }, new Date('2026-09-01T00:00:00Z'))
    store.markRefreshed('spotify', new Date('2026-09-04T00:00:00Z')) // 2 days ago: stale
    const yt = new FakeSource('youtube')
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
    store.mount('bilibili', { browser: 'chrome', mid: '1' })
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
