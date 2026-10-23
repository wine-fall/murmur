// Bilibili's own web API, read anonymously, for the three things yt-dlp
// cannot be relied on for: a channel's recent uploads (spec 14 §2.9), the
// search page (§2.4) and the play url behind a watch ref (§2.5).
//
// Why this exists at all: yt-dlp's flat read of a Bilibili space
// (`--flat-playlist https://space.bilibili.com/<mid>/video`) returns the refs
// but EVERY title is empty, and a pool searched by title is useless without
// them. Its search goes the same way — a flat `bilisearch` entry has no title,
// and the full extraction that would fetch one opens every hit's page, which
// Bilibili's risk control answers 412 to from a plain machine. The site's own
// search page carries the titles, the tags and the zone in one request, and
// `pagelist` + `playurl` hand out an audio stream with no page opened at all.
//
// The space listing refuses an unsigned request, so the wbi signature is the
// price of a titled pool: two image urls in the anonymous `nav` answer spell
// out a 64-char raw key; a fixed permutation of its characters, cut to 32, is
// the mixin key; the query is sorted, stamped with `wts`, and md5'd with the
// mixin appended. Everything here is anonymous — this never touches the
// listener's cookie or the mounted Bilibili account.

import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { TrackCandidate } from '../../contracts.ts'

// The permutation Bilibili's own web player applies to the raw key. Positional
// and fixed; it is data, not logic.
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const API = 'https://api.bilibili.com'
const DEFAULT_TIMEOUT_MS = 15_000
// A browser's own User-Agent and Referer: every one of these APIs answers a
// request that does not look like the web player with its risk-control page.
// The Referer is also what yt-dlp's own `bilisearch` request lacks, and the
// fallback spawn adds it by hand (`BILIBILI_REFERER_ARGS` in music.ts).
export const BILIBILI_REFERER = 'https://www.bilibili.com/'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// Bilibili rotates the wbi keys (daily, in practice). One handshake serves a
// whole pool refresh — which takes seconds — and is dropped well before a
// rotation can make it sign every later request with a dead key.
const SESSION_TTL_MS = 10 * 60_000
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

// What a feed says about an upload beyond its title: the play count, and on
// Bilibili the zone and the uploader's own tags — the only places a video says
// what it is (an AI-made song, say).
// `| undefined` because the pool's cache is read back through zod, whose
// optional fields come out that way.
export type TrackExtra = { viewCount?: number | undefined; zone?: string | undefined; tags?: string[] | undefined }

// One recent upload of a curated channel or tag: what the pool is searched by.
export type ChannelTrack = { ref: string; title: string; uploader: string; durationS: number; extra?: TrackExtra | undefined }

const NavSchema = z.object({ data: z.object({ wbi_img: z.object({ img_url: z.string(), sub_url: z.string() }) }) })
const SpiSchema = z.object({ data: z.object({ b_3: z.string() }) })
const VideoSchema = z.object({ bvid: z.string(), title: z.string(), author: z.string().nullish(), length: z.string().nullish() })
const SpaceSchema = z.object({ code: z.number(), data: z.object({ list: z.object({ vlist: z.array(z.unknown()).nullish() }).nullish() }).nullish() })
// A search row. The side fields fail soft: a drift in how the site spells a
// play count must never cost a titled hit.
const SearchRowSchema = z.object({
  bvid: z.string(),
  title: z.string(),
  author: z.string().nullish().catch(null),
  duration: z.string().nullish().catch(null),
  play: z.number().nullish().catch(null),
  typename: z.string().nullish().catch(null),
  tag: z.string().nullish().catch(null),
})
const SearchSchema = z.object({ code: z.number(), data: z.object({ result: z.array(z.unknown()).nullish() }).nullish() })
const PagelistSchema = z.object({ code: z.number(), data: z.array(z.object({ cid: z.number(), page: z.number(), duration: z.number().nullish() })).nullish() })
const AudioSchema = z.object({ baseUrl: z.string(), bandwidth: z.number().nullish() })
const PlayUrlSchema = z.object({ code: z.number(), data: z.object({ dash: z.object({ audio: z.array(z.unknown()).nullish() }).nullish() }).nullish() })

// The stream the anonymous play url hands out, in the shape the provider
// already builds a clip from.
export type PlayUrl = { source: string; durationS: number; headers: Record<string, string> }

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

export type BilibiliWebDeps = { fetch?: WbiFetch; timeoutMs?: number; now?: () => number }

export class BilibiliWeb {
  private deps: BilibiliWebDeps
  private fetch: WbiFetch
  // The signing material: one nav + one spi read serves every channel in the
  // manifest, and is re-read once it ages past SESSION_TTL_MS.
  private session: Promise<{ mixin: string; cookie: string }> | null = null
  private openedAt = 0

