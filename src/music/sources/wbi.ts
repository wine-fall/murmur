// wbi request signing for Bilibili's web APIs (spec 14 §2.9), and the one
// read that needs it: a channel's recent uploads.
//
// Why this exists at all: yt-dlp's flat read of a Bilibili space
// (`--flat-playlist https://space.bilibili.com/<mid>/video`) returns the refs
// but EVERY title is empty, and a pool searched by title is useless without
// them. Bilibili's own space listing carries the titles, and it refuses an
// unsigned request — so the signature is the price of a titled pool.
//
// The scheme: two image urls in the anonymous `nav` answer spell out a 64-char
// raw key; a fixed permutation of its characters, cut to 32, is the mixin key;
// the query is sorted, stamped with `wts`, and md5'd with the mixin appended.
// Everything here is anonymous — the curated channels are public, so this never
// touches the listener's cookie or the mounted Bilibili account.

import { createHash } from 'node:crypto'

import { z } from 'zod'

// The permutation Bilibili's own web player applies to the raw key. Positional
// and fixed; it is data, not logic.
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const API = 'https://api.bilibili.com'
const DEFAULT_TIMEOUT_MS = 15_000
// A browser's own User-Agent and Referer: the space API answers a request that
// does not look like the web player with its risk-control page.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// The web player's fingerprint fields. Constant, contentless, and required:
// without them the same signed request is answered 412.
const FINGERPRINT: Record<string, string> = {
  platform: 'web',
  web_location: '1550101',
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str:
    'QU5HTEUgKEFwcGxlLCBBTkdMRSBNZXRhbCBSZW5kZXJlcjogQXBwbGUgTTEsIFVuc3BlY2lmaWVkIFZlcnNpb24pR29vZ2xlIEluYy4gKEFwcGxlKQ',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
}

export type WbiFetch = (url: string, init?: RequestInit) => Promise<Response>

// One recent upload of a curated channel: what the pool is searched by.
export type ChannelTrack = { ref: string; title: string; uploader: string; durationS: number }

const NavSchema = z.object({ data: z.object({ wbi_img: z.object({ img_url: z.string(), sub_url: z.string() }) }) })
const SpiSchema = z.object({ data: z.object({ b_3: z.string() }) })
const VideoSchema = z.object({ bvid: z.string(), title: z.string(), author: z.string().nullish(), length: z.string().nullish() })
const SpaceSchema = z.object({ code: z.number(), data: z.object({ list: z.object({ vlist: z.array(z.unknown()).nullish() }).nullish() }).nullish() })

// The stem of `https://i0.hdslb.com/bfs/wbi/<stem>.png`.
function stem(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('.')[0] ?? ''
}

export function mixinKey(imgUrl: string, subUrl: string): string {
  const raw = stem(imgUrl) + stem(subUrl)
  return MIXIN_TABLE.map((i) => raw[i] ?? '').join('').slice(0, 32)
}

// `!'()*` are stripped before hashing — Bilibili's own encoder drops them, and
// a signature over a string the server never sees is a 412.
export function signedQuery(params: Record<string, string>, mixin: string, wtsSeconds: number): string {
  const all: Record<string, string> = { ...params, wts: String(wtsSeconds) }
  const body = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent((all[k] ?? '').replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${body}&w_rid=${createHash('md5').update(`${body}${mixin}`).digest('hex')}`
}

// "02:40" / "1:02:03" -> seconds. Unknown reads as 0, the same "length not
// known" every other candidate uses.
export function lengthSeconds(length: string | null | undefined): number {
  if (length == null) return 0
  const parts = length.split(':').map((p) => Number.parseInt(p, 10))
  if (parts.some((p) => !Number.isFinite(p))) return 0
  return parts.reduce((total, p) => total * 60 + p, 0)
}

export type BilibiliSpaceDeps = { fetch?: WbiFetch; timeoutMs?: number; now?: () => number }

export class BilibiliSpace {
  private deps: BilibiliSpaceDeps
  private fetch: WbiFetch
  // The signing material, good for the process's life: one nav + one spi read
  // serves every channel in the manifest.
  private session: Promise<{ mixin: string; cookie: string }> | null = null

  constructor(deps: BilibiliSpaceDeps = {}) {
    this.deps = deps
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init))
  }

  // A channel's newest uploads, titled. Throws on a failed read: the caller
  // keeps the pool it already had rather than replacing it with nothing.
  async recent(mid: string, limit: number): Promise<ChannelTrack[]> {
    const { mixin, cookie } = await this.open()
    const query = signedQuery(
      { mid, ps: String(Math.min(limit, 50)), pn: '1', order: 'pubdate', ...FINGERPRINT },
      mixin,
      Math.floor((this.deps.now ?? Date.now)() / 1000),
    )
    const json = await this.get(`${API}/x/space/wbi/arc/search?${query}`, cookie, `https://space.bilibili.com/${mid}/video`)
    const page = SpaceSchema.parse(json)
    if (page.code !== 0) throw new Error(`bilibili space ${mid}: code ${page.code}`)
    const tracks: ChannelTrack[] = []
    for (const raw of page.data?.list?.vlist ?? []) {
      const video = VideoSchema.safeParse(raw)
      if (!video.success || video.data.bvid === '' || video.data.title.trim() === '') continue
      tracks.push({
        ref: `https://www.bilibili.com/video/${video.data.bvid}`,
        title: video.data.title.trim(),
        uploader: video.data.author?.trim() ?? '',
        durationS: lengthSeconds(video.data.length),
      })
      if (tracks.length >= limit) break
    }
    return tracks
  }

  private open(): Promise<{ mixin: string; cookie: string }> {
    this.session ??= (async () => {
      // A buvid the site itself issued: a request carrying none is risk-control
      // bait. Anonymous — it identifies a browser, not a person.
      const spi = SpiSchema.parse(await this.get(`${API}/x/frontend/finger/spi`, '', 'https://www.bilibili.com/'))
      const cookie = `buvid3=${spi.data.b_3}`
      const nav = NavSchema.parse(await this.get(`${API}/x/web-interface/nav`, cookie, 'https://www.bilibili.com/'))
      return { mixin: mixinKey(nav.data.wbi_img.img_url, nav.data.wbi_img.sub_url), cookie }
    })().catch((err: unknown) => {
      this.session = null // a failed handshake must not poison the next refresh
      throw err
    })
    return this.session
  }

  private async get(url: string, cookie: string, referer: string): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': UA, Referer: referer, ...(cookie === '' ? {} : { Cookie: cookie }) },
      })
    } finally {
      clearTimeout(timer)
    }
    // 412 is Bilibili's risk control, and it answers with an HTML page: read
    // as JSON it would surface as a parse error that says nothing.
    if (!response.ok) throw new Error(`bilibili ${new URL(url).pathname}: HTTP ${response.status}`)
    return await response.json()
  }
}
