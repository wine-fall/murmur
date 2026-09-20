// The taste digest (spec 14 §2.3): a pure, bounded, deterministic render of
// the snapshots, and the reader that memoises it on the files' mtimes.
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { LedgerEntry, TasteLedger } from '../src/music/sources/ledger.ts'
import type { Moment } from '../src/music/sources/moment.ts'
import { DIGEST_BUDGET, renderTasteDigest, TasteReader, TasteSnapshotSchema, type SourceId, type TasteKind, type TasteSnapshot } from '../src/music/sources/taste.ts'

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
    // Bilibili's own audio uploads are songs; its watch row is not shown, and
    // YouTube is left with nothing countable at all.
    expect(digest).toContain('Bilibili (1 liked)')
    expect(digest).not.toContain('YouTube')
    expect(digest).toContain('Playlists: late drive, deep focus')
    expect(digest).not.toContain('a city pop set')
    expect(digest).toContain('Songs they keep:')
    // A snapshot left with nothing to say drops out of the source list
    // rather than standing there as an empty pair of brackets.
    const emptied = renderTasteDigest([{ source: 'bilibili', takenAt: old.takenAt, items: old.items.filter((i) => i.kind === 'favourite' || i.kind === 'playlist') }, netease], NOW)
    expect(emptied).not.toContain('Bilibili')
    expect(emptied).toContain('Sources: NetEase (3 liked, 2 playlists)')
  })

  // spec 14 §2.3, the invariant: every row traces to a source that carries
  // nothing but songs, or to an artist name that matched. A video platform
  // saying a row is music is not a guarantee - measured on the listener's own
  // snapshot, 3 of the 4 Bilibili rows carrying a music sub-zone were gossip
  // clips their uploader had filed there.
  it('shows no watch or follow row from a video platform, counts included', () => {
    const digest = renderTasteDigest([netease, bilibili], NOW)
    expect(digest).toBe(
      [
        '## What the listener keeps (as of 2026-09-06)',
        'Sources: NetEase (3 liked, 2 playlists)',
        'Artists they return to: Cheer Chen (2), Bon Iver (1)',
        'Playlists: late drive, deep focus',
        'Songs they keep: "Travel Is Meaningful" Cheer Chen \u00b7 "Groupies" Cheer Chen \u00b7 "Holocene" Bon Iver',
      ].join('\n'),
    )
    // Not the music-zone row either: the zone tag is a scoring signal for the
    // retrieval pool (spec 14 §2.12), never a ticket into the block.
    for (const gone of ['a city pop set', 'Popping 1vs1 final', 'Night Tape', 'Chef Wang', 'Midnight Haven Jazz', 'Recently followed', 'Who they keep going back to']) {
      expect(digest).not.toContain(gone)
    }
  })

  // A songs-only platform has nothing to vouch for: everything it returns is
  // a song, so its watch rows are the one 'Lately' the block will show.
  it('shows a songs-only source\'s watch rows, newest first', () => {
    const played: TasteSnapshot = {
      source: 'qqmusic',
      takenAt: '2026-09-06T08:00:00.000Z',
      items: [
        { kind: 'history', title: 'Sea of Nightfall', artist: 'Lonely Leary', at: '2026-09-06T07:00:00.000Z' },
        { kind: 'history', title: 'Slow Train', artist: 'Wu Tsing-Fong', at: '2026-09-06T06:00:00.000Z' },
      ],
    }
    const digest = renderTasteDigest([netease, played], NOW)
    expect(digest).toContain('Lately they have been listening to: "Sea of Nightfall" Lonely Leary \u00b7 "Slow Train" Wu Tsing-Fong')
    expect(digest).toContain('QQ Music (history 2)')
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

  it('caps the lists: 25 artists, 40 songs, 12 playlists, 10 per platform list', () => {
    const items = [
      ...Array.from({ length: 40 }, (_, i) => ({ kind: 'liked' as const, title: `t${i}`, artist: `a${i}`, at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` })),
      ...Array.from({ length: 20 }, (_, i) => ({ kind: 'playlist' as const, title: `p${i}` })),
      ...Array.from({ length: 15 }, (_, i) => ({ kind: 'top-artist' as const, title: `top${i}` })),
    ]
    const lines = renderTasteDigest([{ source: 'spotify', takenAt: netease.takenAt, items }], NOW, 100_000).split('\n')
    expect(lines[2]!.split(', ')).toHaveLength(25)
    expect(lines[3]!.split(', ')).toHaveLength(12)
    expect(lines[4]!.split(' · ')).toHaveLength(40)
    expect(lines[5]!.split('artists — ')[1]!.split(', ')).toHaveLength(10)
  })

  // Found on the real snapshot (2026-09-16): 200 watched rows with long
  // titles filled all 1500 characters by themselves, and the musical source
  // beside them never reached the page. Measured again 2026-09-18: with the
  // watch rows leading, 'Songs they keep' held 14 of 186 liked songs. The
  // budget now runs fixed half first (300 at most), then the songs.
  it('spends the flexible budget on the songs, with the watch rows behind them', () => {
    const played: TasteSnapshot = {
      source: 'qqmusic',
      takenAt: '2026-09-06T08:00:00.000Z',
      items: Array.from({ length: 40 }, (_, i) => ({ kind: 'history' as const, title: `a long title for a track just played, number ${i}`, artist: `a player ${i}`, at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z` })),
    }
    const big: TasteSnapshot = {
      source: 'netease',
      takenAt: netease.takenAt,
      items: [
        ...Array.from({ length: 186 }, (_, i) => ({ kind: 'liked' as const, title: `song number ${i}`, artist: `artist ${i % 30}`, at: `2026-0${(i % 9) + 1}-01T00:00:00.000Z` })),
        ...Array.from({ length: 50 }, (_, i) => ({ kind: 'playlist' as const, title: `playlist ${i}` })),
      ],
    }
    const digest = renderTasteDigest([played, big], NOW)
    expect(digest.length).toBeLessThanOrEqual(1500)
    const line = (lead: string): string => digest.split('\n').find((l) => l.startsWith(`${lead}: `))!
    // The fixed half is the listener's shape and is held to 300 characters,
    // so the songs get what is left (spec 14 \u00a72.3).
    const fixed = ['Sources', 'Artists they return to', 'Playlists'].map(line)
    expect(fixed.join('\n').length).toBeLessThanOrEqual(300)
    expect(line('Songs they keep').split(' \u00b7 ').length).toBeGreaterThanOrEqual(30)
    // Weight 1 against the songs' 3: the watch rows still speak, briefly.
    expect(line('Lately they have been listening to')).toContain('a long title for a track just played')
  })

  // codex review: a layer sized to the very last character left the block two
  // characters over what the final line-boundary cut allows, and that cut
  // dropped the whole layer rather than trimming it.
  it('a layer that fills the budget exactly is trimmed, never dropped', () => {
    const long: TasteSnapshot = {
      source: 'netease',
      takenAt: netease.takenAt,
      items: Array.from({ length: 200 }, (_, i) => ({ kind: 'liked' as const, title: `${'t'.repeat(72)}${String(i).padStart(4, '0')}` })),
    }
    const digest = renderTasteDigest([long], NOW)
    expect(digest.length).toBeLessThanOrEqual(1500)
    expect(digest).toContain('Songs they keep:')
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

  // codex review: Sources was served first and alone out of the whole fixed
  // half, so three verbose source summaries (198 characters with their
  // staleness stamps) spent all of it and 'Artists they return to' vanished
  // outright. It gets half the half now; the shape lines get the other half.
  it('a long Sources line cannot eat the artists and the playlists', () => {
    // Three sources, all stale enough to carry their date, and Spotify's
    // summary naming four kinds: 198 characters of Sources on its own.
    const verbose = (source: SourceId, kinds: readonly TasteKind[]): TasteSnapshot => ({
      source,
      takenAt: '2026-06-01T00:00:00.000Z',
      items: kinds.flatMap((kind) => Array.from({ length: kind === 'liked' ? 500 : 50 }, (_, i) => ({ kind, title: kind === 'playlist' ? `mood ${i}` : `song ${i}`, artist: 'Ryuichi Sakamoto' }))),
    })
    const digest = renderTasteDigest(
      [verbose('netease', ['liked', 'playlist']), verbose('spotify', ['liked', 'playlist', 'top-artist', 'top-track']), verbose('qqmusic', ['liked', 'playlist'])],
      NOW,
    )
    expect(digest).toContain('Artists they return to: ')
    expect(digest).toContain('Playlists: ')
    expect(digest).toContain('Songs they keep: ')
  })

  // codex review: the platform top lists were appended after the budget was
  // spent, so widening the song layer pushed them off the block entirely
  // while the Sources line went on counting them. They take a share now.
  it('a platform top list keeps its share beside a long liked list', () => {
    const snapshot: TasteSnapshot = {
      source: 'spotify',
      takenAt: '2026-09-06T10:00:00.000Z',
      items: [
        ...Array.from({ length: 60 }, (_, i) => ({ kind: 'liked' as const, title: `a rather long favourite track title ${i}`, artist: `Artist ${i % 4}` })),
        { kind: 'top-track', title: 'Merry Christmas Mr. Lawrence', artist: 'Ryuichi Sakamoto' },
      ],
    }
    const digest = renderTasteDigest([snapshot], NOW)
    expect(digest).toContain('Spotify says (top, medium term):')
    expect(digest).toContain('Merry Christmas Mr. Lawrence')
  })

  it('a stale snapshot still renders, stamped with its date', () => {
    const digest = renderTasteDigest([spotify], NOW)
    expect(digest).toContain('as of 2026-08-01')
    expect(digest).toContain('Bon Iver')
  })
})

// spec 14 §5.14. The fixture (test/fixtures/taste, see its README) invents
// every row but keeps the kind counts a real mount of each platform returns,
// which is what puts the 1500-character budget under real pressure -- a
// handful of rows never would.
describe('renderTasteDigest on a full set of snapshots', () => {
  const real = ['bilibili', 'netease', 'qqmusic', 'youtube'].map(
    (name) => TasteSnapshotSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'taste', `${name}.json`), 'utf-8'))),
  )
  const digest = renderTasteDigest(real, new Date('2026-09-18T20:00:00Z'))
  const line = (lead: string): string | undefined => digest.split('\n').find((l) => l.startsWith(`${lead}: `))

  // The layering this replaces left 4 of the 186 kept tracks on the page,
  // because the watch and follow rows were served first. If the budget ever
  // runs that way again, this count collapses and the test says so.
  it('gives the songs at least 25 of the 186 kept tracks', () => {
    expect(line('Songs they keep')!.split(' · ').length).toBeGreaterThanOrEqual(25)
  })

  it('holds the fixed half to 300 characters and the block to 1500', () => {
    const fixed = ['Sources', 'Artists they return to', 'Playlists'].map((lead) => line(lead)!)
    expect(fixed.every((l) => l !== undefined)).toBe(true)
    expect(fixed.join('\n').length).toBeLessThanOrEqual(300)
    expect(digest.length).toBeLessThanOrEqual(1500)
  })

  // spec 14 §5.16, on the same full-size fixture: given a moment whose last
  // song is by one of its artists, the selection leads with rows the terms
  // matched and never offers the artist that just played.
  it('picks for the moment and never offers the artist just played', () => {
    const ledgers = real
      .filter((s) => s.source === 'netease' || s.source === 'qqmusic')
      .map((s) => ({
        source: s.source,
        lastRead: { liked: s.takenAt, playlist: s.takenAt },
        entries: s.items.map((item) => ({ ...item, lastSeen: s.takenAt })),
      }))
    const moment: Moment = {
      hour: 16,
      persona: 'a quiet afternoon host',
      lastTalk: 'that was Static Meadow, off a long train sort of afternoon',
      avoidArtists: ['Static Meadow'],
    }
    const songs = (m?: Moment): string[] => {
      const line = renderTasteDigest(real, new Date('2026-09-18T20:00:00Z'), DIGEST_BUDGET, ledgers, m)
        .split('\n')
        .find((l) => l.startsWith('Songs they keep: '))!
      return line.slice('Songs they keep: '.length).split(' \u00b7 ')
    }
    const picked = songs(moment)
    // The artist just played is out, and so is the collaboration credit that
    // opens the same line without a moment -- though they are the ledger's
    // most-kept name, with 15 rows.
    expect(picked.join(' ')).not.toContain('Static Meadow')
    expect(songs()[0]).toContain('Static Meadow')
    // Every leading row carries a word the moment brought: the talk beat's
    // and the persona's, not the newest rows the static render would give.
    for (const row of picked.slice(0, 8)) expect(row.toLowerCase()).toMatch(/meadow|quiet|train|afternoon|long|sort/)
    // And it is still a full line, not a handful of matches: relevance
    // decides the order, the budget still decides the length.
    expect(picked.length).toBeGreaterThanOrEqual(20)
  })

  it('shows nothing a video platform merely watched or followed', () => {
    expect(digest).not.toContain('row ')
    expect(digest).not.toContain('channel ')
    expect(digest).not.toContain('Recently followed')
    expect(digest).not.toContain('Who they keep going back to')
    expect(digest).not.toContain('Bilibili (')
    expect(digest).not.toContain('YouTube (')
  })
})

