// The wbi request signing beside the Bilibili client (spec 14 §2.9): the
// mixin key the two nav images spell out, the signed query, and the space
// listing that is the only reason this exists — yt-dlp's flat read of a
// Bilibili space returns refs with EMPTY titles, and a pool of untitled
// tracks cannot be searched.
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { BilibiliWeb, mixinKey, signedQuery } from '../src/music/sources/wbi.ts'

const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'

describe('mixinKey', () => {
  it('shuffles the two image stems into a 32-char key', () => {
    const key = mixinKey(IMG, SUB)
    expect(key).toHaveLength(32)
    // The permutation is positional, so the same pair always spells the same
    // key: a drifting table would silently sign every request wrong.
    expect(key).toBe(mixinKey(IMG, SUB))
    expect(key).not.toBe(mixinKey(SUB, IMG))
  })

  it('is empty when a url carries no stem', () => {
    expect(mixinKey('', '')).toBe('')
  })
})

describe('signedQuery', () => {
  it('sorts the params, adds wts, and signs the whole string', () => {
    const query = signedQuery({ mid: '1', ps: '5' }, 'themixinkey', 1_700_000_000)
    const body = 'mid=1&ps=5&wts=1700000000'
    expect(query).toBe(`${body}&w_rid=${createHash('md5').update(`${body}themixinkey`).digest('hex')}`)
  })

  it('drops the characters Bilibili strips before hashing', () => {
    expect(signedQuery({ q: "a!b'c(d)e*f" }, 'k', 1)).toContain('q=abcdef')
  })
})

// One nav read (keys) + one space read per call, with a fake transport.
function fakeSpace(answers: Record<string, unknown>, calls: string[] = []) {
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url)
    if (url.includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    }
    if (url.includes('/x/frontend/finger/spi')) {
      return new Response(JSON.stringify({ code: 0, data: { b_3: 'BUVID3', b_4: 'BUVID4' } }), { status: 200 })
    }
    return new Response(JSON.stringify(answers), { status: 200 })
  }
  return { calls, space: new BilibiliWeb({ fetch: fetcher }) }
}

describe('BilibiliWeb.recent', () => {
  it('returns titled uploads with a watch ref, newest first', async () => {
    const { space, calls } = fakeSpace({
      code: 0,
      data: { list: { vlist: [
        { bvid: 'BV1', title: 'a song', author: 'Netease Music', length: '02:40' },
        { bvid: 'BV2', title: 'another', author: 'Netease Music', length: '1:02:03' },
      ] } },
    })
    const tracks = await space.recent('607217518', 5)
    expect(tracks).toEqual([
      { ref: 'https://www.bilibili.com/video/BV1', title: 'a song', uploader: 'Netease Music', durationS: 160 },
      { ref: 'https://www.bilibili.com/video/BV2', title: 'another', uploader: 'Netease Music', durationS: 3723 },
    ])
    const search = calls.find((u) => u.includes('/x/space/wbi/arc/search'))
    expect(search).toBeDefined()
    expect(search).toContain('w_rid=')
    expect(search).toContain('mid=607217518')
  })

  it('skips a row with no title — an untitled ref is what this helper exists to avoid', async () => {
    const { space } = fakeSpace({ code: 0, data: { list: { vlist: [{ bvid: 'BV1', title: '   ', author: 'up' }, { bvid: '', title: 't', author: 'up' }] } } })
    expect(await space.recent('1', 5)).toEqual([])
  })

  it('throws on risk control so the caller keeps the pool it already had', async () => {
    const space = new BilibiliWeb({
      fetch: async (url) =>
        url.includes('arc/search')
          ? new Response('<!DOCTYPE html>', { status: 412 })
          : new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB }, b_3: 'x' } }), { status: 200 }),
    })
    await expect(space.recent('1', 5)).rejects.toThrow(/412/)
  })
})

it('the timeout covers the body, not only the headers', async () => {
  let aborted = false
  const space = new BilibiliWeb({
    timeoutMs: 20,
    fetch: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            // Headers land at once; the body never arrives. Only a timer still
            // running past the headers can rescue this call.
            init?.signal?.addEventListener('abort', () => {
              aborted = true
              controller.error(new Error('aborted'))
            })
          },
        }),
      ),
  })
  await expect(space.recent('1', 5)).rejects.toThrow()
  expect(aborted).toBe(true)
})

