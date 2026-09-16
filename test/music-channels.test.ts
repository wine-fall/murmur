// The curated-channel search source (spec 14 §2.9): the committed manifest,
// its runtime refresh from GitHub, the pool of recent uploads those channels
// hold, and the local `channels` catalogue the pick task searches.
//
// The distinction this whole file guards: these channels are a place to LOOK
// for a song. They are never taste — nothing here reaches the digest or the
// situation block.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Harness, TaskTool, TrackCandidate } from '../src/contracts.ts'
import { MusicProgrammer } from '../src/music/music-programmer.ts'
import { musicTools } from '../src/music/music-tools.ts'
import { buildFindMusicInstruction, buildMusicSituation, CHANNELS_GUIDANCE } from '../src/prompts/music.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

import {
  BUNDLED_CHANNELS,
  CHANNEL_MANIFEST_URL,
  ChannelPool,
  type ChannelPoolDeps,
  channelUploads,
  channelsCacheDir,
  loadChannelManifest,
  parseChannelManifest,
  CHAPTER_LOOKUPS_PER_CHANNEL,
  chapterTracks,
  MAX_CHAPTERS_PER_UPLOAD,
  parseChapters,
  parseFlatUploads,
  TRACKS_PER_CHANNEL,
} from '../src/music/channels.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'murmur-channels-test-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

// The manifest constant is anchored relative to the module file; a tree move
// that breaks the anchor must fail here, not at a listener's first run.
it('the bundled manifest is committed and parses to real channel urls', () => {
  expect(existsSync(BUNDLED_CHANNELS)).toBe(true)
  const urls = parseChannelManifest(readFileSync(BUNDLED_CHANNELS, 'utf8'))
  expect(urls.length).toBeGreaterThan(2)
  expect(urls.some((u) => u.includes('youtube.com'))).toBe(true)
  expect(urls.some((u) => u.includes('space.bilibili.com'))).toBe(true)
})

// Rebuildable things live under the murmur home's cache, never ~/.cache.
it('caches under $MURMUR_HOME/cache', () => {
  expect(channelsCacheDir({ MURMUR_HOME: '/tmp/murmur-home' })).toBe(join('/tmp/murmur-home', 'cache', 'channels'))
})

describe('parseChannelManifest', () => {
  it('takes one url per line and ignores comments, blanks and junk', () => {
    const text = [
      '# a header comment',
      '',
      'https://www.youtube.com/@One/videos',
      '   https://space.bilibili.com/42/video   ',
      '  # an indented comment',
      'not a url at all',
      'ftp://elsewhere/nope',
    ].join('\n')
    expect(parseChannelManifest(text)).toEqual(['https://www.youtube.com/@One/videos', 'https://space.bilibili.com/42/video'])
  })

  it('reads an empty body as no channels rather than throwing', () => {
    expect(parseChannelManifest('')).toEqual([])
  })
})

const REMOTE = 'https://www.youtube.com/@Remote/videos\n'
const ok = (body: string) => async () => new Response(body, { status: 200 })

