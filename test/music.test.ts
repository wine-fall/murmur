import { describe, expect, it } from 'vitest'

import { parseResolveOutput, parseSearchOutput, parseSegmentRef, YtDlpMusicProvider } from '../src/music/music.ts'
import { BrowserCookieError } from '../src/music/sources/cookies.ts'

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

describe('parseResolveOutput', () => {
  it('reads the duration line and the stream url yt-dlp prints in --print order', () => {
    expect(parseResolveOutput('183\nhttps://stream/1\n')).toEqual({
      source: 'https://stream/1',
      durationS: 183,
    })
  })

  it("treats yt-dlp's NA (a live stream, a hit with no duration) as 0 — unknown, not a length", () => {
    expect(parseResolveOutput('NA\nhttps://stream/1\n').durationS).toBe(0)
    expect(parseResolveOutput('\nhttps://stream/1\n').durationS).toBe(0)
    expect(parseResolveOutput('-1\nhttps://stream/1\n').durationS).toBe(0)
    expect(parseResolveOutput('183.7\nhttps://stream/1\n').durationS).toBe(183)
  })

  it('finds the url wherever it sits, so a mis-ordered field never becomes the source', () => {
    // The song dies silently if a duration line is handed to the decoder as a
    // stream: pick the line that IS a url rather than trusting the position.
    expect(parseResolveOutput('https://stream/1\n183\n').source).toBe('https://stream/1')
    expect(parseResolveOutput('  \n183\n  https://stream/1  \n').source).toBe('https://stream/1')
  })

  it('reads the http_headers object yt-dlp prints, and leaves headers off when it printed none', () => {
    const line = '{"User-Agent": "Mozilla/5.0 Chrome/145", "Referer": "http://www.bilibili.com/"}'
    expect(parseResolveOutput(`183\nhttps://stream/1\n${line}\n`)).toEqual({
      source: 'https://stream/1',
      durationS: 183,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/145', Referer: 'http://www.bilibili.com/' },
    })
    expect(parseResolveOutput('183\nhttps://stream/1\n')).not.toHaveProperty('headers')
  })

  it('ignores an http_headers line that is not an object of strings — the stream still plays', () => {
    // A trust boundary: yt-dlp's output is parsed, never trusted. A junk line
    // must cost the headers, not the song.
    for (const junk of ['NA', 'not json', '[1,2]', '{"UA": 3}', '{"a": {"b": 1}}']) {
      expect(parseResolveOutput(`183\nhttps://stream/1\n${junk}\n`)).toEqual({
        source: 'https://stream/1',
        durationS: 183,
      })
    }
  })

  it('fails loudly when yt-dlp printed no url', () => {
    expect(() => parseResolveOutput('   \n')).toThrow(/stream url/i)
    expect(() => parseResolveOutput('183\n')).toThrow(/stream url/i)
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
    // --flat-playlist (issue #76): one request for the whole result page
    // instead of a full per-hit extraction — measured ~2s vs ~10-17s — and the
    // flat entries still carry every field the brain judges on.
    expect(calls[0]).toEqual(['--dump-json', '--flat-playlist', 'ytsearch3:late night city pop'])
    expect(candidates).toHaveLength(1)
  })

  it('resolves a ref to a stream URL and its length, audio-only preferred (no disk download)', async () => {
    const calls: string[][] = []
    const provider = new YtDlpMusicProvider({
      run: async (args) => {
        calls.push(args)
        return '183\nhttps://stream/audio\n'
      },
    })
    const clip = await provider.resolve('https://youtube.com/watch?v=a')
    // The length rides the SAME call that already resolves the stream — measured
    // at no cost over the bare `-g` (2.4s either way), and no second extraction.
    expect(calls[0]).toEqual([
      '-f',
      'bestaudio/best',
      '--print',
      '%(duration)s',
      '--print',
      'urls',
      '--print',
      '%(http_headers)j',
      'https://youtube.com/watch?v=a',
    ])
    expect(clip).toEqual({ source: 'https://stream/audio', kind: 'music', durationS: 183 })
  })

  it('carries the headers yt-dlp says the stream needs onto the clip (a Bilibili CDN 403s without them)', async () => {
    const headers = { 'User-Agent': 'Mozilla/5.0 Chrome/145', Referer: 'http://www.bilibili.com/video/BV1xx' }
    const provider = new YtDlpMusicProvider({
      run: async () => `183\nhttps://upos.akamaized.net/s\n${JSON.stringify(headers)}\n`,
    })
    expect(await provider.resolve('https://www.bilibili.com/video/BV1xx')).toEqual({
      source: 'https://upos.akamaized.net/s',
      kind: 'music',
      durationS: 183,
      headers,
    })
  })

  it('leaves durationS off the clip when yt-dlp does not know the length', async () => {
    const provider = new YtDlpMusicProvider({ run: async () => 'NA\nhttps://stream/audio\n' })
    expect(await provider.resolve('ref')).toEqual({ source: 'https://stream/audio', kind: 'music' })
  })

  // A browser store that cannot be read is a mount diagnosis, not a reason
  // to stop playing music: a public NetEase track resolves anonymously, as
  // it did before the cookie reader learned to report its failures.
  it('still resolves a mounted source anonymously when its cookie store cannot be read', async () => {
    const calls: string[][] = []
    let asked = 0
    const provider = new YtDlpMusicProvider({
      run: async (args) => {
        calls.push(args)
        return '215\nhttps://stream.example/audio\n'
      },
      cookies: async () => {
        asked++
        throw new BrowserCookieError('chrome', 'no-permission', 'Operation not permitted')
      },
    })
    const clip = await provider.resolve('https://music.163.com/#/song?id=5')
    expect(asked).toBe(1)
    expect(clip.source).toBe('https://stream.example/audio')
    // The resolve ran with no cookie args, rather than not running at all.
    expect(calls[0]).not.toContain('--cookies')
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

// --- the chapter fragment (spec 14 §2.9 / spec 03-01 §2.2) ----------------- //
//
// A chapter candidate's ref is the upload's own url carrying a W3C media
// fragment: `#t=<start>,<end>` in seconds. Nothing else in the pipeline has to
// learn about chapters — `sourceOfRef` keys on the hostname, and resolve is
// where the fragment turns into a segment on the clip.
describe('segment refs', () => {
  it('reads a media fragment off a ref and leaves a bare one alone', () => {
    expect(parseSegmentRef('https://www.youtube.com/watch?v=kx22t0PBrKM#t=612,868')).toEqual({
      url: 'https://www.youtube.com/watch?v=kx22t0PBrKM',
      segment: { startS: 612, endS: 868 },
    })
    expect(parseSegmentRef('https://www.youtube.com/watch?v=kx22t0PBrKM')).toEqual({
      url: 'https://www.youtube.com/watch?v=kx22t0PBrKM',
    })
    // Half a fragment, a backwards one, or someone else's `#` is not a segment.
    for (const ref of ['https://u/v#t=612', 'https://u/v#t=868,612', 'https://u/v#/song?id=5', 'https://u/v#t=a,b']) {
      expect(parseSegmentRef(ref).segment).toBeUndefined()
    }
  })

  it('resolves the bare url and hands back the segment, with the segment length as durationS', async () => {
    const calls: string[][] = []
    const provider = new YtDlpMusicProvider({
      run: async (args) => {
        calls.push(args)
        return '7506\nhttps://stream/audio\n'
      },
    })
    const clip = await provider.resolve('https://www.youtube.com/watch?v=kx22t0PBrKM#t=612,868')
    // yt-dlp is handed the upload, not the fragment.
    expect(calls[0]?.at(-1)).toBe('https://www.youtube.com/watch?v=kx22t0PBrKM')
    expect(clip).toEqual({
      source: 'https://stream/audio',
      kind: 'music',
      // The SEGMENT's length, not the two-hour upload's: the coda timing, the
      // announce and the talk-ahead all read this.
      durationS: 256,
      segment: { startS: 612, endS: 868 },
    })
  })
})
