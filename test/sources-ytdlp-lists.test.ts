// The two yt-dlp-read sources (spec 14 §2.8): YouTube's own lists through the
// :ytfav / :ythistory / :ytsubs keywords, and Bilibili through its identity
// client plus the list APIs — shapes captured from real runs, values kept.
import { describe, expect, it } from 'vitest'

import { BrowserCookieError } from '../src/music/sources/cookies.ts'

import { BilibiliClient, BilibiliSource, mountBilibili, type BilibiliFetch } from '../src/music/sources/bilibili.ts'
import { flatEntries } from '../src/music/sources/flat.ts'
import { mountYouTube, YouTubeSource } from '../src/music/sources/youtube.ts'
import type { YtDlpRunner } from '../src/music/music.ts'

const line = (o: Record<string, unknown>): string => JSON.stringify(o)

// One `--dump-json --flat-playlist` line per entry, as yt-dlp prints them for
// :ytfav (title + uploader), :ythistory (title, no uploader) and :ytsubs (a
// channel row: title = the channel).
const FAV = [
  line({ title: 'Deep Bass Lo-Fi Jazz', uploader: 'Midnight Haven Jazz', channel: 'Midnight Haven Jazz', duration: 3669, url: 'https://www.youtube.com/watch?v=0wysL8y88HE', id: '0wysL8y88HE', timestamp: null }),
  line({ title: 'Holocene', uploader: 'Bon Iver', duration: 344, url: 'https://www.youtube.com/watch?v=TWcyIpul8OE', id: 'TWcyIpul8OE' }),
  'WARNING: something yt-dlp said',
].join('\n')
const HISTORY = [line({ title: 'Bon Iver - Holocene - Official Video', uploader: null, channel: null, duration: 344, url: 'https://www.youtube.com/watch?v=TWcyIpul8OE' })].join('\n')
const SUBS = [line({ title: 'Sally Jo', uploader: 'Sally Jo', channel: 'Sally Jo', duration: null, url: 'https://www.youtube.com/channel/UCB', id: 'UCB', ie_key: 'YoutubeTab' })].join('\n')

function ytdlp(answers: Record<string, string>) {
  const calls: string[][] = []
  const released: string[] = []
  const run: YtDlpRunner = async (args) => {
    calls.push(args)
    const target = args.at(-1)!
    if (target in answers) return answers[target]!
    throw Object.assign(new Error('Command failed'), { stderr: `ERROR: unknown ${target}` })
  }
  // The jar seam: one leased file per call, released after.
  const lease = async (pick: { browser: string; profile?: string | undefined }) => {
    const path = `/jar/${pick.browser}${pick.profile === undefined ? '' : `:${pick.profile}`}`
    return { path, args: ['--cookies', path], release: () => void released.push(path) }
  }
  return { run, calls, released, deps: { run, lease } }
}

describe('flatEntries', () => {
  it('reads a flat list with the cookie flag and the bound, skipping chatter', async () => {
    const { run, calls } = ytdlp({ ':ytfav': FAV })
    const entries = await flatEntries(run, ':ytfav', ['--cookies-from-browser', 'chrome'], 500)
    expect(calls[0]).toEqual(['--dump-json', '--flat-playlist', '--playlist-end', '500', '--no-warnings', '--cookies-from-browser', 'chrome', ':ytfav'])
    expect(entries).toEqual([
      { title: 'Deep Bass Lo-Fi Jazz', uploader: 'Midnight Haven Jazz', durationS: 3669, url: 'https://www.youtube.com/watch?v=0wysL8y88HE' },
      { title: 'Holocene', uploader: 'Bon Iver', durationS: 344, url: 'https://www.youtube.com/watch?v=TWcyIpul8OE' },
    ])
  })
})