describe('loadChannelManifest', () => {
  it('fetches the list from GitHub and caches it under the murmur cache', async () => {
    const fetched: string[] = []
    const got = await loadChannelManifest({
      dir,
      fetch: async (url) => (fetched.push(String(url)), new Response(REMOTE, { status: 200 })),
      now: () => 1_000,
    })
    expect(got).toEqual(['https://www.youtube.com/@Remote/videos'])
    expect(fetched).toEqual([CHANNEL_MANIFEST_URL])
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true)
  })

  it('serves the cache inside the TTL without touching the network', async () => {
    await loadChannelManifest({ dir, fetch: ok(REMOTE), now: () => 1_000 })
    let calls = 0
    const got = await loadChannelManifest({
      dir,
      fetch: async () => (calls++, new Response('', { status: 500 })),
      now: () => 1_000 + 60_000,
    })
    expect(got).toEqual(['https://www.youtube.com/@Remote/videos'])
    expect(calls).toBe(0)
  })

  it('refetches past the TTL', async () => {
    await loadChannelManifest({ dir, fetch: ok(REMOTE), now: () => 0 })
    const got = await loadChannelManifest({
      dir,
      fetch: ok('https://space.bilibili.com/7/video\n'),
      now: () => 13 * 60 * 60_000,
    })
    expect(got).toEqual(['https://space.bilibili.com/7/video'])
  })

  it('falls back to the bundled copy when the network fails — a hiccup never costs the feature', async () => {
    const got = await loadChannelManifest({
      dir,
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
      now: () => 1_000,
    })
    expect(got).toEqual(parseChannelManifest(readFileSync(BUNDLED_CHANNELS, 'utf8')))
  })

  it('falls back when the remote answers a body with no channels in it', async () => {
    const got = await loadChannelManifest({ dir, fetch: ok('<!DOCTYPE html><h1>404</h1>'), now: () => 1_000 })
    expect(got).toEqual(parseChannelManifest(readFileSync(BUNDLED_CHANNELS, 'utf8')))
    // and the junk is not cached as if it were a list
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  })

  it('prefers a stale cache over the bundled copy when the refetch fails', async () => {
    await loadChannelManifest({ dir, fetch: ok(REMOTE), now: () => 0 })
    const got = await loadChannelManifest({
      dir,
      fetch: async () => new Response('', { status: 500 }),
      now: () => 100 * 60 * 60_000,
    })
    expect(got).toEqual(['https://www.youtube.com/@Remote/videos'])
  })

  it('reads a hand-mangled cache file as no cache at all', async () => {
    writeFileSync(join(dir, 'manifest.json'), '{ not json')
    const got = await loadChannelManifest({ dir, fetch: ok(REMOTE), now: () => 1_000 })
    expect(got).toEqual(['https://www.youtube.com/@Remote/videos'])
  })
})

describe('parseFlatUploads', () => {
  // yt-dlp's flat listing of a channel names the channel in playlist_uploader
  // and leaves `uploader` null — read from the wrong field the pool would have
  // no uploader to match on.
  const line = (fields: Record<string, unknown>) => JSON.stringify(fields)

  it('reads title, ref, uploader and length off a flat channel listing', () => {
    const stdout = [
      line({ title: 'beats to cast to', url: 'https://www.youtube.com/watch?v=aaa', duration: 3875, playlist_uploader: 'Lofi Girl' }),
      'yt-dlp chatter that is not a hit',
      line({ title: 'sleep under the stars', webpage_url: 'https://www.youtube.com/watch?v=bbb', duration: 100, uploader: 'Lofi Girl' }),
    ].join('\n')
    expect(parseFlatUploads(stdout, 5)).toEqual([
      { ref: 'https://www.youtube.com/watch?v=aaa', title: 'beats to cast to', uploader: 'Lofi Girl', durationS: 3875 },
      { ref: 'https://www.youtube.com/watch?v=bbb', title: 'sleep under the stars', uploader: 'Lofi Girl', durationS: 100 },
    ])
  })

  it('stops at the limit and skips a row with no ref', () => {
    const stdout = [line({ title: 'a', duration: 1 }), line({ title: 'b', url: 'https://u/1' })].join('\n')
    expect(parseFlatUploads(stdout, 5)).toEqual([{ ref: 'https://u/1', title: 'b', uploader: '', durationS: 0 }])
  })
})

describe('channelUploads', () => {
  it('sends a YouTube channel to yt-dlp and a Bilibili space to the signed API', async () => {
    const args: string[][] = []
    const mids: string[] = []
    const read = channelUploads({
      run: async (a) => (args.push(a), JSON.stringify({ title: 't', url: 'https://u/1', duration: 2, playlist_uploader: 'ch' })),
      space: { recent: async (mid, limit) => (mids.push(mid), [{ ref: 'https://www.bilibili.com/video/BV1', title: 'b', uploader: 'up', durationS: 3 }].slice(0, limit)) },
    })
    expect(await read('https://www.youtube.com/@Ch/videos', 4)).toEqual([{ ref: 'https://u/1', title: 't', uploader: 'ch', durationS: 2 }])
    expect(args[0]).toContain('https://www.youtube.com/@Ch/videos')
    expect(args[0]).toContain('--flat-playlist')
    expect(await read('https://space.bilibili.com/42/video', 4)).toEqual([
      { ref: 'https://www.bilibili.com/video/BV1', title: 'b', uploader: 'up', durationS: 3 },
    ])
    expect(mids).toEqual(['42'])
  })

  it('ignores a url that is neither', async () => {
    const read = channelUploads({ run: async () => 'never', space: { recent: async () => [] } })
    expect(await read('https://example.com/whatever', 4)).toEqual([])
  })
})

