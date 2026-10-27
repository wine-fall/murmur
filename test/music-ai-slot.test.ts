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
import { aiSong, ChannelPool, type ChannelPoolDeps, type ChannelTrack, channelUploads } from '../src/music/channels.ts'
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
    expect(CHANNELS_GUIDANCE).toMatch(/Bilibili/)
    expect(CHANNELS_GUIDANCE).toMatch(/YouTube/)
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