it('re-reads the signing keys rather than holding them for the life of the process', async () => {
  // Bilibili rotates the wbi keys; a long-lived radio that cached them once
  // would sign every later request with a dead key and be refused forever.
  let navs = 0
  let at = 0
  const space = new BilibiliWeb({
    now: () => at,
    fetch: async (url) => {
      if (url.includes('/x/frontend/finger/spi')) return new Response(JSON.stringify({ code: 0, data: { b_3: 'B' } }), { status: 200 })
      if (url.includes('/x/web-interface/nav')) {
        navs++
        return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { list: { vlist: [] } } }), { status: 200 })
    },
  })
  await space.recent('1', 5)
  await space.recent('2', 5)
  expect(navs).toBe(1) // one handshake serves a whole refresh
  at += 30 * 60_000
  await space.recent('3', 5)
  expect(navs).toBe(2)
})

it('ages the signing keys from when they were read, not from the last call', async () => {
  let navs = 0
  let at = 0
  const space = new BilibiliWeb({
    now: () => at,
    fetch: async (url) => {
      if (url.includes('finger/spi')) return new Response(JSON.stringify({ code: 0, data: { b_3: 'B' } }), { status: 200 })
      if (url.includes('web-interface/nav')) {
        navs++
        return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { list: { vlist: [] } } }), { status: 200 })
    },
  })
  // A call every few minutes must not keep a dead key alive forever.
  for (let i = 0; i < 5; i++) {
    await space.recent(String(i), 5)
    at += 4 * 60_000
  }
  expect(navs).toBe(2)
})

// The two reads that bypass yt-dlp's 412-prone page path (spec 14 §2.4/§2.5):
// the site's own search page, which already carries every field the pick
// judges on, and the anonymous play url behind pagelist.
function fakeWeb(answers: (url: string) => unknown, calls: { url: string; init?: RequestInit }[] = []) {
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init !== undefined && { init }) })
    if (url.includes('/x/web-interface/nav')) {
      return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    }
    if (url.includes('/x/frontend/finger/spi')) {
      return new Response(JSON.stringify({ code: 0, data: { b_3: 'BUVID3', b_4: 'BUVID4' } }), { status: 200 })
    }
    const body = answers(url)
    return typeof body === 'string' ? new Response(body, { status: 412 }) : new Response(JSON.stringify(body), { status: 200 })
  }
  return { calls, web: new BilibiliWeb({ fetch: fetcher }) }
}

const ROW = { bvid: 'BV1x', title: '<em class="keyword">rain</em> song', author: 'up', duration: '4:41', play: 487_831, typename: 'MV', tag: 'rap,ai rap,choir', arcurl: 'http://www.bilibili.com/video/av1' }

describe('BilibiliWeb.search', () => {
  it('answers titled candidates off one search page, with the tags and zone riding along', async () => {
    const { web, calls } = fakeWeb(() => ({ code: 0, data: { result: [ROW, { ...ROW, bvid: 'BV2x', title: 'other', duration: '1:02:03', tag: '' }] } }))
    const found = await web.search('rain song', 5)
    expect(found).toEqual([
      { ref: 'https://www.bilibili.com/video/BV1x', title: 'rain song', uploader: 'up', durationS: 281, extra: { viewCount: 487_831, zone: 'MV', tags: ['rap', 'ai rap', 'choir'] }, catalogue: 'bilibili' },
      { ref: 'https://www.bilibili.com/video/BV2x', title: 'other', uploader: 'up', durationS: 3723, extra: { viewCount: 487_831, zone: 'MV', tags: [] }, catalogue: 'bilibili' },
    ])
    const search = calls.find((c) => c.url.includes('/x/web-interface/search/type'))
    expect(search?.url).toContain('search_type=video')
    expect(search?.url).toContain('keyword=rain+song')
    // The request looks like the web player's: Referer and a site-issued
    // buvid, which is what separates a 200 from the risk-control page.
    const headers = search?.init?.headers as Record<string, string>
    expect(headers.Referer).toBe('https://www.bilibili.com/')
    expect(headers.Cookie).toContain('buvid3=BUVID3')
  })

  it('caps at the limit and skips a row with no bvid or title', async () => {
    const { web } = fakeWeb(() => ({ code: 0, data: { result: [{ ...ROW, bvid: '' }, { ...ROW, title: ' ' }, ROW, { ...ROW, bvid: 'BV2x' }, { ...ROW, bvid: 'BV3x' }] } }))
    expect((await web.search('q', 2)).map((c) => c.ref)).toEqual(['https://www.bilibili.com/video/BV1x', 'https://www.bilibili.com/video/BV2x'])
  })

  it('throws on risk control and on a non-zero code, so the caller can fall back', async () => {
    await expect(fakeWeb(() => '<!DOCTYPE html>').web.search('q', 5)).rejects.toThrow(/412/)
    await expect(fakeWeb(() => ({ code: -412, message: 'blocked' })).web.search('q', 5)).rejects.toThrow(/-412/)
    // An empty page is an answer, not a failure: nothing to fall back for.
    expect(await fakeWeb(() => ({ code: 0, data: {} })).web.search('q', 5)).toEqual([])
  })
})