// --- chapters as songs (spec 14 §2.9) ------------------------------------- //
//
// Captured from the real `yt-dlp --dump-json https://www.youtube.com/watch?v=kx22t0PBrKM`
// on 2026-09-16 — a 7506 s city-pop playlist whose 16 chapters ARE the songs.
// Trimmed to the rows that decide something: the placeholder intro yt-dlp
// writes as chapter 1, ordinary song chapters, and the closing "Replay The
// Vibes" chapter that is itself an hour-long re-run of the whole first half.
// The real titles are bilingual; only their English halves are kept here,
// because a committed source file may not carry CJK (the language gate).
const REAL_CHAPTERS = [
  { start_time: 0, end_time: 1, title: '<Untitled Chapter 1>' },
  { start_time: 1, end_time: 265, title: 'Silver Screen Glow' },
  { start_time: 265, end_time: 517, title: 'Ephemeral Dream' },
  { start_time: 517, end_time: 807, title: 'Observatory Secret' },
  { start_time: 3752, end_time: 7506, title: 'Replay The Vibes' },
]

const PLAYLIST = {
  ref: 'https://www.youtube.com/watch?v=kx22t0PBrKM',
  title: '80s CITY POP PLAYLIST',
  uploader: '90s Neon Soul',
  durationS: 7506,
}

const meta = (chapters: unknown) => JSON.stringify({ id: 'x', title: PLAYLIST.title, duration: PLAYLIST.durationS, chapters })

describe('parseChapters', () => {
  it('reads the chapter list off a full-metadata dump', () => {
    expect(parseChapters(meta(REAL_CHAPTERS))).toEqual(REAL_CHAPTERS)
  })

  it('reads an upload with no chapters as none, and junk as unknown', () => {
    expect(parseChapters(meta(null))).toEqual([])
    expect(parseChapters(JSON.stringify({ id: 'x' }))).toEqual([])
    expect(parseChapters('yt-dlp said something else entirely')).toBe(null)
  })
})

describe('chapterTracks', () => {
  it('turns the songs into candidates and drops what is not one', () => {
    const tracks = chapterTracks(PLAYLIST, REAL_CHAPTERS)
    expect(tracks).toEqual([
      // The fragment is the upload's own url plus `#t=<start>,<end>`; resolve
      // strips it back off and plays exactly that slice.
      { ref: `${PLAYLIST.ref}#t=1,265`, title: 'Silver Screen Glow', uploader: '90s Neon Soul', durationS: 264 },
      { ref: `${PLAYLIST.ref}#t=265,517`, title: 'Ephemeral Dream', uploader: '90s Neon Soul', durationS: 252 },
      { ref: `${PLAYLIST.ref}#t=517,807`, title: 'Observatory Secret', uploader: '90s Neon Soul', durationS: 290 },
    ])
    // Dropped: the placeholder intro (1 s and titled `<Untitled Chapter 1>`),
    // and "Replay The Vibes" — a 3754 s chapter is a mix by the same measure
    // that drops a mix upload.
  })

  it('drops a chapter too short to be a song', () => {
    const short = [{ start_time: 0, end_time: 30, title: 'Intro' }, { start_time: 30, end_time: 300, title: 'Real Song' }]
    expect(chapterTracks(PLAYLIST, short).map((t) => t.title)).toEqual(['Real Song'])
  })

  it('takes at most MAX_CHAPTERS_PER_UPLOAD from one upload', () => {
    const many = Array.from({ length: 29 }, (_, i) => ({ start_time: i * 200, end_time: i * 200 + 200, title: `Song ${i}` }))
    expect(chapterTracks(PLAYLIST, many)).toHaveLength(MAX_CHAPTERS_PER_UPLOAD)
  })
})

