// The wbi request signing beside the Bilibili client (spec 14 §2.9): the
// mixin key the two nav images spell out, the signed query, and the space
// listing that is the only reason this exists — yt-dlp's flat read of a
// Bilibili space returns refs with EMPTY titles, and a pool of untitled
// tracks cannot be searched.
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { BilibiliSpace, mixinKey, signedQuery } from '../src/music/sources/wbi.ts'

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
  return { calls, space: new BilibiliSpace({ fetch: fetcher }) }
}

describe('BilibiliSpace.recent', () => {
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
    const space = new BilibiliSpace({
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
  const space = new BilibiliSpace({
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
  const space = new BilibiliSpace({
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
  const space = new BilibiliSpace({
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