describe('BilibiliWeb.playUrl', () => {
  const answers = (url: string): unknown => {
    if (url.includes('/x/player/pagelist')) return { code: 0, data: [{ cid: 123, page: 1, duration: 281 }, { cid: 124, page: 2, duration: 90 }] }
    if (url.includes('/x/player/playurl')) {
      return { code: 0, data: { dash: { audio: [
        { id: 30216, bandwidth: 65_724, baseUrl: 'https://cdn/a64' },
        { id: 30280, bandwidth: 209_114, baseUrl: 'https://cdn/a192' },
        { id: 30232, bandwidth: 108_981, baseUrl: 'https://cdn/a132' },
      ] } } }
    }
    return { code: -404 }
  }

  it('reads the first part through pagelist and hands back the best audio tier with the headers the CDN wants', async () => {
    const { web, calls } = fakeWeb(answers)
    const clip = await web.playUrl('https://www.bilibili.com/video/BV1x/?p=1')
    expect(clip).toEqual({ source: 'https://cdn/a192', durationS: 281, headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': expect.stringContaining('Mozilla/5.0') } })
    expect(calls.find((c) => c.url.includes('/x/player/pagelist'))?.url).toContain('bvid=BV1x')
    const play = calls.find((c) => c.url.includes('/x/player/playurl'))?.url ?? ''
    expect(play).toContain('cid=123')
    expect(play).toContain('fnval=16')
  })

  // yt-dlp's Bilibili extractor honours `?p=N`; so must this, or a second
  // part plays as the first and the probe cannot tell (codex review).
  it('plays the part a ?p= ref names, and leaves a part the list lacks to yt-dlp', async () => {
    const { web, calls } = fakeWeb(answers)
    expect(await web.playUrl('https://www.bilibili.com/video/BV1x?p=2')).toMatchObject({ durationS: 90 })
    expect(calls.find((c) => c.url.includes('/x/player/playurl'))?.url).toContain('cid=124')
    await expect(web.playUrl('https://www.bilibili.com/video/BV1x?p=3')).rejects.toThrow(/part 3/)
    expect(await web.playUrl('https://www.bilibili.com/video/BV1x')).toMatchObject({ durationS: 281 })
  })

  it('refuses a ref it cannot read a bvid from without touching the network', async () => {
    const { web, calls } = fakeWeb(answers)
    for (const ref of ['https://www.bilibili.com/video/av1', 'https://b23.tv/abc', 'https://music.163.com/#/song?id=5']) {
      await expect(web.playUrl(ref)).rejects.toThrow(/bvid/)
    }
    expect(calls).toEqual([])
  })

  it('throws when the answer carries no audio or a non-zero code', async () => {
    await expect(fakeWeb((url) => (url.includes('pagelist') ? answers(url) : { code: 0, data: { dash: { audio: [] } } })).web.playUrl('https://www.bilibili.com/video/BV1x')).rejects.toThrow(/no audio/)
    await expect(fakeWeb((url) => (url.includes('pagelist') ? { code: -400, data: null } : answers(url))).web.playUrl('https://www.bilibili.com/video/BV1x')).rejects.toThrow(/-400/)
  })
})