// spec 14 §2.3 as amended: "they return to" is a claim about months, not
// about the 500 rows the last read happened to carry, so the count comes
// from the ledger when there is one.
describe('artist counts from the ledger', () => {
  const entry = (title: string, artist: string, lastSeen = '2026-09-01T00:00:00.000Z'): LedgerEntry => ({
    kind: 'liked',
    title,
    artist,
    key: `${title}|${artist}`,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen,
    seen: 3,
  })

  it('counts the ledger\'s distinct musical entries, not the snapshot\'s', () => {
    const snapshot: TasteSnapshot = {
      source: 'netease',
      takenAt: '2026-09-06T10:00:00.000Z',
      items: [{ kind: 'liked', title: 'the one still in the window', artist: 'Cheer Chen' }],
    }
    const ledger: TasteLedger = {
      source: 'netease',
      updatedAt: '2026-09-06T10:00:00.000Z',
      // Eleven kept over the months; the rolling window can only show one.
      entries: Array.from({ length: 11 }, (_, i) => entry(`kept ${i}`, 'Cheer Chen')),
    }
    expect(renderTasteDigest([snapshot], NOW)).toContain('Cheer Chen (1)')
    expect(renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [ledger])).toContain('Cheer Chen (11)')
  })

  it('falls back to the snapshot for a source with no ledger yet', () => {
    const withLedger: TasteSnapshot = { source: 'netease', takenAt: '2026-09-06T10:00:00.000Z', items: [{ kind: 'liked', title: 'a', artist: 'Bon Iver' }] }
    const without: TasteSnapshot = { source: 'qqmusic', takenAt: '2026-09-06T10:00:00.000Z', items: [{ kind: 'liked', title: 'b', artist: 'Aimer' }] }
    const ledger: TasteLedger = { source: 'netease', updatedAt: '', entries: [entry('a', 'Bon Iver'), entry('c', 'Bon Iver')] }
    const digest = renderTasteDigest([withLedger, without], NOW, DIGEST_BUDGET, [ledger])
    expect(digest).toContain('Bon Iver (2)')
    expect(digest).toContain('Aimer (1)')
  })

  it('holds the same invariant over the ledger: no row a video platform merely watched', () => {
    const snapshot: TasteSnapshot = { source: 'bilibili', takenAt: '2026-09-06T10:00:00.000Z', items: [{ kind: 'liked', title: 'my upload', artist: 'FAWineLL' }] }
    const ledger: TasteLedger = {
      source: 'bilibili',
      updatedAt: '',
      entries: [entry('my upload', 'FAWineLL'), { ...entry('a gossip clip', 'a chat channel'), kind: 'history' }],
    }
    const digest = renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [ledger])
    expect(digest).toContain('FAWineLL (1)')
    expect(digest).not.toContain('a chat channel')
  })
})

