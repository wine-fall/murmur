// The mounted-sources file and the taste snapshots (spec 14 §2.1/§2.2): one
// writer, atomic writes, a corrupt file that never crashes the radio, and the
// cookie flag derived from a ref's host (§2.5).
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { cookieArgs, readSourcesFile, sourceOfRef, SourcesStore } from '../src/music/sources/store.ts'
import type { TasteSnapshot } from '../src/music/sources/taste.ts'

function home(): { dir: string; path: string; taste: string } {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-sources-'))
  return { dir, path: join(dir, 'sources.json'), taste: join(dir, 'data', 'taste') }
}

const NETEASE = { browser: 'chrome' as const, userId: '42', likedPlaylistId: '7', mountedAt: '2026-09-01T00:00:00.000Z', status: 'ok' as const }

describe('readSourcesFile', () => {
  it('reads a valid file, dropping unknown keys with one warning', () => {
    const { path } = home()
    const logs: string[] = []
    writeFileSync(path, JSON.stringify({ netease: { ...NETEASE, extra: 1 }, nonsense: {} }))
    const file = readSourcesFile(path, (m) => logs.push(m))
    expect(file.netease).toEqual(NETEASE)
    expect(file).not.toHaveProperty('nonsense')
    expect(logs).toHaveLength(1)
  })

  it('treats an absent file as empty, silently', () => {
    const logs: string[] = []
    expect(readSourcesFile(join(home().dir, 'missing.json'), (m) => logs.push(m))).toEqual({})
    expect(logs).toEqual([])
  })

  it('treats a corrupt file as empty and says so once per version of the file, not per read', () => {
    const { path, taste } = home()
    const logs: string[] = []
    const store = new SourcesStore({ path, tasteDir: taste, log: (m) => logs.push(m) })
    writeFileSync(path, '{ not json')
    expect(store.read()).toEqual({})
    expect(store.read()).toEqual({})
    expect(store.mounted()).toEqual([])
    expect(logs).toHaveLength(1)
    // The file changed: a new warning is earned.
    writeFileSync(path, JSON.stringify({ netease: { browser: 'netscape' } }))
    utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    expect(store.read()).toEqual({})
    expect(store.read()).toEqual({})
    expect(logs).toHaveLength(2)
  })
})

