// The AI slot (spec 14 §3.10 step four) and the pool it draws from (§2.9): a
// tag row is kept only when it reads as an AI-made song, the pool knows which
// refs those are, its search answers a genre word with something, and an AI
// slot's submit_pick turns back anything else -- three times, then plays it.
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Familiarity, Harness, TaskTool, TrackCandidate, TrackPick } from '../src/contracts.ts'
import {
  aiSong,
  ChannelPool,
  type ChannelPoolDeps,
  type ChannelTrack,
  channelUploads,
  MAX_AI_ROWS,
  MAX_POOL_TRACKS,
  UPLOADS_PER_CHANNEL,
  UPLOADS_PER_TAG,
} from '../src/music/channels.ts'
import { MusicProgrammer } from '../src/music/music-programmer.ts'
import { type ChannelCatalogue, musicTools } from '../src/music/music-tools.ts'
import { buildFindMusicInstruction, CHANNELS_GUIDANCE } from '../src/prompts/music.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

let dir: string
const home = process.env.MURMUR_HOME

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'murmur-ai-slot-test-'))
  process.env.MURMUR_HOME = dir
})

afterEach(async () => {
  if (home === undefined) delete process.env.MURMUR_HOME
  else process.env.MURMUR_HOME = home
  await rm(dir, { recursive: true, force: true })
})

const AI = 'AI\u97f3\u4e50'
// `null` tags = a row with no tag list at all, the way a YouTube row comes.
const row = (title: string, durationS = 200, tags: string[] | null = [AI], uploader = 'Lantern Studio'): ChannelTrack => ({
  ref: `https://www.bilibili.com/video/BV${title.replace(/[^A-Za-z0-9]/g, '')}${durationS}`,
  title,
  uploader,
  durationS,
  ...(tags !== null && { extra: { zone: 'original', tags } }),
})