describe('YouTube (spec 14 §2.8)', () => {
  const PLAYLIST = line({ id: 'LL', title: 'Liked videos', uploader: 'Zach G', channel: 'Zach G', playlist_count: 3, entries: [] })

  it('mounting reads who from the liked-videos playlist; no login is the typed reason', async () => {
    const { deps, calls, released } = ytdlp({ ':ytfav': PLAYLIST })
    expect(await mountYouTube({ browser: 'chrome', profile: 'Default' }, deps)).toEqual({
      ok: true,
      who: 'Zach G',
      entry: { browser: 'chrome', profile: 'Default' },
    })
    expect(calls[0]).toEqual(['--dump-single-json', '--flat-playlist', '--playlist-items', '0', '--no-warnings', '--cookies', '/jar/chrome:Default', ':ytfav'])
    expect(released).toEqual(['/jar/chrome:Default'])
    const anon = ytdlp({})
    expect(await mountYouTube({ browser: 'firefox' }, anon.deps)).toEqual({ ok: false, reason: 'login-required' })
    expect(anon.released).toHaveLength(1)
  })

  it('snapshots liked, history and subscriptions within the bounds', async () => {
    const { deps, calls, released } = ytdlp({ ':ytfav': FAV, ':ythistory': HISTORY, ':ytsubs': SUBS })
    const source = new YouTubeSource({ browser: 'chrome' }, { ...deps, now: () => new Date('2026-09-06T10:00:00Z') })
    const snapshot = await source.snapshot()
    expect(snapshot).toEqual({
      source: 'youtube',
      takenAt: '2026-09-06T10:00:00.000Z',
      items: [
        { kind: 'liked', title: 'Deep Bass Lo-Fi Jazz', artist: 'Midnight Haven Jazz', ref: 'https://www.youtube.com/watch?v=0wysL8y88HE' },
        { kind: 'liked', title: 'Holocene', artist: 'Bon Iver', ref: 'https://www.youtube.com/watch?v=TWcyIpul8OE' },
        { kind: 'history', title: 'Bon Iver - Holocene - Official Video', ref: 'https://www.youtube.com/watch?v=TWcyIpul8OE' },
        { kind: 'subscription', title: 'Sally Jo' },
      ],
    })
    const ends = calls.map((c) => [c[c.indexOf('--playlist-end') + 1], c.at(-1)])
    expect(ends).toEqual([
      ['500', ':ytfav'],
      ['200', ':ythistory'],
      ['100', ':ytsubs'],
    ])
    expect(released).toHaveLength(3)
  })

  it('a cookie that no longer logs in throws the typed failure from the snapshot', async () => {
    const run: YtDlpRunner = async () => {
      throw Object.assign(new Error('x'), { stderr: 'ERROR: [youtube:tab] :ytfav: This video is only available for registered users.' })
    }
    const deps = { run, lease: ytdlp({}).deps.lease }
    await expect(new YouTubeSource({ browser: 'chrome' }, deps).snapshot()).rejects.toMatchObject({ source: 'youtube', reason: 'login-required' })
    expect(await new YouTubeSource({ browser: 'chrome' }, deps).verify()).toEqual({ ok: false, reason: 'login-required' })
  })
})

type Call = { url: string; headers: Record<string, string> }

function biliFetch(answers: Record<string, unknown>, status = 200): { fetch: BilibiliFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: BilibiliFetch = async (url, init) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    const u = new URL(String(url))
    const hit = Object.entries(answers).find(([key]) => u.pathname.endsWith(key))
    return new Response(JSON.stringify(hit === undefined ? { code: -404 } : hit[1]), { status })
  }
  return { fetch, calls }
}

// Captured from the real API (2026-09-06), values kept, ids shortened.
const NAV = { code: 0, data: { isLogin: true, uname: 'FAWineLL', mid: 4486056 } }
const FOLDERS = { code: 0, data: { list: [{ id: 66275456, title: 'default folder', media_count: 287 }, { id: 3387798356, title: 'japan', media_count: 1 }, { id: 946277156, title: 'algorithms', media_count: 0 }] } }
// The third row is a video the platform has since taken down (attr bit 1):
// its title is the platform's placeholder, not the listener's taste.
const FAVLIST = { code: 0, data: { medias: [{ title: 'A whole series in one go', upper: { name: 'Fries Says Film' }, duration: 18488, bvid: 'BV1c94y1q7br', fav_time: 1786337563, attr: 0 }, { title: 'A beginner guide', upper: { name: 'Takumi' }, duration: 1405, bvid: 'BV1MubUzkEfp', fav_time: 1785600894 }, { title: 'video no longer available', upper: { name: 'account deleted' }, bvid: 'BV1gone', fav_time: 1785000000, attr: 9 }], has_more: false } }
const WATCHLATER = { code: 0, data: { count: 1, list: [{ title: 'Later', owner: { name: 'Someone' }, duration: 300, bvid: 'BV1later', add_at: 1786000000 }] } }
const AUDIO = { code: 0, data: { curPage: 1, pageCount: 1, totalSize: 1, pageSize: 30, data: [{ id: 123, title: 'My upload', author: 'FAWineLL', duration: 200 }] } }