describe('SourcesStore', () => {
  it('mounts atomically (tmp + rename) and lists what is mounted', () => {
    const { path, taste } = home()
    const store = new SourcesStore({ path, tasteDir: taste })
    expect(store.mounted()).toEqual([])
    store.mount('netease', { browser: 'chrome', userId: '42', likedPlaylistId: '7' }, new Date('2026-09-06T10:00:00Z'))
    expect(store.mounted()).toEqual(['netease'])
    expect(existsSync(`${path}.tmp`)).toBe(false)
    const written = JSON.parse(readFileSync(path, 'utf-8')) as { netease: { mountedAt: string; status: string } }
    expect(written.netease.mountedAt).toBe('2026-09-06T10:00:00.000Z')
    expect(written.netease.status).toBe('ok')
    // Secret-bearing like voice.json (spec 14 §2.1): owner-only, the
    // snapshot too (titles are listener data).
    expect(statSync(path).mode & 0o777).toBe(0o600)
    store.writeSnapshot({ source: 'netease', takenAt: 'x', items: [] })
    expect(statSync(store.snapshotPath('netease')).mode & 0o777).toBe(0o600)
  })

  it('flips status through the same file the flow writes, keeping the entry', () => {
    const { path, taste } = home()
    const store = new SourcesStore({ path, tasteDir: taste })
    store.mount('youtube', { browser: 'firefox' })
    store.setStatus('youtube', 'expired', 'cookies are no longer valid')
    expect(store.read().youtube).toMatchObject({ browser: 'firefox', status: 'expired', lastError: 'cookies are no longer valid' })
    store.setStatus('youtube', 'ok')
    expect(store.read().youtube).toMatchObject({ status: 'ok' })
    expect(store.read().youtube).not.toHaveProperty('lastError')
    // A status for something not mounted is a no-op, never a phantom entry.
    store.setStatus('spotify', 'expired')
    expect(store.read()).not.toHaveProperty('spotify')
  })

  it('re-reads before every write so a flip landing mid-flow is never lost', () => {
    const { path, taste } = home()
    const a = new SourcesStore({ path, tasteDir: taste })
    const b = new SourcesStore({ path, tasteDir: taste })
    a.mount('youtube', { browser: 'firefox' })
    b.setStatus('youtube', 'expired')
    a.mount('bilibili', { browser: 'firefox', mid: '9' })
    expect(a.read().youtube?.status).toBe('expired')
    expect(a.mounted()).toEqual(['youtube', 'bilibili'])
  })

  it('writes, reads and deletes a snapshot beside the file, under data/taste', () => {
    const { path, taste } = home()
    const store = new SourcesStore({ path, tasteDir: taste })
    const snapshot: TasteSnapshot = { source: 'netease', takenAt: '2026-09-06T10:00:00.000Z', items: [{ kind: 'liked', title: 'a' }] }
    store.writeSnapshot(snapshot)
    expect(store.readSnapshot('netease')).toEqual(snapshot)
    expect(existsSync(join(taste, 'netease.json'))).toBe(true)
    store.mount('netease', { browser: 'chrome', userId: '42', likedPlaylistId: '7' })
    store.unmount('netease')
    expect(store.mounted()).toEqual([])
    expect(store.readSnapshot('netease')).toBeNull()
    expect(existsSync(join(taste, 'netease.json'))).toBe(false)
  })

  it('stamps a refresh on the entry', () => {
    const { path, taste } = home()
    const store = new SourcesStore({ path, tasteDir: taste })
    store.mount('youtube', { browser: 'firefox' })
    store.markRefreshed('youtube', new Date('2026-09-06T12:00:00Z'))
    expect(store.read().youtube?.lastRefresh).toBe('2026-09-06T12:00:00.000Z')
  })

  it('patches an entry (a rotated Spotify token) without touching the rest', () => {
    const { path, taste } = home()
    const store = new SourcesStore({ path, tasteDir: taste })
    store.mount('spotify', { clientId: 'c', refreshToken: '<redacted-1>', accessToken: '<redacted-a>', expiresAt: '2026-09-06T00:00:00.000Z' })
    store.patch('spotify', { refreshToken: '<redacted-2>' })
    expect(store.read().spotify).toMatchObject({ clientId: 'c', refreshToken: '<redacted-2>', status: 'ok' })
  })
})

describe('cookieArgs (spec 14 §2.5)', () => {
  const file = { netease: NETEASE, youtube: { browser: 'brave' as const, profile: 'Profile 1', mountedAt: 'x', status: 'ok' as const } }

  it('passes the browser for a mounted host, profile included', () => {
    expect(cookieArgs('https://music.163.com/#/song?id=1', file)).toEqual(['--cookies-from-browser', 'chrome'])
    expect(cookieArgs('https://www.youtube.com/watch?v=x', file)).toEqual(['--cookies-from-browser', 'brave:Profile 1'])
    expect(cookieArgs('https://youtu.be/x', file)).toEqual(['--cookies-from-browser', 'brave:Profile 1'])
    expect(cookieArgs('https://music.youtube.com/watch?v=x', file)).toEqual(['--cookies-from-browser', 'brave:Profile 1'])
  })

  it('is empty with no mount for the host, for an unknown host, and for a non-URL ref', () => {
    expect(cookieArgs('https://www.bilibili.com/video/BV1', file)).toEqual([])
    expect(cookieArgs('https://example.com/x', file)).toEqual([])
    expect(cookieArgs('BV1xx', file)).toEqual([])
    expect(cookieArgs('https://www.youtube.com/watch?v=x', {})).toEqual([])
  })

  it('an expired mount still passes the cookie — yt-dlp is what says whether it works', () => {
    expect(cookieArgs('https://www.youtube.com/watch?v=x', { youtube: { ...file.youtube, status: 'expired' } })).toEqual([
      '--cookies-from-browser',
      'brave:Profile 1',
    ])
  })

  it('names the source a ref belongs to', () => {
    expect(sourceOfRef('https://b23.tv/abc')).toBe('bilibili')
    expect(sourceOfRef('https://163cn.tv/abc')).toBe('netease')
    expect(sourceOfRef('https://example.com')).toBeNull()
    expect(sourceOfRef('not a url')).toBeNull()
  })
})
