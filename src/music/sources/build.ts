// The one place the real platform adapters are wired (spec 14 §2.8): a
// stored entry becomes a live TasteSource, and the conversation's mount
// steps get the real clients. The browser cookie is read through yt-dlp's
// jar export and held in memory for a few minutes per browser, so a pick
// that searches NetEase three times spawns yt-dlp once, not three times.

import type { YtDlpRunner } from '../music.ts'
import { BilibiliSource, mountBilibili } from './bilibili.ts'
import { cookieHeader, exportCookieJar, type CookieRow } from './cookies.ts'
import type { BrowserPick, SourceMounts } from './flow.ts'
import { mountNetease, NeteaseClient, NeteaseSource } from './netease.ts'
import { mountQishui, QishuiSource } from './qishui.ts'
import { mountSpotify, SpotifySource } from './spotify.ts'
import type { SourceEntry, SourcesStore } from './store.ts'
import type { SourceId, TasteSource } from './taste.ts'
import { mountYouTube, YouTubeSource } from './youtube.ts'

// How long an exported jar is trusted before yt-dlp is asked again.
export const COOKIE_TTL_MS = 10 * 60_000

const SITES = { bilibili: 'bilibili.com', netease: 'music.163.com' } as const

// The jar cache: one export per browser (and profile) per TTL.
export class CookieJars {
  private jars = new Map<string, { at: number; rows: CookieRow[] }>()
  private run: YtDlpRunner
  private now: () => number

  constructor(run: YtDlpRunner, now: () => number = () => Date.now()) {
    this.run = run
    this.now = now
  }

  // The Cookie header for one site from one browser, exported on demand.
  header(pick: BrowserPick, site: string): () => Promise<string> {
    return async () => cookieHeader(await this.rows(pick), site)
  }

  private async rows(pick: BrowserPick): Promise<CookieRow[]> {
    const key = `${pick.browser}:${pick.profile ?? ''}`
    const cached = this.jars.get(key)
    if (cached !== undefined && this.now() - cached.at < COOKIE_TTL_MS) return cached.rows
    const rows = await exportCookieJar(pick, this.run)
    this.jars.set(key, { at: this.now(), rows })
    return rows
  }

  // A failed login is a reason to read the store again next time.
  drop(): void {
    this.jars.clear()
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
      return new YouTubeSource(e, { run: deps.ytdlp })
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
      // A rotated pair lands in the file through the store — single writer.
      return new SpotifySource(e, { onTokens: (tokens) => deps.store.patch('spotify', tokens) })
    }
    case 'qishui': {
      const e = entry as SourceEntry['qishui']
      return new QishuiSource(e, {})
    }
  }
}

export function defaultMounts(deps: SourceBuildDeps): SourceMounts {
  return {
    youtube: (b) => mountYouTube(b, deps.ytdlp),
    bilibili: (b) => mountBilibili(b, { cookie: deps.jars.header(b, SITES.bilibili) }),
    netease: (b) => mountNetease(b, { cookie: deps.jars.header(b, SITES.netease) }),
    spotify: (clientId, onRedirect) => mountSpotify(clientId, { openUrl: deps.openUrl, onRedirect }),
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
