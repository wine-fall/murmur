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
  parseFlatUploads,
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