describe('aiSong: what a tag row has to be to stay', () => {
  it('keeps a song whose own tags say AI, in any case and inside a longer tag', () => {
    for (const tag of ['suno', 'Suno v5', 'AI\u97f3\u4e50', 'aigc', 'AIGC\u97f3\u4e50', 'AI\u751f\u6210\u97f3\u4e50', 'ai\u4f5c\u66f2', 'AI\u539f\u521b', 'AI\u6b4c\u66f2']) {
      expect(aiSong(row('Paper Lanterns', 200, ['ballad', tag])), tag).toBe(true)
    }
  })

  it('drops a row whose tags never say AI, and a row with no tags at all, which is every YouTube row', () => {
    expect(aiSong(row('Paper Lanterns', 200, ['ballad', 'piano']))).toBe(false)
    expect(aiSong(row('Paper Lanterns', 200, null))).toBe(false)
    expect(aiSong(row('Paper Lanterns', 200, []))).toBe(false)
  })

  it('drops a title that is something else: a cover, an edition, a tutorial, a chart', () => {
    const words = [
      '\u7ffb\u5531', 'Cover', '\u6539\u7f16', '\u7248', '\u7eaf\u97f3\u4e50', '\u4f34\u594f', '\u6559\u7a0b', '\u6d4b\u8bc4',
      '\u8bd5\u542c', '\u58f0\u5e93', 'VLOG', '\u5927\u8d5b', '\u6392\u884c', 'Reaction', 'MV',
    ]
    for (const word of words) expect(aiSong(row(`Paper Lanterns ${word}`)), word).toBe(false)
  })

  // Measured 2026-10-29: 74 of 518 deep-page rows passed the title test and
  // were covers by their own tags. The tags are read for the not-original
  // words alone -- a tag like `AIMV` or a zone word is not a verdict.
  it('drops a row whose own tags call it a cover, an adaptation, a remake or a voice conversion', () => {
    const words = ['AI\u7ffb\u5531', '\u65e5\u8bed\u7ffb\u5531', 'COVER', 'AI cover', 'RVC', '\u6539\u7f16', '#DJ\u6539\u7f16', '\u4e8c\u521b', '\u91cd\u7f6e']
    for (const word of words) expect(aiSong(row('Paper Lanterns', 200, [AI, word])), word).toBe(false)
    for (const word of ['AIMV', '\u534e\u8bedMV', 'Recovery', '\u7248\u672c\u66f4\u65b0', 'rvcx']) expect(aiSong(row('Paper Lanterns', 200, [AI, word])), word).toBe(true)
  })

  it('drops a remake or a voice conversion named in the title too', () => {
    for (const word of ['\u4e8c\u521b', '\u91cd\u7f6e', 'RVC']) expect(aiSong(row(`Paper Lanterns ${word}`)), word).toBe(false)
  })

  // A voice-clone cover names the cloned voice right after "AI", at the head
  // of the title or of a bracket: an AI voice of a named singer or character
  // singing someone's song. A generic word after "AI" (music, composed,
  // original, singer, idol, short film, ...) is the tool, not a voice.
  it('drops an AI<name> voice-clone title and keeps an AI<generic word> one', () => {
    const name = '\u6249\u95f4' // a character's name
    for (const title of [
      `\u3010AI${name}\u3011Paper Lanterns`,
      `\u3010ai${name}\u3011Paper Lanterns`,
      `\u3010AI${name}\uff08rain\uff09-Paper Lanterns\u3011`,
      `\u3010AI${name}\uff5cPaper Lanterns\u3011`,
      `AI${name}\u539f\u521b\u6b4c\u66f2\u300aPaper Lanterns\u300b`,
      `ai${name} Paper Lanterns`,
    ]) expect(aiSong(row(title)), title).toBe(false)
    for (const title of [
      '\u3010AI\u97f3\u4e50\u3011Paper Lanterns',
      '\u3010AI\u4f5c\u66f2\u3011Paper Lanterns',
      '\u3010AI\u4f5c\u8a5e\u4f5c\u66f2\u3011Paper Lanterns',
      '\u3010AI\u539f\u521b/\u8bf4\u5531\u3011Paper Lanterns',
      '\u3010AI\u6b4c\u624b\u3011Paper Lanterns',
      '\u3010Ai\u5076\u50cf\u3011Paper Lanterns',
      '\u3010AI\u5fae\u7535\u5f71\u3011Paper Lanterns',
      '\u3010AI\u5199\u6b4c\u3011Paper Lanterns',
      '[AI\u6269\u5199]Paper Lanterns',
      '[AI\u8f85\u52a9]Paper Lanterns',
      'Paper Lanterns \uff0f Suno AI \u4f5c\u66f2',
      'Paper Lanterns Suno AI \u4f5c\u753b',
      'AI\u7ec8\u4e8e\u80fd\u751f\u6210\u6b63\u5e38\u54cd\u5ea6\u7684Hardcore',
      'AIMV Paper Lanterns',
    ]) expect(aiSong(row(title)), title).toBe(true)
  })

  it('reads an ASCII word only as a whole word', () => {
    expect(aiSong(row('Recovery Lane'))).toBe(true)
    expect(aiSong(row('Mvskoke Morning'))).toBe(true)
    expect(aiSong(row('Paper Lanterns (Official MV)'))).toBe(false)
  })

  it('runs two to seven minutes; an unknown length is not a song here', () => {
    expect([119, 120, 420, 421, 0].map((s) => aiSong(row('Paper Lanterns', s)))).toEqual([false, true, true, false, false])
  })
})