describe('the chaptered pool', () => {
  const listing = (rows: { id: string; duration: number }[]) =>
    rows.map((r) => JSON.stringify({ title: `upload ${r.id}`, url: `https://www.youtube.com/watch?v=${r.id}`, duration: r.duration, playlist_uploader: '90s Neon Soul' })).join('\n')

  function reader(rows: { id: string; duration: number }[], chapters: Record<string, unknown>) {
    const calls: string[][] = []
    const read = channelUploads({
      run: async (args) => {
        calls.push(args)
        if (args.includes('--flat-playlist')) return listing(rows)
        const id = (args.at(-1) ?? '').split('=').at(-1) ?? ''
        return meta(chapters[id] ?? null)
      },
      space: { recent: async () => [] },
      dir,
    })
    return { read, calls }
  }

  it('expands a chaptered upload, keeps a short one, and drops a long one with no chapters', async () => {
    const { read, calls } = reader(
      [
        { id: 'chaptered', duration: 5987 },
        { id: 'song', duration: 240 },
        { id: 'mix', duration: 4080 },
      ],
      { chaptered: [{ start_time: 0, end_time: 300, title: 'A' }, { start_time: 300, end_time: 600, title: 'B' }] },
    )
    const tracks = await read('https://www.youtube.com/@90sNeonSoul/videos', 20)
    expect(tracks.map((t) => t.title)).toEqual(['A', 'B', 'upload song'])
    expect(tracks[0]?.ref).toBe('https://www.youtube.com/watch?v=chaptered#t=0,300')
    // A 68-minute upload with no chapters is a mix, not a song: it never
    // reaches the pool, and it costs exactly one metadata call to find out.
    const full = calls.filter((c) => !c.includes('--flat-playlist'))
    expect(full).toHaveLength(2)
  })

  it('pays for an upload once: the second refresh reads the cache', async () => {
    const rows = [{ id: 'chaptered', duration: 5987 }]
    const chapters = { chaptered: [{ start_time: 0, end_time: 300, title: 'A' }] }
    const first = reader(rows, chapters)
    expect(await first.read('https://www.youtube.com/@90sNeonSoul/videos', 20)).toHaveLength(1)
    const second = reader(rows, chapters)
    expect(await second.read('https://www.youtube.com/@90sNeonSoul/videos', 20)).toHaveLength(1)
    expect(second.calls.filter((c) => !c.includes('--flat-playlist'))).toHaveLength(0)
  })

  it('bounds the metadata calls per channel and caps what one channel contributes', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `v${i}`, duration: 5987 }))
    const chapters = Object.fromEntries(
      rows.map((r) => [r.id, Array.from({ length: 29 }, (_, i) => ({ start_time: i * 200, end_time: i * 200 + 200, title: `${r.id} song ${i}` }))]),
    )
    const { read, calls } = reader(rows, chapters)
    const tracks = await read('https://www.youtube.com/@90sNeonSoul/videos', 20)
    // 20 uploads x 29 chapters must not swamp the catalogue.
    expect(tracks.length).toBeLessThanOrEqual(TRACKS_PER_CHANNEL)
    expect(calls.filter((c) => !c.includes('--flat-playlist'))).toHaveLength(CHAPTER_LOOKUPS_PER_CHANNEL)
  })

  it('a video whose metadata call fails costs that video, not the channel', async () => {
    const read = channelUploads({
      run: async (args) => {
        if (args.includes('--flat-playlist')) return listing([{ id: 'broken', duration: 5987 }, { id: 'song', duration: 240 }])
        throw new Error('video unavailable')
      },
      space: { recent: async () => [] },
      dir,
    })
    expect((await read('https://www.youtube.com/@90sNeonSoul/videos', 20)).map((t) => t.title)).toEqual(['upload song'])
  })
})

const LISTINGS: Record<string, { ref: string; title: string; uploader: string; durationS: number }[]> = {
  'https://www.youtube.com/@Colors/videos': [
    { ref: 'https://www.youtube.com/watch?v=1', title: 'Villano Antillano - XXL | A COLORS SHOW', uploader: 'COLORS', durationS: 200 },
    { ref: 'https://www.youtube.com/watch?v=2', title: 'Chaka Khan | A COLORS CLOSE-UP', uploader: 'COLORS', durationS: 300 },
  ],
  'https://space.bilibili.com/42/video': [
    { ref: 'https://www.bilibili.com/video/BV1', title: 'Sicily | Official MV', uploader: 'JVR Music', durationS: 240 },
  ],
}

function pool(extra: Partial<ChannelPoolDeps> = {}) {
  return new ChannelPool({
    dir,
    manifest: async () => Object.keys(LISTINGS),
    uploads: async (url, limit) => (LISTINGS[url] ?? []).slice(0, limit),
    now: () => 1_000,
    pauseMs: 0,
    ...extra,
  })
}

