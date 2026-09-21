// The candidate pools (spec 14 §3.10 step 4): where the pick goes instead of
// the model's own memory. Both are catalogue values on `search_music` — the
// pick task is locked at exactly two tools (spec 03-01 §5 #7).
import { describe, expect, it } from 'vitest'

import type { TrackCandidate, TrackPick } from '../src/contracts.ts'
import { musicTools } from '../src/music/music-tools.ts'
import { YtDlpMusicProvider } from '../src/music/music.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

const candidate = (id: string): TrackCandidate => ({
  ref: `https://music.163.com/#/song?id=${id}`,
  title: `track ${id}`,
  uploader: `singer ${id}`,
  durationS: 200,
  extra: {},
  catalogue: 'netease',
})

function build(): { provider: FakeMusicProvider; tools: ReturnType<typeof musicTools>; picks: TrackPick[] } {
  const provider = new FakeMusicProvider()
  const picks: TrackPick[] = []
  return { provider, picks, tools: musicTools(provider, (pick) => picks.push(pick)) }
}

describe('the mood pool on search_music (spec 14 §3.10)', () => {
  it('is offered with no account mounted at all: the pool reads anonymously', async () => {
    const { provider, tools } = build()
    provider.byCatalogue = { playlists: [candidate('1')] }
    const result = await callTool(tools, 'search_music', { query: 'a long drive in the rain', catalogue: 'playlists' })
    expect(result).toMatchObject({ candidates: [{ title: 'track 1' }] })
    expect(provider.searches.at(-1)).toMatchObject({ query: 'a long drive in the rain', catalogue: 'playlists' })
  })

  it('says what it is for, in the words the model fills the field with', () => {
    const { tools } = build()
    const schema = tools.find((t) => t.name === 'search_music')!.inputSchema as Record<string, { description?: string }>
    expect(schema.catalogue!.description).toMatch(/playlists/)
  })
})

describe('YtDlpMusicProvider routes the pool to its own client', () => {
  it('hands the playlists catalogue to the mood pool, never to yt-dlp', async () => {
    const asked: [string, number][] = []
    const provider = new YtDlpMusicProvider({
      run: async () => {
        throw new Error('yt-dlp must not be spawned for the mood pool')
      },
      playlists: {
        search: async (query, limit) => {
          asked.push([query, limit])
          return [candidate('7')]
        },
      },
    })
    expect(await provider.search('quiet', 4, 'playlists')).toEqual([candidate('7')])
    expect(asked).toEqual([['quiet', 4]])
  })

  it('answers an unwired pool as the empty pool, never as a crash', async () => {
    const provider = new YtDlpMusicProvider({ run: async () => '' })
    await expect(provider.search('quiet', 4, 'playlists')).rejects.toThrow(/not mounted|not available/)
  })
})
