// The one place the real platform adapters are wired (spec 14 §2.8): a
// stored entry becomes a live TasteSource, and the conversation's mount
// steps get the real clients. The browser cookie is read through yt-dlp's
// jar export and held in memory for a few minutes per browser, so a pick
// that searches NetEase three times spawns yt-dlp once, not three times.

import type { YtDlpRunner } from '../music.ts'
import { BilibiliSource, mountBilibili } from './bilibili.ts'
import { cookieHeader, exportCookieJar, siteRows, writeJar, type CookieLease, type CookieRow } from './cookies.ts'
import type { BrowserPick, SourceMounts } from './flow.ts'
import { mountNetease, NeteaseClient, NeteaseSource } from './netease.ts'
import { mountQishui, QishuiSource } from './qishui.ts'
import { mountSpotify, SpotifySource } from './spotify.ts'
import type { SourceEntry, SourcesStore } from './store.ts'
import type { SourceId, TasteSource } from './taste.ts'
import { mountYouTube, YouTubeSource } from './youtube.ts'

// How long an exported jar is trusted before yt-dlp is asked again.
export const COOKIE_TTL_MS = 10 * 60_000

const SITES = { youtube: 'youtube.com', bilibili: 'bilibili.com', netease: 'music.163.com' } as const
type CookieSite = keyof typeof SITES

// The jar cache: one export per browser (and profile) per site per TTL, and
// only that site's rows are kept — the rest of the browser's store is
// dropped the moment the export is read.
export class CookieJars {
  private jars = new Map<string, { at: number; rows: CookieRow[] }>()
  // Exports in flight, per key: a cold YouTube snapshot reads three lists at
  // once, and they must share one browser-store unlock, not spawn three.
  private pending = new Map<string, Promise<CookieRow[]>>()
  private run: YtDlpRunner
  private now: () => number

  constructor(run: YtDlpRunner, now: () => number = () => Date.now()) {
    this.run = run
    this.now = now
  }

  // The Cookie header for one site from one browser, exported on demand.
  header(pick: BrowserPick, site: string): () => Promise<string> {
    return async () => cookieHeader(await this.rows(pick, site), site)
  }

  // A jar file for one yt-dlp call (playback, a list read), released after.
  async lease(pick: BrowserPick, site: string): Promise<CookieLease> {
    return writeJar(await this.rows(pick, site))
  }

  private rows(pick: BrowserPick, site: string): Promise<CookieRow[]> {
    const key = `${pick.browser}:${pick.profile ?? ''}:${site}`
    const cached = this.jars.get(key)
    if (cached !== undefined && this.now() - cached.at < COOKIE_TTL_MS) return Promise.resolve(cached.rows)
    const inflight = this.pending.get(key)
    if (inflight !== undefined) return inflight
    const work = (async () => {
      const rows = siteRows(await exportCookieJar(pick, this.run), site)
      // An export that found nothing for this site is not worth keeping: the
      // listener is being told to sign in, and their retry must reach the
      // browser again rather than this empty answer.
      if (rows.length > 0) this.jars.set(key, { at: this.now(), rows })
      return rows
    })()
    const tracked = work.finally(() => this.pending.delete(key))
    this.pending.set(key, tracked)
    return tracked
  }

  // A failed login is a reason to read the store again next time.
  drop(): void {
    this.jars.clear()
  }
}

// The provider's cookie seam (spec 14 §2.5, as built): a jar lease for a
// mounted cookie source, null when that source is not mounted.
export function cookieLeaser(deps: Pick<SourceBuildDeps, 'jars' | 'store'>): (source: CookieSite) => Promise<CookieLease | null> {
  return async (source) => {
    const entry = deps.store.read()[source]
    return entry === undefined ? null : deps.jars.lease(entry, SITES[source])
  }
}

export type SourceBuildDeps = {
  ytdlp: YtDlpRunner
  jars: CookieJars
  store: SourcesStore
  openUrl: (url: string) => void
}

// A mounted entry as a live adapter. Null only for an entry the file holds
// but this build cannot read — which the schema makes impossible today.
export function buildSource(id: SourceId, entry: SourceEntry[SourceId], deps: SourceBuildDeps): TasteSource | null {
  switch (id) {
    case 'youtube': {
      const e = entry as SourceEntry['youtube']
      return new YouTubeSource(e, { run: deps.ytdlp, lease: (pick) => deps.jars.lease(pick, SITES.youtube) })
    }
    case 'bilibili': {
      const e = entry as SourceEntry['bilibili']
      return new BilibiliSource(e, { cookie: deps.jars.header(e, SITES.bilibili) })
    }
    case 'netease': {
      const e = entry as SourceEntry['netease']
      return new NeteaseSource(e, { cookie: deps.jars.header(e, SITES.netease) })
    }
    case 'spotify': {
      const e = entry as SourceEntry['spotify']
      // A rotated pair lands in the file through the store — single writer —
      // and only while this is still the mount it was rotated for: a token
      // refreshed for the old account must not patch the new one.
      const epoch = deps.store.epoch
      return new SpotifySource(e, {
        onTokens: (tokens) => {
          if (deps.store.epoch === epoch) deps.store.patch('spotify', tokens)
        },
      })
    }
    case 'qishui': {
      const e = entry as SourceEntry['qishui']
      return new QishuiSource(e, {})
    }
  }
}

export function defaultMounts(deps: SourceBuildDeps): SourceMounts {
  return {
    youtube: (b) => mountYouTube(b, { run: deps.ytdlp, lease: (pick) => deps.jars.lease(pick, SITES.youtube) }),
    bilibili: (b) => mountBilibili(b, { cookie: deps.jars.header(b, SITES.bilibili) }),
    netease: (b) => mountNetease(b, { cookie: deps.jars.header(b, SITES.netease) }),
    spotify: (clientId, hooks) => mountSpotify(clientId, { openUrl: deps.openUrl, ...hooks }),
    qishui: (show, cancelled) => mountQishui({}, { show, cancelled }),
  }
}

// The NetEase catalogue for the music provider (spec 14 §2.4): a search that
// reads the mount at call time, so a NetEase mounted mid-session searches
// on the very next pick and an unmounted one is refused.
export function neteaseSearch(deps: SourceBuildDeps): { search: NeteaseClient['search'] } {
  return {
    search: (query, limit) => {
      const entry = deps.store.read().netease
      if (entry === undefined) throw new Error('netease is not mounted')
      return new NeteaseClient({ cookie: deps.jars.header(entry, SITES.netease) }).search(query, limit)
    },
  }
}