describe('ChannelPool', () => {
  it('builds a pool from the listed channels and caches it', async () => {
    const built = pool()
    expect(built.count()).toBe(0)
    expect(await built.refresh()).toBe(3)
    expect(built.count()).toBe(3)
    expect(existsSync(join(dir, 'pool.json'))).toBe(true)
    // A fresh pool over the same cache dir has the tracks without a refresh.
    expect(pool().count()).toBe(3)
  })

  it('keeps the channels that answered when one of them fails', async () => {
    const built = new ChannelPool({
      dir,
      manifest: async () => Object.keys(LISTINGS),
      uploads: async (url, limit) => {
        if (url.includes('bilibili')) throw new Error('HTTP 412')
        return (LISTINGS[url] ?? []).slice(0, limit)
      },
      now: () => 1_000,
      pauseMs: 0,
    })
    expect(await built.refresh()).toBe(2)
  })

  it('never throws when the whole refresh falls over', async () => {
    const built = new ChannelPool({
      dir,
      manifest: async () => {
        throw new Error('no manifest')
      },
      uploads: async () => [],
    })
    expect(await built.refresh()).toBe(0)
    expect(built.count()).toBe(0)
  })

  it('maybeRefresh runs once and then not again until the pool is stale', async () => {
    let at = 1_000
    const built = new ChannelPool({ dir, manifest: async () => Object.keys(LISTINGS), uploads: async (u, l) => (LISTINGS[u] ?? []).slice(0, l), now: () => at, pauseMs: 0 })
    expect(built.maybeRefresh()).toBe(true)
    // single-flight: a second poke while the first runs is a no-op
    expect(built.maybeRefresh()).toBe(false)
    await built.idle()
    expect(built.count()).toBe(3)
    expect(built.maybeRefresh()).toBe(false)
    at += 25 * 60 * 60_000
    expect(built.maybeRefresh()).toBe(true)
    await built.idle()
  })

  it('searches the pool locally, on title and on uploader, with no network', async () => {
    const built = pool()
    await built.refresh()
    expect(built.search('chaka khan').map((c) => c.ref)).toEqual(['https://www.youtube.com/watch?v=2'])
    // the uploader is matched too, so "what did COLORS put up" finds the channel
    expect(built.search('colors').map((c) => c.ref)).toEqual(['https://www.youtube.com/watch?v=1', 'https://www.youtube.com/watch?v=2'])
    expect(built.search('jvr')[0]?.title).toBe('Sicily | Official MV')
    // every word has to land, so an unrelated query finds nothing
    expect(built.search('chaka khan reggaeton')).toEqual([])
  })

  it('hands back candidates in the shape every other catalogue returns', async () => {
    const built = pool()
    await built.refresh()
    expect(built.search('chaka')[0]).toEqual({
      ref: 'https://www.youtube.com/watch?v=2',
      title: 'Chaka Khan | A COLORS CLOSE-UP',
      uploader: 'COLORS',
      durationS: 300,
      extra: {},
      catalogue: 'channels',
    })
  })

  it('honours the limit and answers an empty query with the newest of the pool', async () => {
    const built = pool()
    await built.refresh()
    expect(built.search('colors', 1)).toHaveLength(1)
    expect(built.search('   ')).toHaveLength(3)
  })
})