// spec 14 §2.12: with a moment in hand the flexible half's rows are chosen
// against the ledger for the pick that is happening, not rendered newest
// first. The fixed half, the budget and the line shapes do not move.
describe('the moment-matched half', () => {
  const led = (title: string, artist: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    kind: 'liked',
    title,
    artist,
    key: `${title}|${artist}`,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-09-06T00:00:00.000Z',
    seen: 2,
    ...over,
  })
  const snapshot: TasteSnapshot = {
    source: 'netease',
    takenAt: '2026-09-06T10:00:00.000Z',
    items: [{ kind: 'liked', title: 'whatever the window holds', artist: 'Low Antenna' }],
  }
  const ledger: TasteLedger = {
    source: 'netease',
    updatedAt: '2026-09-06T00:00:00.000Z',
    lastRead: { liked: '2026-09-06T00:00:00.000Z' },
    entries: [
      led('a quiet one', 'Umber Radio'),
      led('the harbour song', 'Paper Ferries'),
      led('another harbour song', 'Harbour Weather'),
      led('one they just heard', 'Static Meadow'),
    ],
  }
  const moment: Moment = { hour: 16, persona: '', lastTalk: 'that was Harbour Weather', avoidArtists: ['Static Meadow'] }

  it('leads the songs with what the moment matched, and drops the artist just played', () => {
    const line = renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [ledger], moment)
      .split('\n')
      .find((l) => l.startsWith('Songs they keep: '))!
    expect(line).toMatch(/^Songs they keep: "another harbour song" Harbour Weather/)
    expect(line).toContain('"the harbour song" Paper Ferries')
    expect(line).not.toContain('Static Meadow')
  })

  it('without a moment it renders the snapshot, exactly as before', () => {
    const before = renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [ledger])
    expect(before).toContain('"whatever the window holds" Low Antenna')
    expect(before).not.toContain('the harbour song')
  })

  it('with a moment but no ledger it renders the snapshot too', () => {
    const digest = renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [], moment)
    expect(digest).toContain('"whatever the window holds" Low Antenna')
  })

  // codex review: the candidate pool was built from the ledgers alone, so a
  // source whose ledger is missing, unreadable or empty lost its songs from
  // the pick entirely -- while the Sources line went on counting them.
  it('keeps a source whose ledger is missing or empty, per source', () => {
    const spotify: TasteSnapshot = {
      source: 'spotify',
      takenAt: '2026-09-06T10:00:00.000Z',
      items: [{ kind: 'liked', title: 'only in the snapshot', artist: 'Slow Marina' }],
    }
    const empty: TasteLedger = { source: 'spotify', updatedAt: '', entries: [] }
    for (const ledgers of [[ledger], [ledger, empty]]) {
      const digest = renderTasteDigest([snapshot, spotify], NOW, DIGEST_BUDGET, ledgers, moment)
      expect(digest).toContain('"only in the snapshot" Slow Marina')
      // ...and the source that does have one is still chosen from it.
      expect(digest).toContain('another harbour song')
    }
  })

  // codex review: `lastSeen` is a READ time, so every row of one refresh
  // shares it and the order falls to insertion -- which is not the newest
  // first the static render gives. With nothing matched there is no moment
  // signal, so the render must be the one it would have been.
  it('is byte-identical to the static render when the moment matches nothing', () => {
    const silent: Moment = { hour: 16, persona: '', lastTalk: '', avoidArtists: [] }
    expect(renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [ledger], silent)).toBe(
      renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [ledger]),
    )
  })

  it('leaves the fixed half and the budget where they were', () => {
    const digest = renderTasteDigest([snapshot], NOW, DIGEST_BUDGET, [ledger], moment)
    const line = (lead: string): string => digest.split('\n').find((l) => l.startsWith(`${lead}: `))!
    expect(line('Sources')).toBe('Sources: NetEase (1 liked)')
    expect(digest.length).toBeLessThanOrEqual(DIGEST_BUDGET)
    expect(['Sources', 'Artists they return to'].map(line).join('\n').length).toBeLessThanOrEqual(300)
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

  it('reads the ledgers beside the snapshots, and never as snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-taste-'))
    writeFileSync(join(dir, 'netease.json'), JSON.stringify({ source: 'netease', takenAt: '2026-09-06T00:00:00.000Z', items: [{ kind: 'liked', title: 'a', artist: 'Bon Iver' }] }))
    writeFileSync(join(dir, 'netease.ledger.json'), JSON.stringify({
      source: 'netease',
      updatedAt: '2026-09-06T00:00:00.000Z',
      entries: [1, 2, 3].map((n) => ({ kind: 'liked', title: `song ${n}`, artist: 'Bon Iver', key: `k${n}`, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-09-06T00:00:00.000Z', seen: 2 })),
    }))
    const logs: string[] = []
    const reader = new TasteReader({ dir, now: () => NOW, log: (m) => logs.push(m) })
    expect(reader.digest()).toContain('Bon Iver (3)')
    // A ledger is not a malformed snapshot; it must not be warned about.
    expect(logs).toEqual([])
  })

  it('re-renders when a ledger changes, not only when a snapshot does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-taste-'))
    const ledger = join(dir, 'netease.ledger.json')
    writeFileSync(join(dir, 'netease.json'), JSON.stringify({ source: 'netease', takenAt: '2026-09-06T00:00:00.000Z', items: [{ kind: 'liked', title: 'a', artist: 'Bon Iver' }] }))
    const write = (n: number): void =>
      writeFileSync(ledger, JSON.stringify({
        source: 'netease',
        updatedAt: '2026-09-06T00:00:00.000Z',
        entries: Array.from({ length: n }, (_, i) => ({ kind: 'liked', title: `song ${i}`, artist: 'Bon Iver', key: `k${i}`, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-09-06T00:00:00.000Z', seen: 1 })),
      }))
    write(2)
    const reader = new TasteReader({ dir, now: () => NOW })
    expect(reader.digest()).toContain('Bon Iver (2)')
    expect(reader.digest()).toContain('Bon Iver (2)')
    expect(reader.renders).toBe(1)
    write(5)
    utimesSync(ledger, new Date(), new Date(Date.now() + 1000))
    expect(reader.digest()).toContain('Bon Iver (5)')
    expect(reader.renders).toBe(2)
  })

  // spec 14 §2.12: the pack keeps the memoised render; the pick gets a fresh
  // one for its moment, off the same parsed files rather than a re-read.
  it('memoises the static render and renders per moment without re-reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-taste-'))
    writeFileSync(join(dir, 'netease.json'), JSON.stringify({ source: 'netease', takenAt: '2026-09-06T00:00:00.000Z', items: [{ kind: 'liked', title: 'in the window', artist: 'Low Antenna' }] }))
    writeFileSync(join(dir, 'netease.ledger.json'), JSON.stringify({
      source: 'netease',
      updatedAt: '2026-09-06T00:00:00.000Z',
      lastRead: { liked: '2026-09-06T00:00:00.000Z' },
      entries: [
        { kind: 'liked', title: 'the harbour song', artist: 'Paper Ferries', key: 'a', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-09-06T00:00:00.000Z', seen: 2 },
        { kind: 'liked', title: 'another', artist: 'Low Antenna', key: 'b', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-09-06T00:00:00.000Z', seen: 2 },
      ],
    }))
    const reader = new TasteReader({ dir, now: () => NOW })
    expect(reader.digest()).toContain('"in the window" Low Antenna')
    expect(reader.digest()).toContain('"in the window" Low Antenna')
    expect(reader.renders).toBe(1)
    const moment: Moment = { hour: 16, persona: '', lastTalk: 'paper ferries', avoidArtists: [] }
    expect(reader.digest(moment)).toMatch(/Songs they keep: "the harbour song" Paper Ferries/)
    // The static render is still the cached one, and the files were not
    // re-parsed to serve the moment.
    expect(reader.digest()).toContain('"in the window" Low Antenna')
    expect(reader.parses).toBe(1)
  })

  // spec 14 §2.12's red line: this runs on the pick path, in code, before the
  // prompt is assembled. A pick's median is already 142 s and this may not
  // add to it.
  it('renders a moment in under 5 ms on a full-size ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-taste-'))
    const entries = Array.from({ length: 4000 }, (_, i) => ({
      kind: 'liked' as const,
      title: `a song title of about the length a real one has, number ${i}`,
      artist: `Band ${i % 400}`,
      key: `k${i}`,
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`,
      seen: 2,
    }))
    writeFileSync(join(dir, 'netease.json'), JSON.stringify({ source: 'netease', takenAt: '2026-09-06T00:00:00.000Z', items: entries.slice(0, 500).map(({ kind, title, artist }) => ({ kind, title, artist })) }))
    writeFileSync(join(dir, 'netease.ledger.json'), JSON.stringify({ source: 'netease', updatedAt: '2026-09-06T00:00:00.000Z', lastRead: { liked: '2026-09-06T00:00:00.000Z' }, entries }))
    const reader = new TasteReader({ dir, now: () => NOW })
    const moment: Moment = {
      hour: 16,
      persona: 'a warm evening host with a jazz habit and a soft spot for city pop',
      lastTalk: 'that last one was Band 37, and before it something from the same corner of the shelf',
      avoidArtists: ['Band 37'],
    }
    // Warm first: the parse is the pack's cost, not the pick's, and a cold
    // JIT is not what the budget is about.
    for (let i = 0; i < 5; i++) reader.digest(moment)
    const runs = Array.from({ length: 15 }, () => {
      const started = performance.now()
      reader.digest(moment)
      return performance.now() - started
    }).sort((a, b) => a - b)
    // The MEDIAN, not the mean: one scheduling stall on a shared runner is
    // not the thing being measured, and a mean lets that one stall fail a
    // green build (issue #269 is what that habit costs).
    expect(runs[Math.floor(runs.length / 2)]!).toBeLessThan(5)
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
