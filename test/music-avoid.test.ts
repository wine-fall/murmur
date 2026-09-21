// The anti-repeat guard inside submit_pick (spec 03-01 §2.3).
//
// The music policy asks the model not to replay what is on the avoid-list, and
// a prompt rule is advice: on 2026-09-17 the same track was picked twice inside
// 78 minutes with its own label sitting on that list. The tool refuses it now,
// so the rule holds whether or not the model read it.

import { describe, expect, it } from 'vitest'

import type { TrackPick } from '../src/contracts.ts'
import { musicTools } from '../src/music/music-tools.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

// The label the ledger wrote at 15:32 on 2026-09-17, and the one the model
// handed back at 16:50 (escaped: v1 sources carry no CJK of their own).
const REPEATED = '\u604b\u306e\u985b\u672b — \u30cf\u30f3\u30d0\u30fc\u30c8 \u30cf\u30f3\u30d0\u30fc\u30c8'

function build(avoid: string[]) {
  const provider = new FakeMusicProvider()
  provider.candidates = [{ ref: 'https://youtu.be/1', title: 'Song', uploader: 'Artist', durationS: 200, extra: {} }]
  const picks: TrackPick[] = []
  const tools = musicTools(provider, (pick) => picks.push(pick), undefined, undefined, undefined, avoid)
  return { provider, tools, picks }
}

const ARGS = { ref: 'https://youtu.be/1', why: 'w', title: 'Song', artist: 'Artist' }

describe('submit_pick refuses a track on the avoid-list', () => {
  it('turns back a repeat and asks for another, without resolving it', async () => {
    const { provider, tools, picks } = build(['Song — Artist'])
    // A resolve of this ref would fail with its own message, so the avoid
    // message is proof the guard ran before the network did.
    provider.broken.add('https://youtu.be/1')
    const result = await callTool(tools, 'submit_pick', ARGS)
    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/played recently/i)
    expect(picks).toHaveLength(0)
  })

  it('sees through case and stray whitespace', async () => {
    const { tools, picks } = build(['Song — Artist'])
    const result = await callTool(tools, 'submit_pick', { ...ARGS, title: '  song  ', artist: 'ARTIST' })
    expect(result.ok).toBe(false)
    expect(picks).toHaveLength(0)
  })

  it('lets a track that is not on the list through', async () => {
    const { tools, picks } = build(['Something Else — Someone'])
    expect((await callTool(tools, 'submit_pick', ARGS)).ok).toBe(true)
    expect(picks).toHaveLength(1)
  })

  it('is inert when no avoid-list is wired', async () => {
    const { tools, picks } = build([])
    expect((await callTool(tools, 'submit_pick', ARGS)).ok).toBe(true)
    expect(picks).toHaveLength(1)
  })

  it('refuses the track that actually repeated on 2026-09-17', async () => {
    const { tools, picks } = build([REPEATED, '\u534a\u58f6\u7eb1 — \u5218\u73c2\u77e3'])
    const result = await callTool(tools, 'submit_pick', {
      ...ARGS,
      title: '\u604b\u306e\u985b\u672b',
      artist: '\u30cf\u30f3\u30d0\u30fc\u30c8 \u30cf\u30f3\u30d0\u30fc\u30c8',
    })
    expect(result.ok).toBe(false)
    expect(picks).toHaveLength(0)
  })

  // A pick that names no title used to carry the placeholder label 'music',
  // and every label-keyed guard slid off it: the repeat check, and now the
  // familiarity rule (spec 14 §3.10). The pick has to say what it is.
  it('turns back a submission that names no title, without resolving it', async () => {
    const { provider, tools, picks } = build([])
    provider.broken.add('https://youtu.be/1')
    const result = await callTool(tools, 'submit_pick', { ref: 'https://youtu.be/1', why: 'w' })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/title and artist/i)
    expect(picks).toHaveLength(0)
  })

  it('turns back a submission whose title or artist is blank', async () => {
    const { tools, picks } = build([])
    expect((await callTool(tools, 'submit_pick', { ...ARGS, title: '   ' })).ok).toBe(false)
    expect((await callTool(tools, 'submit_pick', { ...ARGS, artist: '' })).ok).toBe(false)
    expect(picks).toHaveLength(0)
  })

  // The schema the model reads is the first half of the same rule: an
  // optional field is one it may leave out and never be told it mattered.
  it('declares both fields required in the tool schema', () => {
    const { tools } = build([])
    const schema = tools.find((t) => t.name === 'submit_pick')!.inputSchema as Record<string, { isOptional?: () => boolean }>
    expect(schema.title!.isOptional!()).toBe(false)
    expect(schema.artist!.isOptional!()).toBe(false)
    expect(schema.announce!.isOptional!()).toBe(true)
  })

  // ponytail: trim + collapsed whitespace + case is the whole normalisation.
  // The ledger holds a band under both its simplified and its traditional
  // spelling, and those are NOT folded together here -- a script-conversion
  // table is a far bigger thing than the repeat it would catch. Upgrade path:
  // fold both sides through a converter before comparing.
  it('does not claim to fold anything beyond case and whitespace', async () => {
    const { tools, picks } = build(['\u623f\u4e1c\u7684\u732b — X'])
    const result = await callTool(tools, 'submit_pick', { ...ARGS, title: '\u623f\u6771\u7684\u8c93', artist: 'X' })
    expect(result.ok).toBe(true)
    expect(picks).toHaveLength(1)
  })
})