describe('the channels catalogue in search_music (spec 03-01 §2.3)', () => {
  const stocked = () => ({
    count: () => 2,
    search: (query: string, limit?: number) =>
      [
        { ref: 'https://www.youtube.com/watch?v=2', title: 'Chaka Khan | A COLORS CLOSE-UP', uploader: 'COLORS', durationS: 300, extra: {}, catalogue: 'channels' as const },
      ].filter((c) => c.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit ?? 5),
  })

  it('is offered, and searched locally, when the pool has something in it', async () => {
    const provider = new FakeMusicProvider()
    const tools = musicTools(provider, () => {}, undefined, undefined, stocked())
    const search = tools.find((t) => t.name === 'search_music')
    expect(search?.description).toContain('channels')
    const result = await callTool(tools, 'search_music', { query: 'chaka khan', catalogue: 'channels' })
    expect((result.candidates as TrackCandidate[])[0]?.ref).toBe('https://www.youtube.com/watch?v=2')
    // local: the provider is never asked, so a search costs no network
    expect(provider.searches).toEqual([])
  })

  it('is not offered while the pool is empty, and asking for it says so', async () => {
    const tools = musicTools(new FakeMusicProvider(), () => {}, undefined, undefined, { count: () => 0, search: () => [] })
    expect(tools.find((t) => t.name === 'search_music')?.description ?? '').not.toContain('channels')
    const result = await callTool(tools, 'search_music', { query: 'anything', catalogue: 'channels' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-mounted')
  })

  it('leaves the other catalogues exactly as they were', async () => {
    const provider = new FakeMusicProvider()
    const tools = musicTools(provider, () => {}, undefined, undefined, stocked())
    await callTool(tools, 'search_music', { query: 'city pop' })
    expect(provider.searches).toEqual([{ query: 'city pop', limit: undefined, catalogue: undefined }])
  })
})

describe('what the pick task is told about the catalogue (spec 14 §2.9)', () => {
  it('says WHERE to look, and never a word about what the listener likes', () => {
    const withChannels = buildFindMusicInstruction(undefined, { channels: true })
    expect(withChannels).toContain(CHANNELS_GUIDANCE)
    expect(CHANNELS_GUIDANCE).toMatch(/curated/i)
    // The sentence is about a place to search. Any claim about the listener's
    // taste belongs to the digest, which these channels never feed.
    expect(CHANNELS_GUIDANCE).not.toMatch(/listener'?s? (taste|kept|likes)|what they keep/i)
  })

  it('is absent while the pool is empty, so the model is never sent somewhere with nothing in it', () => {
    expect(buildFindMusicInstruction()).not.toContain(CHANNELS_GUIDANCE)
    expect(buildFindMusicInstruction(undefined, { taste: true })).not.toContain(CHANNELS_GUIDANCE)
  })

  it('never reaches the situation block, which is where taste lives', () => {
    const situation = buildMusicSituation([{ role: 'radio', text: 'hi' }], ['a song'], 'What the listener keeps\n- one')
    expect(situation).not.toContain(CHANNELS_GUIDANCE)
    expect(situation).not.toMatch(/curated/i)
  })
})

describe('the pool on the pick pipeline (spec 14 §3.4 cadence)', () => {
  const ctx = { persona: 'p', situation: 's' }

  it('pokes the refresh at a music boundary and mounts the catalogue for the task', async () => {
    let pokes = 0
    let described = ''
    const brain: Harness = {
      runTask: async <T,>(req: { tools?: (finish: (value: T) => void) => TaskTool[] }) => {
        described = req.tools?.(() => {}).find((t) => t.name === 'search_music')?.description ?? ''
        return null
      },
    } as unknown as Harness
    const programmer = new MusicProgrammer({
      brain,
      provider: new FakeMusicProvider(),
      model: 'm',
      channels: { count: () => 3, search: () => [], maybeRefresh: () => (pokes++, true) },
    })
    expect(await programmer.nextTrack(ctx)).toBeNull()
    expect(pokes).toBe(1)
    expect(described).toContain('channels')
  })

  it('runs exactly as before when no pool is wired', async () => {
    const brain = { runTask: async () => null } as unknown as Harness
    const programmer = new MusicProgrammer({ brain, provider: new FakeMusicProvider(), model: 'm' })
    expect(await programmer.nextTrack(ctx)).toBeNull()
  })
})

describe('a refresh that fails is not tried again at every boundary', () => {
  it('waits out the retry window before reading the channels again', async () => {
    let at = 0
    let reads = 0
    const built = new ChannelPool({
      dir,
      manifest: async () => ['https://www.youtube.com/@One/videos', 'https://www.youtube.com/@Two/videos'],
      uploads: async () => {
        reads++
        throw new Error('offline')
      },
      pauseMs: 0,
      now: () => at,
    })
    expect(built.maybeRefresh()).toBe(true)
    await built.idle()
    expect(reads).toBe(2)
    // The next two boundaries cost nothing: an offline listener must not
    // respawn yt-dlp once a song.
    expect(built.maybeRefresh()).toBe(false)
    expect(built.maybeRefresh()).toBe(false)
    expect(reads).toBe(2)
    at += 61 * 60_000
    expect(built.maybeRefresh()).toBe(true)
    await built.idle()
    expect(reads).toBe(4)
  })
})
