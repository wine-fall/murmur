// The slot rule at the tool seam (spec 14 §3.10 step 5): every hit comes back
// labelled, and a "new only" slot turns back a familiar submission ONCE and
// then plays it anyway — a familiar song beats dead air.
import { describe, expect, it } from 'vitest'

import type { Familiarity, TrackPick } from '../src/contracts.ts'
import { musicTools } from '../src/music/music-tools.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

const KEPT: Familiarity = { label: 'kept', familiar: true }
const NEW: Familiarity = { label: 'new', familiar: false }

function build(over: { newOnly?: boolean; labels?: Record<string, Familiarity> } = {}) {
  const provider = new FakeMusicProvider()
  provider.candidates = [
    { ref: 'https://youtu.be/1', title: 'Kept One', uploader: 'Paper Ferries', durationS: 200, extra: {} },
    { ref: 'https://youtu.be/2', title: 'New One', uploader: 'Someone Else', durationS: 200, extra: {} },
  ]
  const picks: TrackPick[] = []
  const log: string[] = []
  const labels = over.labels ?? { 'Kept One': KEPT }
  const tools = musicTools(provider, (pick) => picks.push(pick), undefined, undefined, undefined, [], {
    label: async (title) => labels[title] ?? NEW,
    ...(over.newOnly !== undefined && { newOnly: over.newOnly }),
    log: (m) => log.push(m),
  })
  return { tools, picks, log, provider }
}

describe('search_music labels every hit', () => {
  it('says what the listener already knows before the model chooses', async () => {
    const { tools } = build()
    const result = await callTool(tools, 'search_music', { query: 'anything' })
    expect(result.candidates).toMatchObject([
      { title: 'Kept One', familiar: 'kept' },
      { title: 'New One', familiar: 'new' },
    ])
  })

  it('labels nothing when the rule is not wired at all', async () => {
    const provider = new FakeMusicProvider()
    provider.candidates = [{ ref: 'https://youtu.be/1', title: 'Kept One', uploader: 'x', durationS: 200, extra: {} }]
    const result = await callTool(musicTools(provider, () => {}), 'search_music', { query: 'anything' })
    expect(result.candidates).toMatchObject([{ title: 'Kept One' }])
    expect(JSON.stringify(result)).not.toContain('familiar')
  })
})

describe('a "new only" slot', () => {
  it('turns back a familiar submission once, naming somewhere else to look', async () => {
    const { tools, picks, log } = build({ newOnly: true })
    const refused = await callTool(tools, 'submit_pick', { ref: 'https://youtu.be/1', why: 'w', title: 'Kept One', artist: 'Paper Ferries' })
    expect(refused.ok).toBe(false)
    expect(String(refused.error)).toMatch(/playlists|neighbours/)
    expect(picks).toHaveLength(0)
    // ...and then gets out of the way: a familiar song beats dead air.
    const second = await callTool(tools, 'submit_pick', { ref: 'https://youtu.be/1', why: 'w', title: 'Kept One', artist: 'Paper Ferries' })
    expect(second.ok).toBe(true)
    expect(picks).toHaveLength(1)
    expect(log.join('\n')).toMatch(/music\.slot new-only picked=familiar refused=1 fail-open=1/)
    // Counts only, never a title (spec 14 §3.6).
    expect(log.join('\n')).not.toContain('Kept One')
  })

  it('lets a new song straight through, and says so in the count', async () => {
    const { tools, picks, log } = build({ newOnly: true })
    expect((await callTool(tools, 'submit_pick', { ref: 'https://youtu.be/2', why: 'w', title: 'New One', artist: 'Someone Else' })).ok).toBe(true)
    expect(picks).toHaveLength(1)
    expect(log.join('\n')).toMatch(/music\.slot new-only picked=new refused=0 fail-open=0/)
  })

  it('does not refuse anything on a slot that allows the familiar', async () => {
    const { tools, picks } = build({ newOnly: false })
    expect((await callTool(tools, 'submit_pick', { ref: 'https://youtu.be/1', why: 'w', title: 'Kept One', artist: 'Paper Ferries' })).ok).toBe(true)
    expect(picks).toHaveLength(1)
  })

  it('is inert when no rule was wired', async () => {
    const provider = new FakeMusicProvider()
    provider.candidates = [{ ref: 'https://youtu.be/1', title: 'Kept One', uploader: 'x', durationS: 200, extra: {} }]
    const picks: TrackPick[] = []
    const tools = musicTools(provider, (pick) => picks.push(pick))
    expect((await callTool(tools, 'submit_pick', { ref: 'https://youtu.be/1', why: 'w', title: 'Kept One', artist: 'x' })).ok).toBe(true)
    expect(picks).toHaveLength(1)
  })

  it('counts the songs it labelled, so the share can be read back per 100 airs', async () => {
    const { tools, log } = build({ newOnly: false })
    await callTool(tools, 'submit_pick', { ref: 'https://youtu.be/1', why: 'w', title: 'Kept One', artist: 'Paper Ferries' })
    expect(log.join('\n')).toMatch(/music\.slot (familiar-ok|new-only) picked=familiar/)
  })
})
