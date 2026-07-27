import { describe, expect, it } from 'vitest'

import { parseSearchOutput, parseStreamUrl, YtDlpMusicProvider } from '../src/music.ts'

// One line of real-shaped `yt-dlp --dump-json` output.
function hit(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Song A',
    webpage_url: 'https://youtube.com/watch?v=a',
    uploader: 'Label Official',
    duration: 214,
    view_count: 9_000,
    ...overrides,
  })
}

describe('parseSearchOutput', () => {
  it('parses candidates with the signal the brain judges on', () => {
    expect(parseSearchOutput(hit(), 5)).toEqual([
      {
        ref: 'https://youtube.com/watch?v=a',
        title: 'Song A',
        uploader: 'Label Official',
        durationS: 214,
        extra: { viewCount: 9_000 },
      },
    ])
  })

  it('tolerates non-JSON noise and drops entries with no title or ref', () => {
    const out = [
      'WARNING: some yt-dlp chatter',
      hit(),
      JSON.stringify({ title: 'no ref here' }),
      JSON.stringify({ webpage_url: 'https://x/1' }),
      '{ broken json',
    ].join('\n')
    expect(parseSearchOutput(out, 5)).toHaveLength(1)
  })

  it('falls back through url/id for the ref and channel for the uploader', () => {
    const [c] = parseSearchOutput(
      hit({ webpage_url: undefined, url: undefined, id: 'BV1xx', uploader: undefined, channel: 'ch' }),
      5,
    )
    expect(c).toMatchObject({ ref: 'BV1xx', uploader: 'ch' })
  })

  it('treats a missing or unusable duration as 0 rather than dropping the hit', () => {
    expect(parseSearchOutput(hit({ duration: null }), 5)[0]!.durationS).toBe(0)
    expect(parseSearchOutput(hit({ duration: 214.7 }), 5)[0]!.durationS).toBe(214)
  })

  it('caps at the requested limit', () => {
    expect(parseSearchOutput([hit(), hit(), hit()].join('\n'), 2)).toHaveLength(2)
  })
})

describe('parseStreamUrl', () => {
  it('takes the first non-empty line', () => {
    expect(parseStreamUrl('\n  https://stream/1  \nhttps://stream/2\n')).toBe('https://stream/1')
  })

  it('fails loudly when yt-dlp printed no url', () => {
    expect(() => parseStreamUrl('   \n')).toThrow(/stream url/i)
  })
})

describe('YtDlpMusicProvider', () => {
  it('searches metadata-only, with the limit in the ytsearch spec', async () => {
    const calls: string[][] = []
    const provider = new YtDlpMusicProvider({
      run: async (args) => {
        calls.push(args)
        return hit()
      },
    })
    const candidates = await provider.search('late night city pop', 3)
    expect(calls[0]).toEqual(['--dump-json', 'ytsearch3:late night city pop'])
    expect(candidates).toHaveLength(1)
  })

  it('resolves a ref to a stream URL, audio-only preferred (no disk download)', async () => {
    const calls: string[][] = []
    const provider = new YtDlpMusicProvider({
      run: async (args) => {
        calls.push(args)
        return 'https://stream/audio\n'
      },
    })
    const clip = await provider.resolve('https://youtube.com/watch?v=a')
    expect(calls[0]).toEqual(['-f', 'bestaudio/best', '-g', 'https://youtube.com/watch?v=a'])
    expect(clip).toEqual({ source: 'https://stream/audio', kind: 'music' })
  })
})

// Real network + the real binary (spec 03-01 §5 integration layer). Off by
// default; run with MURMUR_INTEGRATION=1.
describe.skipIf(!process.env.MURMUR_INTEGRATION)('YtDlpMusicProvider (integration)', () => {
  it('searches and resolves a real playable stream', async () => {
    const provider = new YtDlpMusicProvider({})
    const candidates = await provider.search('city pop official audio', 2)
    expect(candidates.length).toBeGreaterThan(0)
    const clip = await provider.resolve(candidates[0]!.ref)
    expect(clip.source).toMatch(/^https?:\/\//)
  }, 120_000)
})
