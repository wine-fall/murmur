// The taste digest (spec 14 §2.3): a pure, bounded, deterministic render of
// the snapshots, and the reader that memoises it on the files' mtimes.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { renderTasteDigest, TasteReader, type TasteSnapshot } from '../src/music/sources/taste.ts'

const NOW = new Date('2026-09-06T12:00:00Z')

const netease: TasteSnapshot = {
  source: 'netease',
  takenAt: '2026-09-06T10:00:00.000Z',
  items: [
    { kind: 'liked', title: 'Travel Is Meaningful', artist: 'Cheer Chen', at: '2026-09-05T00:00:00.000Z' },
    { kind: 'liked', title: 'Groupies', artist: 'Cheer Chen ', at: '2026-09-04T00:00:00.000Z' },
    { kind: 'liked', title: 'Holocene', artist: 'Bon Iver', at: '2026-09-03T00:00:00.000Z' },
    { kind: 'liked', title: '', artist: 'Nobody' },
    { kind: 'playlist', title: 'late drive' },
    { kind: 'playlist', title: 'deep focus' },
  ],
}

const spotify: TasteSnapshot = {
  source: 'spotify',
  takenAt: '2026-08-01T10:00:00.000Z',
  items: [
    { kind: 'top-artist', title: 'Bon Iver' },
    { kind: 'top-artist', title: 'Ryuichi Sakamoto' },
    { kind: 'top-track', title: 'Merry Christmas Mr. Lawrence', artist: 'Ryuichi Sakamoto' },
    { kind: 'liked', title: 'Re: Stacks', artist: 'Bon Iver' },
    { kind: 'playlist', title: 'Liked from Radio' },
  ],
}

describe('renderTasteDigest', () => {
  it('renders nothing with no snapshots', () => {
    expect(renderTasteDigest([], NOW)).toBe('')
  })

  it('matches the golden shape: header, sources, artists by count, recent, playlists, platform lists', () => {
    const digest = renderTasteDigest([netease, spotify], NOW)
    expect(digest).toBe(
      [
        '## What the listener keeps (as of 2026-09-06)',
        'Sources: NetEase (3 liked, 2 playlists), Spotify (1 liked, 1 playlist, top 2 artists, top 1 track; as of 2026-08-01)',
        'Artists they return to: Bon Iver (3), Cheer Chen (2), Ryuichi Sakamoto (2)',
        'Recently kept: "Travel Is Meaningful" Cheer Chen · "Groupies" Cheer Chen · "Holocene" Bon Iver · "Re: Stacks" Bon Iver',
        'Playlists: late drive, deep focus, Liked from Radio',
        'Spotify says (top, medium term): artists — Bon Iver, Ryuichi Sakamoto; tracks — "Merry Christmas Mr. Lawrence" Ryuichi Sakamoto',
      ].join('\n'),
    )
  })

  it('is deterministic: the same inputs render the same text, in any snapshot order', () => {
    const a = renderTasteDigest([netease, spotify], NOW)
    expect(renderTasteDigest([netease, spotify], NOW)).toBe(a)
    // The source line follows the given order; everything merged is order-free.
    const b = renderTasteDigest([spotify, netease], NOW)
    expect(b.split('\n')[2]).toBe(a.split('\n')[2])
  })

  it('cuts to the budget at a line boundary with a trailing ellipsis', () => {
    const many: TasteSnapshot = {
      source: 'youtube',
      takenAt: netease.takenAt,
      items: Array.from({ length: 300 }, (_, i) => ({ kind: 'liked' as const, title: `song number ${i}`, artist: `artist ${i}` })),
    }
    const digest = renderTasteDigest([many], NOW, 400)
    expect(digest.length).toBeLessThanOrEqual(400)
    expect(digest.endsWith('…')).toBe(true)
    expect(digest.split('\n').every((line) => line === '…' || !line.includes('…'))).toBe(true)
  })

  it('caps the lists: 25 artists, 20 recent, 12 playlists, 10 per platform list', () => {
    const items = [
      ...Array.from({ length: 40 }, (_, i) => ({ kind: 'liked' as const, title: `t${i}`, artist: `a${i}`, at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` })),
      ...Array.from({ length: 20 }, (_, i) => ({ kind: 'playlist' as const, title: `p${i}` })),
      ...Array.from({ length: 15 }, (_, i) => ({ kind: 'top-artist' as const, title: `top${i}` })),
    ]
    const lines = renderTasteDigest([{ source: 'spotify', takenAt: netease.takenAt, items }], NOW, 100_000).split('\n')
    expect(lines[2]!.split(', ')).toHaveLength(25)
    expect(lines[3]!.split(' · ')).toHaveLength(20)
    expect(lines[4]!.split(', ')).toHaveLength(12)
    expect(lines[5]!.split('artists — ')[1]!.split(', ')).toHaveLength(10)
  })

  it('a stale snapshot still renders, stamped with its date', () => {
    const digest = renderTasteDigest([spotify], NOW)
    expect(digest).toContain('as of 2026-08-01')
    expect(digest).toContain('Bon Iver')
  })
})

describe('TasteReader', () => {
  function dir(): string {
    const d = mkdtempSync(join(tmpdir(), 'murmur-taste-'))
    mkdirSync(d, { recursive: true })
    return d
  }

  it('renders from the files on disk and skips a broken one with one log line', () => {
    const d = dir()
    const logs: string[] = []
    writeFileSync(join(d, 'netease.json'), JSON.stringify(netease))
    writeFileSync(join(d, 'spotify.json'), '{ broken')
    const reader = new TasteReader({ dir: d, log: (m) => logs.push(m), now: () => NOW })
    expect(reader.digest()).toBe(renderTasteDigest([netease], NOW))
    expect(logs).toHaveLength(1)
    // A missing directory is simply no taste.
    expect(new TasteReader({ dir: join(d, 'none'), now: () => NOW }).digest()).toBe('')
  })

  it('memoises on the file set and mtimes, re-rendering only when a file changes', () => {
    const d = dir()
    writeFileSync(join(d, 'netease.json'), JSON.stringify(netease))
    const reader = new TasteReader({ dir: d, now: () => NOW })
    const first = reader.digest()
    expect(reader.digest()).toBe(first)
    expect(reader.renders).toBe(1)
    writeFileSync(join(d, 'spotify.json'), JSON.stringify(spotify))
    expect(reader.digest()).not.toBe(first)
    expect(reader.renders).toBe(2)
    // Same content, later mtime: a rewrite is a change worth re-reading.
    utimesSync(join(d, 'spotify.json'), new Date(), new Date(Date.now() + 5_000))
    reader.digest()
    expect(reader.renders).toBe(3)
  })

  it('a snapshot over the 1 MB bound is skipped as a bug, not rendered', () => {
    const d = dir()
    const huge: TasteSnapshot = {
      source: 'youtube',
      takenAt: netease.takenAt,
      items: Array.from({ length: 20_000 }, (_, i) => ({ kind: 'liked' as const, title: `${'x'.repeat(60)}${i}` })),
    }
    writeFileSync(join(d, 'youtube.json'), JSON.stringify(huge))
    const logs: string[] = []
    expect(new TasteReader({ dir: d, log: (m) => logs.push(m), now: () => NOW }).digest()).toBe('')
    expect(logs).toHaveLength(1)
  })
})