describe('channelUploads holds a tag to it', () => {
  it('keeps the AI-made songs off a Bilibili tag and nothing off a YouTube one', async () => {
    const read = channelUploads({
      run: async () => JSON.stringify({ title: 'Paper Lanterns', url: 'https://www.youtube.com/watch?v=y1', duration: 200, channel: 'ch' }),
      space: { recent: async () => [], newest: async () => [row('Paper Lanterns'), row('Paper Lanterns Cover'), row('Tin Roof', 200, ['piano'])] },
    })
    expect((await read('tag:bilibili:ai', 20)).map((t) => t.title)).toEqual(['Paper Lanterns'])
    expect(await read('tag:youtube:ai version', 20)).toEqual([])
  })

  it('leaves a channel row to the rules it always had', async () => {
    const read = channelUploads({ run: async () => '', space: { recent: async () => [row('Tin Roof Cover', 60, null)], newest: async () => [] } })
    expect((await read('https://space.bilibili.com/123/video', 20)).map((t) => t.title)).toEqual(['Tin Roof Cover'])
  })
})

const CHANNEL = 'https://www.youtube.com/@Colors/videos'
const COLORS = row('Harbour Lights | A COLORS SHOW', 240, null, 'COLORS')
const LANTERNS = row('Paper Lanterns', 200, [AI, 'ballad'])

function pool(over: Partial<ChannelPoolDeps> = {}): ChannelPool {
  return new ChannelPool({
    dir,
    manifest: async () => [CHANNEL, 'tag:bilibili:ai'],
    uploads: async (key) => (key.startsWith('tag:') ? [LANTERNS] : [COLORS]),
    now: () => 1_000,
    pauseMs: 0,
    ...over,
  })
}

describe('the pool knows its tag rows', () => {
  it('marks the rows a tag line brought, counts them, and keeps the mark across a restart', async () => {
    const built = pool()
    await built.refresh()
    expect(built.isTagRow(LANTERNS.ref)).toBe(true)
    expect(built.isTagRow(COLORS.ref)).toBe(false)
    expect(built.isTagRow('https://www.bilibili.com/video/BVnowhere')).toBe(false)
    expect(built.aiRows()).toBe(1)
    const reopened = pool({ manifest: async () => [] })
    expect(reopened.isTagRow(LANTERNS.ref)).toBe(true)
    expect(reopened.aiRows()).toBe(1)
  })

  it('reads a pool written before the mark as no cache at all', () => {
    writeFileSync(join(dir, 'pool.json'), JSON.stringify({ v: 2, at: 1_000, tracks: [LANTERNS] }))
    expect(pool().count()).toBe(0)
  })

  // The tags pass and the voice-clone rule changed what a tag row may be, so a
  // pool written before them would serve their covers until its next refresh.
  it('reads a pool written before the not-original tags as no cache at all', () => {
    writeFileSync(join(dir, 'pool.json'), JSON.stringify({ v: 3, at: 1_000, tracks: [{ ...LANTERNS, origin: 'tag' }] }))
    expect(pool().count()).toBe(0)
  })

  it('asks a tag line for its three newest pages and a channel for its newest page', async () => {
    const asked: [string, number][] = []
    await pool({ uploads: async (key, limit) => (asked.push([key, limit]), []) }).refresh()
    expect(asked).toEqual([[CHANNEL, UPLOADS_PER_CHANNEL], ['tag:bilibili:ai', UPLOADS_PER_TAG]])
    expect(UPLOADS_PER_TAG).toBe(3 * UPLOADS_PER_CHANNEL)
  })
})

