// The taste digest (spec 14 §2.3): a pure, bounded, deterministic render of
// the snapshots, and the reader that memoises it on the files' mtimes.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { renderTasteDigest, TasteReader, type SourceId, type TasteSnapshot } from '../src/music/sources/taste.ts'

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

// Bilibili's own category names, escaped because committed sources hold no
// CJK (DESIGN §0): "guo chan yuan chuang xiang guan" is the platform's
// original-music sub-zone, "jie wu" is street dance, "mei shi zhi zuo" is
// cooking.
const MUSIC_ZONE = '\u56fd\u4ea7\u539f\u521b\u76f8\u5173'
const DANCE_ZONE = '\u8857\u821e'
const COOKING_ZONE = '\u7f8e\u98df\u5236\u4f5c'

// What the listener has been watching and who they follow (spec 14 §2.3):
// the signal is the watch, not the collection.
const bilibili: TasteSnapshot = {
  source: 'bilibili',
  takenAt: '2026-09-06T09:00:00.000Z',
  items: [
    { kind: 'history', title: 'Popping 1vs1 final', artist: 'mklike', at: '2026-09-05T02:00:00.000Z', category: DANCE_ZONE, ref: 'https://www.bilibili.com/video/BV1a' },
    { kind: 'history', title: 'a city pop set', artist: 'Night Tape', at: '2026-09-04T02:00:00.000Z', category: MUSIC_ZONE, ref: 'https://www.bilibili.com/video/BV1b' },
    { kind: 'history', title: 'braised pork, step by step', artist: 'Chef Wang', at: '2026-09-03T02:00:00.000Z', category: COOKING_ZONE, ref: 'https://www.bilibili.com/video/BV1c' },
    { kind: 'follows', title: 'Night Tape', at: '2026-09-05T03:00:00.000Z', ref: 'https://space.bilibili.com/1' },
    { kind: 'follows', title: 'Chef Wang', at: '2026-09-01T03:00:00.000Z', ref: 'https://space.bilibili.com/2' },
    { kind: 'frequents', title: 'Midnight Haven Jazz', ref: 'https://space.bilibili.com/3' },
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

  it('matches the golden shape: header, sources, artists by count, songs, playlists, platform lists', () => {
    const digest = renderTasteDigest([netease, spotify], NOW)
    expect(digest).toBe(
      [
        '## What the listener keeps (as of 2026-09-06)',
        'Sources: NetEase (3 liked, 2 playlists), Spotify (1 liked, 1 playlist, top 2 artists, top 1 track; as of 2026-08-01)',
        'Artists they return to: Bon Iver (3), Cheer Chen (2), Ryuichi Sakamoto (2)',
        'Playlists: late drive, deep focus, Liked from Radio',
        'Songs they keep: "Travel Is Meaningful" Cheer Chen · "Groupies" Cheer Chen · "Holocene" Bon Iver · "Re: Stacks" Bon Iver',
        'Spotify says (top, medium term): artists — Bon Iver, Ryuichi Sakamoto; tracks — "Merry Christmas Mr. Lawrence" Ryuichi Sakamoto',
      ].join('\n'),
    )
  })

  // A returning listener keeps yesterday's bilibili.json until the next
  // refresh, and that file still holds favourites and folder names. Nothing
  // produces those rows any more, so the render drops them outright — the
  // invariant has to hold on an old snapshot too, not only on a fresh read.
  it('ignores an old snapshot\'s favourites and folder names, keeping the musical source beside it', () => {
    const old: TasteSnapshot = {
      source: 'bilibili',
      takenAt: '2026-09-05T09:00:00.000Z',
      items: [
        { kind: 'playlist', title: 'default folder' },
        { kind: 'playlist', title: 'algorithms' },
        { kind: 'playlist', title: 'back end' },
        { kind: 'favourite', title: 'a Java course, lesson 12', artist: 'a course channel', at: '2026-09-04T00:00:00.000Z' },
        { kind: 'favourite', title: 'braised pork, step by step', artist: 'a cooking channel', at: '2026-09-03T00:00:00.000Z' },
        { kind: 'history', title: 'a city pop set', artist: 'Night Tape', at: '2026-09-04T02:00:00.000Z', category: MUSIC_ZONE },
        { kind: 'liked', title: 'My upload', artist: 'FAWineLL' },
      ],
    }
    // The same for YouTube's liked list, which is collected in the same way.
    const oldYouTube: TasteSnapshot = {
      source: 'youtube',
      takenAt: '2026-09-05T09:00:00.000Z',
      items: [
        { kind: 'liked', title: 'a video they thumbed up once', artist: 'some channel' },
        { kind: 'subscription', title: 'a fresh upload', artist: 'a channel they follow' },
      ],
    }
    const digest = renderTasteDigest([old, oldYouTube, netease], NOW)
    for (const gone of ['default folder', 'algorithms', 'back end', 'a Java course, lesson 12', 'braised pork, step by step', 'a course channel', 'a cooking channel', 'a video they thumbed up once', 'some channel']) {
      expect(digest).not.toContain(gone)
    }
    // The counts stop claiming them too, and what is still taste still shows.
    expect(digest).toContain('Bilibili (1 liked, history 1)')
    expect(digest).toContain('YouTube (1 subscription)')
    expect(digest).toContain('Playlists: late drive, deep focus')
    expect(digest).toContain('a city pop set')
    expect(digest).toContain('Songs they keep:')
    // A snapshot left with nothing to say drops out of the source list
    // rather than standing there as an empty pair of brackets.
    const emptied = renderTasteDigest([{ source: 'bilibili', takenAt: old.takenAt, items: old.items.filter((i) => i.kind === 'favourite' || i.kind === 'playlist') }, netease], NOW)
    expect(emptied).not.toContain('Bilibili')
    expect(emptied).toContain('Sources: NetEase (3 liked, 2 playlists)')
  })

  // spec 14 §2.3: the digest is layered by what the signal IS. What the
  // listener watched and who they follow lead; a music-zone row outranks a
  // cooking one inside the watch layer.
  it('leads with what they watched lately, music categories first, then who they follow', () => {
    const digest = renderTasteDigest([netease, bilibili], NOW)
    expect(digest).toBe(
      [
        '## What the listener keeps (as of 2026-09-06)',
        'Sources: NetEase (3 liked, 2 playlists), Bilibili (history 3, 2 recently followed, 1 they go back to)',
        `Lately they have been listening to / watching: "a city pop set" Night Tape (${MUSIC_ZONE}) · "Popping 1vs1 final" mklike (${DANCE_ZONE}) · "braised pork, step by step" Chef Wang (${COOKING_ZONE})`,
        'Recently followed: Night Tape, Chef Wang',
        'Who they keep going back to: Midnight Haven Jazz',
        'Artists they return to: Cheer Chen (2), Bon Iver (1)',
        'Playlists: late drive, deep focus',
        'Songs they keep: "Travel Is Meaningful" Cheer Chen · "Groupies" Cheer Chen · "Holocene" Bon Iver',
      ].join('\n'),
    )
  })

  // The listener's decision (spec 14 §2.3): a watched video's uploader is not
  // an artist, and a channel they follow is not one either — only the musical
  // rows feed the count, or a Java course channel outranks every musician.
  it('counts artists from musical rows alone, never from a watch or a follow', () => {
    const digest = renderTasteDigest([bilibili], NOW)
    expect(digest).not.toContain('Artists they return to')
    expect(digest).not.toContain('Chef Wang (1)')
    expect(digest).not.toContain('Night Tape (1)')
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
      source: 'netease',
      takenAt: netease.takenAt,
      items: Array.from({ length: 300 }, (_, i) => ({ kind: 'liked' as const, title: `song number ${i}`, artist: `artist ${i}` })),
    }
    const digest = renderTasteDigest([many], NOW, 400)
    expect(digest.length).toBeLessThanOrEqual(400)
    // A layer that ran out of room ends at an item boundary with an ellipsis,
    // and so does the block itself.
    expect(digest.endsWith('…')).toBe(true)
    expect(digest.split('\n').every((line) => !line.includes('…') || line.endsWith('…'))).toBe(true)
  })

  it('caps the lists: 25 artists, 20 songs, 12 playlists, 10 per platform list', () => {
    const items = [
      ...Array.from({ length: 40 }, (_, i) => ({ kind: 'liked' as const, title: `t${i}`, artist: `a${i}`, at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` })),
      ...Array.from({ length: 20 }, (_, i) => ({ kind: 'playlist' as const, title: `p${i}` })),
      ...Array.from({ length: 15 }, (_, i) => ({ kind: 'top-artist' as const, title: `top${i}` })),
    ]
    const lines = renderTasteDigest([{ source: 'spotify', takenAt: netease.takenAt, items }], NOW, 100_000).split('\n')
    expect(lines[2]!.split(', ')).toHaveLength(25)
    expect(lines[3]!.split(', ')).toHaveLength(12)
    expect(lines[4]!.split(' · ')).toHaveLength(20)
    expect(lines[5]!.split('artists — ')[1]!.split(', ')).toHaveLength(10)
  })

  // Found on the real snapshot (2026-09-16): 200 watched rows with long
  // titles filled all 1500 characters by themselves, and the musical source
  // beside them never reached the page. Every layer gets a share of the
  // budget, so no one of them can crowd the others out.
  it('no single layer eats the budget: the musical source still speaks beside a full watch history', () => {
    const crowded: TasteSnapshot = {
      source: 'bilibili',
      takenAt: bilibili.takenAt,
      items: [
        ...Array.from({ length: 200 }, (_, i) => ({ kind: 'history' as const, title: `a very long watched title that goes on and on, number ${i}`, artist: `channel with a long name ${i}`, category: MUSIC_ZONE, at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z` })),
        ...Array.from({ length: 50 }, (_, i) => ({ kind: 'follows' as const, title: `a channel they followed lately ${i}` })),
        ...Array.from({ length: 50 }, (_, i) => ({ kind: 'frequents' as const, title: `a channel they go back to ${i}` })),
      ],
    }
    const big: TasteSnapshot = {
      source: 'netease',
      takenAt: netease.takenAt,
      items: [
        ...Array.from({ length: 186 }, (_, i) => ({ kind: 'liked' as const, title: `song number ${i}`, artist: `artist ${i % 30}`, at: `2026-0${(i % 9) + 1}-01T00:00:00.000Z` })),
        ...Array.from({ length: 50 }, (_, i) => ({ kind: 'playlist' as const, title: `playlist ${i}` })),
      ],
    }
    const digest = renderTasteDigest([crowded, big], NOW)
    expect(digest.length).toBeLessThanOrEqual(1500)
    for (const lead of ['Lately they have been listening to / watching:', 'Recently followed:', 'Who they keep going back to:', 'Artists they return to:', 'Playlists:', 'Songs they keep:']) {
      expect(digest).toContain(lead)
    }
    expect(digest).toContain('playlist 0')
    expect(digest).toContain('artist 0 (')
  })

  // codex review: a layer sized to the very last character left the block two
  // characters over what the final line-boundary cut allows, and that cut
  // dropped the whole layer rather than trimming it.
  it('a layer that fills the budget exactly is trimmed, never dropped', () => {
    const long: TasteSnapshot = {
      source: 'youtube',
      takenAt: netease.takenAt,
      items: Array.from({ length: 200 }, (_, i) => ({ kind: 'history' as const, title: `${'t'.repeat(72)}${String(i).padStart(4, '0')}` })),
    }
    const digest = renderTasteDigest([long], NOW)
    expect(digest.length).toBeLessThanOrEqual(1500)
    expect(digest).toContain('Lately they have been listening to / watching:')
    expect(digest.split('\n').at(-1)).not.toBe('\u2026')
  })

  it('stays inside the budget with every kind present', () => {
    const crowded: TasteSnapshot = {
      source: 'bilibili',
      takenAt: bilibili.takenAt,
      items: [
        ...Array.from({ length: 200 }, (_, i) => ({ kind: 'history' as const, title: `watched number ${i}`, artist: `channel ${i}`, category: i % 2 === 0 ? MUSIC_ZONE : COOKING_ZONE, at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z` })),
        ...Array.from({ length: 50 }, (_, i) => ({ kind: 'follows' as const, title: `followed ${i}`, at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z` })),
        ...Array.from({ length: 50 }, (_, i) => ({ kind: 'frequents' as const, title: `revisited ${i}` })),
      ],
    }
    const digest = renderTasteDigest([crowded, netease, spotify], NOW)
    expect(digest.length).toBeLessThanOrEqual(1500)
    expect(digest.split('\n')[0]).toBe('## What the listener keeps (as of 2026-09-06)')
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

  // spec 14 §5.1: with nothing mounted the pack carries no taste. A snapshot
  // file can outlive its mount — a corrupt sources.json, a process that died
  // between the unmount and the delete — and account-derived titles must not
  // keep reaching the brain on the strength of a leftover file.
  it('renders only what is mounted, and nothing at all when nothing is', () => {
    const d = dir()
    writeFileSync(join(d, 'netease.json'), JSON.stringify(netease))
    writeFileSync(join(d, 'spotify.json'), JSON.stringify(spotify))
    let mounted: SourceId[] = []
    const reader = new TasteReader({ dir: d, mounted: () => mounted, now: () => NOW })
    expect(reader.digest()).toBe('')
    mounted = ['netease']
    expect(reader.digest()).toBe(renderTasteDigest([netease], NOW))
    mounted = ['netease', 'spotify']
    expect(reader.digest()).toBe(renderTasteDigest([netease, spotify], NOW))
    // The mounted set is part of the memo key, so an unmount lands at once.
    mounted = []
    expect(reader.digest()).toBe('')
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
