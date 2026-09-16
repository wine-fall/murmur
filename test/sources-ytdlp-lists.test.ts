// The two yt-dlp-read sources (spec 14 §2.8): YouTube's own lists through the
// :ytfav / :ythistory / :ytsubs keywords, and Bilibili through its identity
// client plus the list APIs — shapes captured from real runs, values kept.
import { describe, expect, it } from 'vitest'

import { BrowserCookieError } from '../src/music/sources/cookies.ts'

import { BilibiliClient, BilibiliSource, type BilibiliFetch } from '../src/music/sources/bilibili.ts'
import { flatEntries } from '../src/music/sources/flat.ts'
import { mountYouTube, YouTubeSource } from '../src/music/sources/youtube.ts'
import { YtDlpTimeoutError, type YtDlpRunner } from '../src/music/music.ts'

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

  // The listener's decision (spec 14 §2.3): a liked video is collected, not
  // watched, so it is no longer taste — but :ytfav is still the call that
  // names the account, so mounting and verify keep it.
  it('snapshots history and the subscriptions feed, not the liked list, carrying every ref', async () => {
    const { deps, calls, released } = ytdlp({ ':ytfav': FAV, ':ythistory': HISTORY, ':ytsubs': SUBS })
    const source = new YouTubeSource({ browser: 'chrome' }, { ...deps, now: () => new Date('2026-09-06T10:00:00Z') })
    const snapshot = await source.snapshot()
    expect(snapshot).toEqual({
      source: 'youtube',
      takenAt: '2026-09-06T10:00:00.000Z',
      items: [
        { kind: 'history', title: 'Bon Iver - Holocene - Official Video', ref: 'https://www.youtube.com/watch?v=TWcyIpul8OE' },
        { kind: 'subscription', title: 'Sally Jo', artist: 'Sally Jo', ref: 'https://www.youtube.com/channel/UCB' },
      ],
    })
    const ends = calls.map((c) => [c[c.indexOf('--playlist-end') + 1], c.at(-1)])
    expect(ends).toEqual([
      ['200', ':ythistory'],
      ['100', ':ytsubs'],
    ])
    expect(released).toHaveLength(2)
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

// Captured from the real API (nav/audio 2026-09-06, the watch and follow
// reads 2026-09-16), values kept, ids shortened and Chinese titles replaced
// (committed sources hold no CJK) — except tag_name, which is the category
// under test: MUSIC_ZONE romanises as "guo chan yuan chuang xiang guan"
// (Bilibili's original-music sub-zone), DANCE_ZONE as "jie wu" (street dance).
const MUSIC_ZONE = '\u56fd\u4ea7\u539f\u521b\u76f8\u5173'
const DANCE_ZONE = '\u8857\u821e'
const NAV = { code: 0, data: { isLogin: true, uname: 'FAWineLL', mid: 4486056 } }
const historyRow = (title: string, author: string, bvid: string, viewAt: number, tag: string): Record<string, unknown> => ({
  title,
  uri: `https://www.bilibili.com/video/${bvid}`,
  history: { oid: 117240259156786, bvid, page: 1, business: 'archive', dt: 1 },
  videos: 1,
  author_name: author,
  author_mid: 554434890,
  view_at: viewAt,
  progress: 120,
  duration: 232,
  tag_name: tag,
})
const HISTORY_PAGE_1 = {
  code: 0,
  data: {
    cursor: { max: 117263277491939, view_at: 1789488107, business: 'archive', ps: 30 },
    list: [historyRow('a city pop set', 'Night Tape', 'BV1qYYx6HEYD', 1789488255, MUSIC_ZONE), historyRow('Popping 1vs1 final', 'mklike', 'BV11qYB6TEea', 1789488123, DANCE_ZONE)],
  },
}
const HISTORY_PAGE_2 = { code: 0, data: { cursor: { max: 0, view_at: 0, business: 'archive', ps: 30 }, list: [] } }
const FOLLOWINGS = { code: 0, data: { total: 297, list: [{ mid: 3546624089393431, attribute: 2, mtime: 1789488105, uname: 'Purple Sword' }, { mid: 313310554, attribute: 2, mtime: 1789297816, uname: 'Cat Seven' }] } }
const ATTENTION = { code: 0, data: { total: 297, list: [{ mid: 2137589551, attribute: 2, mtime: 1785426794, uname: 'Midnight Haven Jazz' }] } }
const AUDIO = { code: 0, data: { curPage: 1, pageCount: 1, totalSize: 1, pageSize: 30, data: [{ id: 123, title: 'My upload', author: 'FAWineLL', duration: 200 }] } }

// The favourites reads are gone from the snapshot, so a fetch fake that answers
// by path needs one answer per page of the history cursor.
function biliPages(answers: Record<string, unknown>, pages: Record<string, unknown[]> = {}): { fetch: BilibiliFetch; calls: Call[] } {
  const seen = new Map<string, number>()
  const base = biliFetch(answers)
  const fetch: BilibiliFetch = async (url, init) => {
    const u = new URL(String(url))
    const key = Object.keys(pages).find((k) => u.pathname.endsWith(k))
    if (key !== undefined) {
      const n = seen.get(key) ?? 0
      seen.set(key, n + 1)
      base.calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify(pages[key]![Math.min(n, pages[key]!.length - 1)]), { status: 200 })
    }
    return base.fetch(url, init)
  }
  return { fetch, calls: base.calls }
}

describe('Bilibili (spec 14 §2.8)', () => {
  it('the client answers who with the cookie, and reads as anonymous without one', async () => {
    const { fetch, calls } = biliFetch({ '/x/web-interface/nav': NAV })
    const client = new BilibiliClient({ cookie: async () => 'SESSDATA=<redacted>; DedeUserID=4486056', fetch })
    expect(await client.nav()).toEqual({ mid: '4486056', who: 'FAWineLL' })
    expect(calls[0]!.headers.Cookie).toContain('SESSDATA=<redacted>')
    expect(calls[0]!.headers.Referer).toBe('https://www.bilibili.com/')
    const anon = new BilibiliClient({ cookie: async () => '', fetch: biliFetch({ '/x/web-interface/nav': { code: 0, data: { isLogin: false } } }).fetch })
    expect(await anon.nav()).toBeNull()
  })

  // The listener's decision (spec 14 §2.3): what they watched and who they
  // follow is the taste; what they collected into a folder is not.
  it('snapshots the watch history with its category, the recent follows, the channels revisited — and no favourites', async () => {
    const { fetch, calls } = biliPages(
      { '/x/web-interface/nav': NAV, '/audio/music-service/web/song/upper': AUDIO },
      { '/x/web-interface/history/cursor': [HISTORY_PAGE_1, HISTORY_PAGE_2], '/x/relation/followings': [FOLLOWINGS, ATTENTION] },
    )
    const source = new BilibiliSource({ browser: 'chrome', mid: '4486056' }, { cookie: async () => 'x', fetch, now: () => new Date('2026-09-06T10:00:00Z') })
    expect(await source.verify()).toEqual({ ok: true, who: 'FAWineLL' })
    const snapshot = await source.snapshot()
    expect(snapshot.source).toBe('bilibili')
    expect(snapshot.items).toEqual([
      { kind: 'history', title: 'a city pop set', artist: 'Night Tape', at: '2026-09-15T16:04:15.000Z', category: MUSIC_ZONE, ref: 'https://www.bilibili.com/video/BV1qYYx6HEYD' },
      { kind: 'history', title: 'Popping 1vs1 final', artist: 'mklike', at: '2026-09-15T16:02:03.000Z', category: DANCE_ZONE, ref: 'https://www.bilibili.com/video/BV11qYB6TEea' },
      { kind: 'follows', title: 'Purple Sword', at: '2026-09-15T16:01:45.000Z', ref: 'https://space.bilibili.com/3546624089393431' },
      { kind: 'follows', title: 'Cat Seven', at: '2026-09-13T11:10:16.000Z', ref: 'https://space.bilibili.com/313310554' },
      { kind: 'frequents', title: 'Midnight Haven Jazz', at: '2026-07-30T15:53:14.000Z', ref: 'https://space.bilibili.com/2137589551' },
      { kind: 'liked', title: 'My upload', artist: 'FAWineLL', ref: 'https://www.bilibili.com/audio/au123' },
    ])
    expect(snapshot.items.some((i) => i.kind === 'playlist' || i.kind === 'favourite')).toBe(false)
    // No folder is read at all any more.
    expect(calls.some((c) => c.url.includes('/x/v3/fav/'))).toBe(false)
    // The history is paged by the cursor the last page handed back; the two
    // follow reads differ only by order_type, which is what "revisited" means.
    const history = calls.filter((c) => c.url.includes('/history/cursor'))
    expect(history).toHaveLength(2)
    expect(history[0]!.url).not.toContain('max=')
    expect(history[1]!.url).toContain('max=117263277491939')
    expect(history[1]!.url).toContain('view_at=1789488107')
    const follows = calls.filter((c) => c.url.includes('/x/relation/followings')).map((c) => c.url)
    expect(follows[0]).toContain('vmid=4486056')
    expect(follows[0]).not.toContain('order_type')
    expect(follows[1]).toContain('order_type=attention')
  })

  it('an expired cookie is the typed login failure on every new read', async () => {
    const gone = (path: string): BilibiliClient =>
      new BilibiliClient({ cookie: async () => 'x', fetch: biliFetch({ [path]: { code: -101, message: '<not logged in>' } }).fetch })
    await expect(gone('/x/web-interface/history/cursor').history(10)).rejects.toMatchObject({ source: 'bilibili', reason: 'login-required' })
    await expect(gone('/x/relation/followings').followings('1', 10, 'follows')).rejects.toMatchObject({ source: 'bilibili', reason: 'login-required' })
    await expect(gone('/x/relation/followings').followings('1', 10, 'frequents')).rejects.toMatchObject({ source: 'bilibili', reason: 'login-required' })
    const busy = new BilibiliClient({ cookie: async () => 'x', fetch: biliFetch({}, 429).fetch })
    await expect(busy.history(10)).rejects.toMatchObject({ source: 'bilibili', reason: 'rate-limited' })
    await expect(busy.followings('1', 10, 'follows')).rejects.toMatchObject({ source: 'bilibili', reason: 'rate-limited' })
  })

  // A shape murmur does not recognise is not an auth failure and must not be
  // dressed as one: the read degrades to nothing, and the rest of the snapshot
  // still reaches the digest.
  it('a malformed body reads as no rows, never as a login problem', async () => {
    const junk = { code: 0, data: { list: [{ nothing: 'useful' }, 42], cursor: 'not an object' } }
    const { fetch } = biliPages({ '/x/web-interface/nav': NAV, '/audio/music-service/web/song/upper': AUDIO }, { '/x/web-interface/history/cursor': [junk], '/x/relation/followings': [junk] })
    const source = new BilibiliSource({ browser: 'chrome', mid: '4486056' }, { cookie: async () => 'x', fetch, now: () => new Date('2026-09-06T10:00:00Z') })
    expect((await source.snapshot()).items).toEqual([{ kind: 'liked', title: 'My upload', artist: 'FAWineLL', ref: 'https://www.bilibili.com/audio/au123' }])
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

  // The export can succeed and the account read still hang: a timeout is no
  // more an answer about the login than an unreadable store is, and read as
  // one it sends the listener to a sign-in page that changes nothing.
  it('mountYouTube lets a YtDlpTimeoutError through', async () => {
    await expect(
      mountYouTube(
        { browser: 'chrome' },
        {
          run: () => Promise.reject(new YtDlpTimeoutError(90_000)),
          lease: async () => ({ path: '/jar', args: ['--cookies', '/jar'], release: () => {} }),
        },
      ),
    ).rejects.toBeInstanceOf(YtDlpTimeoutError)
  })
})