// The AI slot draws on the tag rows, and a tag feed is newest-first: replaced
// whole on every refresh, yesterday's AI songs were gone by today and the few
// that stayed on the newest pages came up again and again. So the tag rows the
// pool has seen stay, a bounded set rolled by when each was last seen.
describe('the pool remembers the AI rows it has seen', () => {
  const ai = (n: number) => row(`Lantern ${n}`, 200, [AI])
  // Each refresh's tag line answers the rows the test hands it next.
  function rolling(batches: ChannelTrack[][], over: Partial<ChannelPoolDeps> = {}) {
    let i = 0
    let channel: ChannelTrack[] = [COLORS]
    const built = pool({ uploads: async (key) => (key.startsWith('tag:') ? (batches[i] ?? []) : channel), ...over })
    return {
      built,
      next: async (channelRows?: ChannelTrack[]) => {
        if (channelRows !== undefined) channel = channelRows
        await built.refresh()
        i++
      },
    }
  }
  const tagRefs = (built: ChannelPool) => built.search('', 10_000).map((c) => c.ref).filter((ref) => built.isTagRow(ref))

  it('keeps a tag row a later refresh no longer brings, and replaces the channel rows as before', async () => {
    const HARBOUR = row('Harbour Two | A COLORS SHOW', 240, null, 'COLORS')
    const { built, next } = rolling([[ai(1), ai(2)], [ai(3)]])
    await next()
    await next([HARBOUR])
    expect(built.aiRows()).toBe(3)
    for (const n of [1, 2, 3]) expect(built.isTagRow(ai(n).ref)).toBe(true)
    expect(built.search('harbour', 10).map((c) => c.ref)).toEqual([HARBOUR.ref])
    // And across a restart: the remembered rows are in the cache.
    expect(pool({ manifest: async () => [] }).aiRows()).toBe(3)
  })

  it('holds at most MAX_AI_ROWS, letting the longest-unseen go first', async () => {
    const batch = (from: number) => Array.from({ length: 200 }, (_, k) => ai(from + k))
    const { built, next } = rolling([batch(0), batch(200), [ai(5), ai(1000)]])
    await next()
    await next()
    expect(built.aiRows()).toBe(MAX_AI_ROWS)
    // The second batch is all there; the first only as far as the bound allows.
    expect(built.isTagRow(ai(399).ref)).toBe(true)
    expect(built.isTagRow(ai(99).ref)).toBe(true)
    expect(built.isTagRow(ai(100).ref)).toBe(false)
    // A row seen again is fresh again: it moves to the front of the roll.
    await next()
    expect(tagRefs(built)).toContain(ai(5).ref)
    expect(built.isTagRow(ai(99).ref)).toBe(false)
  })

  // The bound is on what is remembered: rows a refresh just read are never
  // thrown away for it, and they leave no room for older ones.
  it('keeps every tag row a refresh brings, past the bound, and then remembers none', async () => {
    const many = Array.from({ length: MAX_AI_ROWS + 10 }, (_, k) => ai(2000 + k))
    const { built, next } = rolling([[ai(1)], many])
    await next()
    await next()
    expect(built.aiRows()).toBe(MAX_AI_ROWS + 10)
    expect(built.isTagRow(ai(1).ref)).toBe(false)
  })

  it('takes a row seen again with what the feed says of it now', async () => {
    const seenAgain = { ...ai(1), extra: { zone: 'original', tags: [AI, 'ballad'], viewCount: 99 } }
    const { built, next } = rolling([[ai(1), ai(2)], [seenAgain]])
    await next()
    await next()
    expect(built.aiRows()).toBe(2)
    expect(built.search('ballad', 10)[0]?.extra).toEqual(seenAgain.extra)
  })

  it('forgets them once the list holds no tag line at all', async () => {
    let keys = [CHANNEL, 'tag:bilibili:ai']
    const { built, next } = rolling([[ai(1)]], { manifest: async () => keys })
    await next()
    keys = [CHANNEL]
    await next()
    expect(built.aiRows()).toBe(0)
  })

  it('still caps the whole pool at MAX_POOL_TRACKS', async () => {
    const channelRows = Array.from({ length: MAX_POOL_TRACKS }, (_, k) => row(`Harbour ${k}`, 240, null, 'COLORS'))
    const { built, next } = rolling([[ai(1)], []])
    await next()
    await next(channelRows)
    expect(built.count()).toBe(MAX_POOL_TRACKS)
  })
})