describe('Bilibili (spec 14 §2.8)', () => {
  it('the client answers who and the folders with the cookie, and reads as anonymous without one', async () => {
    const { fetch, calls } = biliFetch({ '/x/web-interface/nav': NAV, '/x/v3/fav/folder/created/list-all': FOLDERS })
    const client = new BilibiliClient({ cookie: async () => 'SESSDATA=<redacted>; DedeUserID=4486056', fetch })
    expect(await client.nav()).toEqual({ mid: '4486056', who: 'FAWineLL' })
    expect(calls[0]!.headers.Cookie).toContain('SESSDATA=<redacted>')
    expect(calls[0]!.headers.Referer).toBe('https://www.bilibili.com/')
    expect(await client.folders('4486056')).toEqual([
      { id: '66275456', title: 'default folder', count: 287 },
      { id: '3387798356', title: 'japan', count: 1 },
      { id: '946277156', title: 'algorithms', count: 0 },
    ])
    expect(calls[1]!.url).toContain('up_mid=4486056')
    const anon = new BilibiliClient({ cookie: async () => '', fetch: biliFetch({ '/x/web-interface/nav': { code: 0, data: { isLogin: false } } }).fetch })
    expect(await anon.nav()).toBeNull()
  })

  it('mounting stores the browser and the mid', async () => {
    const { fetch } = biliFetch({ '/x/web-interface/nav': NAV })
    expect(await mountBilibili({ browser: 'chrome' }, { cookie: async () => 'x', fetch })).toEqual({ ok: true, who: 'FAWineLL', entry: { browser: 'chrome', mid: '4486056' } })
    const { fetch: out } = biliFetch({ '/x/web-interface/nav': { code: -101, message: 'not logged in' } })
    expect(await mountBilibili({ browser: 'chrome' }, { cookie: async () => '', fetch: out })).toEqual({ ok: false, reason: 'login-required' })
  })

  it('snapshots the folder names, the favourites (newest first, dated), watch later and space audio', async () => {
    const { fetch, calls } = biliFetch({
      '/x/web-interface/nav': NAV,
      '/x/v3/fav/folder/created/list-all': FOLDERS,
      '/x/v3/fav/resource/list': FAVLIST,
      '/x/v2/history/toview/web': WATCHLATER,
      '/audio/music-service/web/song/upper': AUDIO,
    })
    const source = new BilibiliSource({ browser: 'chrome', mid: '4486056' }, { cookie: async () => 'x', fetch, now: () => new Date('2026-09-06T10:00:00Z') })
    expect(await source.verify()).toEqual({ ok: true, who: 'FAWineLL' })
    const snapshot = await source.snapshot()
    expect(snapshot.source).toBe('bilibili')
    expect(snapshot.items).toEqual([
      { kind: 'playlist', title: 'default folder' },
      { kind: 'playlist', title: 'japan' },
      { kind: 'playlist', title: 'algorithms' },
      { kind: 'favourite', title: 'A whole series in one go', artist: 'Fries Says Film', at: '2026-08-10T04:52:43.000Z', ref: 'https://www.bilibili.com/video/BV1c94y1q7br' },
      { kind: 'favourite', title: 'A beginner guide', artist: 'Takumi', at: '2026-08-01T16:14:54.000Z', ref: 'https://www.bilibili.com/video/BV1MubUzkEfp' },
      { kind: 'favourite', title: 'A whole series in one go', artist: 'Fries Says Film', at: '2026-08-10T04:52:43.000Z', ref: 'https://www.bilibili.com/video/BV1c94y1q7br' },
      { kind: 'favourite', title: 'A beginner guide', artist: 'Takumi', at: '2026-08-01T16:14:54.000Z', ref: 'https://www.bilibili.com/video/BV1MubUzkEfp' },
      { kind: 'favourite', title: 'Later', artist: 'Someone', at: '2026-08-06T07:06:40.000Z', ref: 'https://www.bilibili.com/video/BV1later' },
      { kind: 'liked', title: 'My upload', artist: 'FAWineLL', ref: 'https://www.bilibili.com/audio/au123' },
    ])
    // An empty folder is not read; the two with contents are, one page each.
    expect(calls.filter((c) => c.url.includes('/x/v3/fav/resource/list'))).toHaveLength(2)
  })

  it('a 429 is rate limiting; a -101 mid-read is the login gone', async () => {
    const busy = new BilibiliClient({ cookie: async () => 'x', fetch: biliFetch({}, 429).fetch })
    await expect(busy.nav()).rejects.toMatchObject({ source: 'bilibili', reason: 'rate-limited' })
    const gone = new BilibiliClient({ cookie: async () => 'x', fetch: biliFetch({ '/x/v3/fav/folder/created/list-all': { code: -101, message: '<not logged in>' } }).fetch })
    await expect(gone.folders('1')).rejects.toMatchObject({ source: 'bilibili', reason: 'login-required' })
  })
})

describe('a cookie store that cannot be read is not a missing login', () => {
  // who() classifies yt-dlp auth failures and answers null (login-required)
  // for anything else. A BrowserCookieError is not an auth answer at all —
  // swallowed, it sent a listener with no yt-dlp to a Google sign-in page.
  it('mountYouTube lets a BrowserCookieError through', async () => {
    await expect(
      mountYouTube(
        { browser: 'chrome' },
        {
          run: async () => '',
          lease: async () => {
            throw new BrowserCookieError('chrome', 'no-ytdlp', 'spawn yt-dlp ENOENT')
          },
        },
      ),
    ).rejects.toBeInstanceOf(BrowserCookieError)
  })
})
