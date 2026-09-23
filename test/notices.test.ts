import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  dismissNotice,
  noticesPath,
  parseNotices,
  pickNotice,
  runNotices,
  type Bubble,
  type Notice,
} from '../src/support/notices.ts'

// Invented fixtures only: no listener data, no real notice copy.
const NOW = Date.parse('2026-09-23T12:00:00Z')
const base = { until: '2026-12-31' }

function notice(id: string, extra: Partial<Notice> = {}): Notice {
  return { id, text: `say ${id}`, ...base, ...extra }
}

describe('parseNotices (spec 10 §3.7.5)', () => {
  it('skips a bad entry and keeps the rest, ignoring unknown fields', () => {
    const parsed = parseNotices([
      { id: 'a', text: 'hello', until: '2026-12-31', level: 'loud' },
      { id: 'b', until: '2026-12-31' }, // no text
      { id: 'c', text: 'x'.repeat(121), until: '2026-12-31' }, // too long
      { id: 'd', text: 'hi', until: 'not a date' },
      'junk',
      { id: 'e', text: 'there', until: '2026-12-31', command: '/update' },
    ])
    expect(parsed.map((n) => n.id)).toEqual(['a', 'e'])
    expect(parsed[0]).not.toHaveProperty('level')
  })
})

describe('pickNotice (spec 10 §3.7.5)', () => {
  const pick = (notices: Notice[], opts: { current?: string; dismissed?: string[] } = {}) =>
    pickNotice(notices, { now: NOW, current: opts.current ?? '0.3.3', dismissed: opts.dismissed ?? [] })?.id

  it('takes the first match in file order', () => {
    expect(pick([notice('a'), notice('b')])).toBe('a')
  })

  it('never shows an expired notice; a bare date counts its whole UTC day', () => {
    expect(pick([notice('old', { until: '2026-09-22' }), notice('b')])).toBe('b')
    expect(pick([notice('today', { until: '2026-09-23' })])).toBe('today')
    expect(pick([notice('past', { until: '2026-09-23T11:00:00Z' })])).toBeUndefined()
  })

  it('honors below (current < below) and since (current >= since)', () => {
    expect(pick([notice('a', { below: '0.3.3' })])).toBeUndefined()
    expect(pick([notice('a', { below: '0.4.0' })])).toBe('a')
    expect(pick([notice('a', { since: '0.3.4' })])).toBeUndefined()
    expect(pick([notice('a', { since: '0.3.3' })])).toBe('a')
    expect(pick([notice('a', { since: '0.3.0', below: '0.10.0' })])).toBe('a')
  })

  it('skips a dismissed id', () => {
    expect(pick([notice('a'), notice('b')], { dismissed: ['a'] })).toBe('b')
    expect(pick([notice('a')], { dismissed: ['a'] })).toBeUndefined()
  })
})

describe('runNotices + dismissNotice (spec 10 §3.7.5)', () => {
  let home: string
  let path: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'murmur-notices-'))
    path = join(home, 'notices.json')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const serve = (body: unknown, ok = true) => async () =>
    new Response(JSON.stringify(body), { status: ok ? 200 : 404 })
  const offline = async (): Promise<Response> => {
    throw new Error('offline')
  }
  const state = () => JSON.parse(readFileSync(path, 'utf8')) as { dismissed: string[]; fetchedAt: number }
  const run = async (fetch: (url: string, init?: RequestInit) => Promise<Response>) => {
    const shown: Bubble[] = []
    await runNotices({ current: '0.3.3', path, url: 'http://feed', fetch, now: () => NOW, show: (b) => shown.push(b) })
    return shown
  }

  it('shows the pick with its hint, and caches the fresh feed', async () => {
    const shown = await run(serve({ v: 1, notices: [notice('a', { command: '/update', url: 'https://x.test' })] }))
    expect(shown).toEqual([{ id: 'a', text: 'say a', hint: 'type /update' }])
    expect(state().fetchedAt).toBe(NOW)
  })

  it('a url alone is the hint; no command or url means no hint', async () => {
    expect(await run(serve({ v: 1, notices: [notice('a', { url: 'https://x.test' })] }))).toEqual([
      { id: 'a', text: 'say a', hint: 'https://x.test' },
    ])
    expect(await run(serve({ v: 1, notices: [notice('b')] }))).toEqual([{ id: 'b', text: 'say b' }])
  })

  it('falls back to the cached feed offline, and shows nothing with no cache', async () => {
    expect(await run(offline)).toEqual([])
    await run(serve({ v: 1, notices: [notice('a')] }))
    expect((await run(offline)).map((b) => b.id)).toEqual(['a'])
    expect((await run(serve({ nope: true }))).map((b) => b.id)).toEqual(['a'])
  })

  it('a dismissed notice stays gone across launches; an undismissed one repeats', async () => {
    const feed = serve({ v: 1, notices: [notice('a'), notice('b')] })
    expect((await run(feed)).map((b) => b.id)).toEqual(['a'])
    expect((await run(feed)).map((b) => b.id)).toEqual(['a'])
    dismissNotice('a', path)
    dismissNotice('a', path)
    expect(state().dismissed).toEqual(['a'])
    expect((await run(feed)).map((b) => b.id)).toEqual(['b'])
  })

  it('prunes dismissed to the fresh feed ids; never on a failed fetch', async () => {
    await run(serve({ v: 1, notices: [notice('a'), notice('b')] }))
    dismissNotice('a', path)
    dismissNotice('b', path)
    await run(offline)
    expect(state().dismissed).toEqual(['a', 'b'])
    await run(serve({ v: 1, notices: [notice('b', { until: '2020-01-01' })] }))
    // Expiry alone keeps the id; leaving the feed drops it.
    expect(state().dismissed).toEqual(['b'])
  })

  it('never rejects, even when the cache cannot be written', async () => {
    writeFileSync(join(home, 'blocker'), '')
    await expect(
      runNotices({
        current: '0.3.3',
        path: join(home, 'blocker', 'notices.json'),
        url: 'http://feed',
        fetch: serve({ v: 1, notices: [notice('a')] }),
        now: () => NOW,
        show: () => {
          throw new Error('host gone')
        },
      }),
    ).resolves.toBeUndefined()
  })

  it('lives under the cache root', () => {
    expect(noticesPath({ MURMUR_HOME: '/h' })).toBe('/h/cache/notices.json')
  })
})