describe("the channels catalogue's search", () => {
  const ISAIAH = row('Isaiah Walks Home', 200, null, 'Iron Maiden Fanclub')
  const many = Array.from({ length: 12 }, (_, i) => row(`Harbour Song ${i}`, 200, null, 'COLORS'))
  // A small deterministic stream, so a sample is reproducible and still not
  // the identity shuffle.
  const seeded = (seed: number) => () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648)

  async function stocked(rows: ChannelTrack[], random?: () => number) {
    const built = pool({ manifest: async () => [CHANNEL], uploads: async () => rows, ...(random !== undefined && { random }) })
    await built.refresh()
    return built
  }

  it('matches words against title, uploader and tags', async () => {
    const built = await stocked([LANTERNS, COLORS])
    expect(built.search('ballad').map((c) => c.ref)).toEqual([LANTERNS.ref])
    expect(built.search('colors harbour').map((c) => c.ref)).toEqual([COLORS.ref])
    expect(built.search(AI).map((c) => c.ref)).toEqual([LANTERNS.ref])
  })

  it('lands an ASCII word on a whole word only: AI is not inside Isaiah or Maiden', async () => {
    const built = await stocked([LANTERNS, ISAIAH, COLORS])
    expect(built.search('ai').map((c) => c.ref)).toEqual([LANTERNS.ref])
    expect(built.search('AI ballad').map((c) => c.ref)).toEqual([LANTERNS.ref])
  })

  it('answers with a random sample of the matches, not the first N', async () => {
    const built = await stocked(many, seeded(7))
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const found = built.search('harbour', 3)
      expect(found).toHaveLength(3)
      expect(new Set(found.map((c) => c.ref)).size).toBe(3)
      for (const c of found) seen.add(c.ref)
    }
    expect(seen.size).toBeGreaterThan(3)
  })

  it('answers an empty query, and one nothing matches, with a sample of the whole pool', async () => {
    const built = await stocked([...many, LANTERNS], seeded(3))
    const refs = new Set([...many, LANTERNS].map((t) => t.ref))
    for (const query of ['', '   ', 'reggaeton polka']) {
      const found = built.search(query, 5)
      expect(found, query).toHaveLength(5)
      for (const c of found) expect(refs.has(c.ref)).toBe(true)
    }
  })
})