  constructor(deps: BilibiliWebDeps = {}) {
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
      Math.floor(this.now() / 1000),
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

  // One search page, titled (spec 14 §2.4): the fields the pick judges on,
  // plus the tags and the zone. Throws on a refused read so the caller can
  // fall back.
  async search(query: string, limit: number): Promise<TrackCandidate[]> {
    const rows = await this.searchPage({ keyword: query }, limit)
    return rows.map((row) => ({ ...row, extra: row.extra ?? {}, catalogue: 'bilibili' as const }))
  }

  // A tag's newest uploads in the music zone (spec 14 §2.9.1) — the same page,
  // newest first and zone 3 only, which is what kept story videos and
  // tutorials out of the measured feeds. Throws on a refused read: the caller
  // keeps the pool it already had.
  async newest(keyword: string, limit: number): Promise<ChannelTrack[]> {
    return await this.searchPage({ keyword, order: 'pubdate', tids: '3' }, limit)
  }

  private async searchPage(params: Record<string, string>, limit: number): Promise<ChannelTrack[]> {
    const { cookie } = await this.open()
    const query = new URLSearchParams({ search_type: 'video', page: '1', ...params })
    const page = SearchSchema.parse(await this.get(`${API}/x/web-interface/search/type?${query}`, cookie, BILIBILI_REFERER))
    if (page.code !== 0) throw new Error(`bilibili search: code ${page.code}`)
    const found: ChannelTrack[] = []
    for (const raw of page.data?.result ?? []) {
      const row = SearchRowSchema.safeParse(raw)
      if (!row.success || row.data.bvid === '') continue
      // The page marks the matched words up as <em class="keyword">.
      const title = row.data.title.replace(/<[^>]*>/g, '').trim()
      if (title === '') continue
      found.push({
        ref: `https://www.bilibili.com/video/${row.data.bvid}`,
        title,
        uploader: row.data.author?.trim() ?? '',
        durationS: lengthSeconds(row.data.duration),
        extra: {
          ...(row.data.play == null ? {} : { viewCount: row.data.play }),
          zone: row.data.typename ?? '',
          tags: (row.data.tag ?? '').split(',').map((t) => t.trim()).filter((t) => t !== ''),
        },
      })
      if (found.length >= limit) break
    }
    return found
  }

  // The anonymous stream behind a watch ref (spec 14 §2.5): the named part's
  // cid from pagelist (`?p=N`, as yt-dlp reads it; the first part otherwise),
  // then the best dash audio tier from playurl. 192 kbps AAC is the anonymous
  // ceiling; the tiers a login unlocks stay on the yt-dlp road. Throws on
  // anything short of a url, so the caller falls back.
  async playUrl(ref: string): Promise<PlayUrl> {
    const bvid = /\/video\/(BV[0-9A-Za-z]+)/.exec(ref)?.[1]
    if (bvid === undefined) throw new Error(`bilibili play: no bvid in ${ref}`)
    const part = Number(new URL(ref).searchParams.get('p') ?? '1') || 1
    const { cookie } = await this.open()
    const pages = PagelistSchema.parse(await this.get(`${API}/x/player/pagelist?bvid=${bvid}`, cookie, BILIBILI_REFERER))
    if (pages.code !== 0) throw new Error(`bilibili pagelist ${bvid}: code ${pages.code}`)
    const first = pages.data?.find((page) => page.page === part)
    if (first === undefined) throw new Error(`bilibili pagelist ${bvid}: no part ${part}`)
    // fnval=16: the dash answer, which is where the audio-only tiers live.
    const play = PlayUrlSchema.parse(await this.get(`${API}/x/player/playurl?bvid=${bvid}&cid=${first.cid}&fnval=16`, cookie, `${BILIBILI_REFERER}video/${bvid}`))
    if (play.code !== 0) throw new Error(`bilibili playurl ${bvid}: code ${play.code}`)
    let best: z.infer<typeof AudioSchema> | null = null
    for (const raw of play.data?.dash?.audio ?? []) {
      const audio = AudioSchema.safeParse(raw)
      if (audio.success && (best === null || (audio.data.bandwidth ?? 0) > (best.bandwidth ?? 0))) best = audio.data
    }
    if (best === null) throw new Error(`bilibili playurl ${bvid}: no audio`)
    return { source: best.baseUrl, durationS: first.duration ?? 0, headers: { Referer: BILIBILI_REFERER, 'User-Agent': UA } }
  }

  private open(): Promise<{ mixin: string; cookie: string }> {
    if (this.session !== null && this.now() - this.openedAt > SESSION_TTL_MS) this.session = null
    if (this.session !== null) return this.session
    this.openedAt = this.now()
    this.session = (async () => {
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

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async get(url: string, cookie: string, referer: string): Promise<unknown> {
    const controller = new AbortController()
    // The deadline covers the BODY too: headers can land at once and the body
    // then stall forever, which would hang a refresh with no way out.
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': UA, Referer: referer, ...(cookie === '' ? {} : { Cookie: cookie }) },
      })
      // 412 is Bilibili's risk control, and it answers with an HTML page: read
      // as JSON it would surface as a parse error that says nothing.
      if (!response.ok) throw new Error(`bilibili ${new URL(url).pathname}: HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
}