describe('an AI slot at submit_pick', () => {
  const TAG: TrackCandidate = { ref: 'https://www.bilibili.com/video/BVtag', title: 'Paper Lanterns', uploader: 'Lantern Studio', durationS: 200, extra: {}, catalogue: 'channels' }
  const OTHER: TrackCandidate = { ref: 'https://youtu.be/other', title: 'Harbour Lights', uploader: 'Tin Roof', durationS: 200, extra: {} }
  const REFUSAL = 'this slot plays one of the AI-generated songs from the channels catalogue: search it and submit one of those.'

  function build(over: { aiSlot?: boolean; newOnly?: boolean; avoid?: string[]; label?: (title: string) => Familiarity } = {}) {
    const picks: TrackPick[] = []
    const log: string[] = []
    const channels: ChannelCatalogue = { count: () => 1, search: () => [TAG], isTagRow: (ref) => ref === TAG.ref }
    const tools = musicTools(new FakeMusicProvider(), (pick) => picks.push(pick), undefined, undefined, channels, over.avoid ?? [], {
      label: async (title) => over.label?.(title) ?? { label: 'new', familiar: false },
      ...(over.aiSlot !== undefined && { aiSlot: over.aiSlot }),
      ...(over.newOnly !== undefined && { newOnly: over.newOnly }),
      log: (m) => log.push(m),
    })
    const submit = (c: TrackCandidate) => callTool(tools, 'submit_pick', { ref: c.ref, why: 'w', title: c.title, artist: c.uploader })
    return { picks, log, submit }
  }

  it('takes a tag row of the pool at once', async () => {
    const { picks, log, submit } = build({ aiSlot: true })
    expect((await submit(TAG)).ok).toBe(true)
    expect(picks).toHaveLength(1)
    expect(log).toContain('music.slot ai picked=ai refused=0 fail-open=0')
  })

  it('turns back anything else three times with the slot error, then plays it', async () => {
    const { picks, log, submit } = build({ aiSlot: true })
    for (let i = 0; i < 3; i++) expect(await submit(OTHER)).toEqual({ ok: false, error: REFUSAL })
    expect(picks).toHaveLength(0)
    expect((await submit(OTHER)).ok).toBe(true)
    expect(picks).toHaveLength(1)
    expect(log).toContain('music.slot ai picked=other refused=3 fail-open=1')
    // Counts only, never a title (spec 14 §3.6).
    expect(log.join('\n')).not.toContain('Harbour')
  })

  it('still refuses a tag row that was played recently, without spending a slot refusal on it', async () => {
    const { picks, log, submit } = build({ aiSlot: true, avoid: ['Paper Lanterns — Lantern Studio'] })
    expect(String((await submit(TAG)).error)).toMatch(/played recently/)
    for (let i = 0; i < 3; i++) expect((await submit(OTHER)).ok).toBe(false)
    expect((await submit(OTHER)).ok).toBe(true)
    expect(picks).toHaveLength(1)
    expect(log).toContain('music.slot ai picked=other refused=3 fail-open=1')
  })

  it('keeps the familiarity refusal armed on a new-only slot', async () => {
    const { picks, submit } = build({ aiSlot: true, newOnly: true, label: () => ({ label: 'played by murmur', familiar: true }) })
    expect(String((await submit(TAG)).error)).toMatch(/something they have not heard/)
    expect((await submit(TAG)).ok).toBe(true)
    expect(picks).toHaveLength(1)
  })

  it('refuses nothing for it off an AI slot', async () => {
    for (const aiSlot of [false, undefined]) {
      const { picks, log, submit } = build(aiSlot === undefined ? {} : { aiSlot })
      expect((await submit(OTHER)).ok).toBe(true)
      expect(picks).toHaveLength(1)
      expect(log.join('\n')).not.toContain('music.slot ai')
    }
  })

  it('reaches the tools from the pick context through the programmer', async () => {
    let refused: Record<string, unknown> = {}
    const brain = {
      runTask: async <T,>(req: { tools: (finish: (value: T) => void) => TaskTool[] }) => {
        refused = await callTool(req.tools(() => {}), 'submit_pick', { ref: OTHER.ref, why: 'w', title: OTHER.title, artist: OTHER.uploader })
        return null
      },
    } as unknown as Harness
    const programmer = new MusicProgrammer({
      brain,
      provider: new FakeMusicProvider(),
      model: 'm',
      discovery: { label: async () => ({ label: 'new', familiar: false }) },
      channels: { count: () => 1, search: () => [TAG], isTagRow: (ref) => ref === TAG.ref, maybeRefresh: () => false },
    })
    await programmer.nextTrack({ persona: 'p', situation: 's', aiSlot: true })
    expect(refused).toEqual({ ok: false, error: REFUSAL })
  })
})

describe('what the pick task is told the channels catalogue holds', () => {
  it('names the curated channels, the AI tag feeds, and how a word matches', () => {
    expect(CHANNELS_GUIDANCE).toMatch(/curated/)
    expect(CHANNELS_GUIDANCE).toMatch(/AI-generated/)
    expect(CHANNELS_GUIDANCE).toMatch(/Bilibili's tag feeds/)
    expect(CHANNELS_GUIDANCE).not.toMatch(/YouTube/)
    expect(CHANNELS_GUIDANCE).toMatch(/titles, uploaders and tags/)
    expect(CHANNELS_GUIDANCE).toContain('"\u539f\u521b"')
    expect(CHANNELS_GUIDANCE).toMatch(/empty query/)
  })

  it('carries no rule of its own: the slot line is where the instruction lives', () => {
    expect(CHANNELS_GUIDANCE).not.toMatch(/say on air|this slot|must|always/i)
    expect(CHANNELS_GUIDANCE).not.toMatch(/listener'?s? (taste|kept|likes)|what they keep/i)
    expect(buildFindMusicInstruction(undefined, { channels: true })).toContain(CHANNELS_GUIDANCE)
  })
})
