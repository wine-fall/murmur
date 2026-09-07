// Taste reaches the pick (spec 14 §2.4-§2.6, §3.3): named-catalogue search,
// the cookie-aware resolve, the typed auth result that ends a catalogue for
// the task, the preview trap, and the prompt halves that carry the digest.
import { describe, expect, it } from 'vitest'

import type { ContextPack, TrackCandidate } from '../src/contracts.ts'
import { musicTools } from '../src/music/music-tools.ts'
import { YtDlpMusicProvider } from '../src/music/music.ts'
import { SourceAuthError } from '../src/music/sources/auth.ts'
import type { CookieLease } from '../src/music/sources/cookies.ts'
import type { CookieSource } from '../src/music/sources/store.ts'
import { buildFindMusicInstruction, buildMusicSituation, TASTE_GUIDANCE } from '../src/prompts/music.ts'
import { buildRespondPrompt, buildSteerPrompt } from '../src/prompts/reply.ts'
import { buildNextTalkPrompt, buildNextTalksPrompt, tasteBlock } from '../src/prompts/talk.ts'
import { callTool, FakeMusicProvider } from './fakes.ts'

// A cookie seam with bilibili and netease mounted: a jar lease per call,
// released after, and null for an unmounted host.
function jars(mounted: CookieSource[] = ['bilibili', 'netease']) {
  const released: string[] = []
  const cookies = async (source: CookieSource): Promise<CookieLease | null> =>
    mounted.includes(source) ? { path: `/jar/${source}`, args: ['--cookies', `/jar/${source}`], release: () => void released.push(source) } : null
  return { cookies, released }
}

const hit = JSON.stringify({ title: 'Song', webpage_url: 'https://www.bilibili.com/video/BV1', uploader: 'up', duration: 200 })

describe('YtDlpMusicProvider with mounted sources', () => {
  it('searches bilibili through bilisearch with the leased jar, youtube exactly as before', async () => {
    const calls: string[][] = []
    const { cookies, released } = jars()
    const provider = new YtDlpMusicProvider({ run: async (args) => (calls.push(args), hit), cookies })
    const found = await provider.search('city pop', 5, 'bilibili')
    expect(calls[0]).toEqual(['--dump-json', '--flat-playlist', '--cookies', '/jar/bilibili', 'bilisearch5:city pop'])
    expect(released).toEqual(['bilibili'])
    expect(found[0]).toMatchObject({ catalogue: 'bilibili', ref: 'https://www.bilibili.com/video/BV1' })
    await provider.search('city pop', 5)
    expect(calls[1]).toEqual(['--dump-json', '--flat-playlist', 'ytsearch5:city pop'])
    await provider.search('city pop', 5, 'youtube')
    expect(calls[2]).toEqual(calls[1])
    expect(released).toEqual(['bilibili']) // youtube search never touches the jar
  })

  it('bilibili search runs without a cookie when bilibili is not mounted', async () => {
    const calls: string[][] = []
    const provider = new YtDlpMusicProvider({ run: async (args) => (calls.push(args), hit), cookies: jars([]).cookies })
    await provider.search('x', 3, 'bilibili')
    expect(calls[0]).toEqual(['--dump-json', '--flat-playlist', 'bilisearch3:x'])
  })

  it('netease search goes through the client, and is refused when no client is wired', async () => {
    const searches: [string, number][] = []
    const netease = {
      search: async (query: string, limit: number): Promise<TrackCandidate[]> => {
        searches.push([query, limit])
        return [{ ref: 'https://music.163.com/#/song?id=5', title: 't', uploader: 'a', durationS: 200, extra: {}, catalogue: 'netease' }]
      },
    }
    const provider = new YtDlpMusicProvider({ run: async () => '', cookies: jars().cookies, netease })
    expect((await provider.search('q', 4, 'netease'))[0]?.ref).toBe('https://music.163.com/#/song?id=5')
    expect(searches).toEqual([['q', 4]])
    const bare = new YtDlpMusicProvider({ run: async () => '', cookies: jars().cookies })
    await expect(bare.search('q', 4, 'netease')).rejects.toThrow(/not mounted/)
  })

  it('resolves with the leased jar for a mounted host and without one otherwise (spec 14 §5.1)', async () => {
    const calls: string[][] = []
    const { cookies, released } = jars()
    const provider = new YtDlpMusicProvider({ run: async (args) => (calls.push(args), '183\nhttps://s\n'), cookies })
    await provider.resolve('https://music.163.com/#/song?id=5')
    expect(calls[0]).toEqual(['-f', 'bestaudio/best', '--print', '%(duration)s', '--print', 'urls', '--cookies', '/jar/netease', 'https://music.163.com/#/song?id=5'])
    expect(released).toEqual(['netease'])
    await provider.resolve('https://youtube.com/watch?v=a')
    expect(calls[1]).toEqual(['-f', 'bestaudio/best', '--print', '%(duration)s', '--print', 'urls', 'https://youtube.com/watch?v=a'])
    // No cookie seam at all = the pre-spec-14 provider, byte for byte.
    const plain = new YtDlpMusicProvider({ run: async (args) => (calls.push(args), '183\nhttps://s\n') })
    await plain.resolve('https://music.163.com/#/song?id=5')
    expect(calls[2]).toEqual(['-f', 'bestaudio/best', '--print', '%(duration)s', '--print', 'urls', 'https://music.163.com/#/song?id=5'])
  })

  it('turns an auth-shaped yt-dlp failure into a SourceAuthError, and leaves other failures alone', async () => {
    const failing = (stderr: string) =>
      new YtDlpMusicProvider({
        run: async () => {
          throw Object.assign(new Error('Command failed: yt-dlp'), { stderr })
        },
        cookies: jars().cookies,
      })
    const expired = failing('ERROR: [netease:song] 5: Login required to download: <redacted>')
    await expect(expired.resolve('https://music.163.com/#/song?id=5')).rejects.toBeInstanceOf(SourceAuthError)
    await expect(expired.resolve('https://music.163.com/#/song?id=5')).rejects.toMatchObject({ source: 'netease', reason: 'login-required' })
    // A bilibili search that hits the auth wall names bilibili, whatever the query.
    await expect(expired.search('x', 3, 'bilibili')).rejects.toMatchObject({ source: 'bilibili' })
    const dead = failing('ERROR: [youtube] a: Video unavailable')
    await expect(dead.resolve('https://youtube.com/watch?v=a')).rejects.not.toBeInstanceOf(SourceAuthError)
    // Auth text for a host with no mount stays a plain error: nothing to renew.
    const nomount = new YtDlpMusicProvider({
      run: async () => {
        throw Object.assign(new Error('x'), { stderr: 'Login required' })
      },
      cookies: jars([]).cookies,
    })
    await expect(nomount.resolve('https://music.163.com/#/song?id=5')).rejects.not.toBeInstanceOf(SourceAuthError)
    // The jar is released on failure too.
    const { cookies, released } = jars()
    const broken = new YtDlpMusicProvider({
      run: async () => {
        throw new Error('boom')
      },
      cookies,
    })
    await expect(broken.resolve('https://music.163.com/#/song?id=5')).rejects.toThrow('boom')
    expect(released).toEqual(['netease'])
  })
})

describe('the music tools with taste (spec 14 §2.4/§2.6)', () => {
  function build(opts: { mounted?: ('bilibili' | 'netease')[]; probeDurationS?: (s: string) => Promise<number | null> } = {}) {
    const provider = new FakeMusicProvider()
    provider.candidates = [{ ref: 'https://music.163.com/#/song?id=5', title: 'Song', uploader: 'Artist', durationS: 240, extra: {} }]
    const auth: SourceAuthError[] = []
    const picks: unknown[] = []
    const tools = musicTools(provider, (pick) => picks.push(pick), undefined, undefined, {
      catalogues: () => opts.mounted ?? [],
      onAuthFailure: (err) => auth.push(err),
      ...(opts.probeDurationS !== undefined && { probeDurationS: opts.probeDurationS }),
    })
    return { provider, tools, auth, picks }
  }

  it('lists only youtube when nothing is mounted, and the mounted catalogues otherwise', () => {
    expect(build().tools.find((t) => t.name === 'search_music')!.description).toMatch(/available now: youtube\b(?!, )/)
    const desc = build({ mounted: ['bilibili', 'netease'] }).tools.find((t) => t.name === 'search_music')!.description
    expect(desc).toContain('available now: youtube, bilibili, netease')
  })

  it('passes the catalogue to the provider, and answers not-mounted for one it cannot have', async () => {
    const { provider, tools } = build({ mounted: ['netease'] })
    await callTool(tools, 'search_music', { query: 'q', catalogue: 'netease' })
    expect(provider.searches.at(-1)).toEqual({ query: 'q', limit: undefined, catalogue: 'netease' })
    const refused = await callTool(tools, 'search_music', { query: 'q', catalogue: 'bilibili' })
    expect(refused).toEqual({ ok: false, reason: 'not-mounted', mounted: ['youtube', 'netease'] })
    await callTool(tools, 'search_music', { query: 'q' })
    expect(provider.searches.at(-1)).toEqual({ query: 'q', limit: undefined, catalogue: undefined })
  })

  it('an auth failure on submit returns reason auth, reports once, and closes that catalogue for the task', async () => {
    const { provider, tools, auth } = build({ mounted: ['netease'] })
    provider.failWith = new SourceAuthError('netease', 'expired', '<redacted>')
    const result = await callTool(tools, 'submit_pick', { ref: 'https://music.163.com/#/song?id=5', why: 'w' })
    expect(result).toMatchObject({ ok: false, reason: 'auth', source: 'netease', detail: 'expired' })
    expect(String(result.note)).toMatch(/unavailable for the rest of this task/)
    expect(auth).toHaveLength(1)
    const again = await callTool(tools, 'search_music', { query: 'q', catalogue: 'netease' })
    expect(again).toEqual({ ok: false, reason: 'unavailable', mounted: ['youtube'] })
    expect(provider.searches).toHaveLength(0)
  })

  it('a closed youtube is closed for the default search too, and a geo block closes nothing', async () => {
    const { provider, tools } = build({ mounted: ['netease'] })
    provider.candidates = [{ ref: 'https://youtube.com/watch?v=a', title: 'S', uploader: 'U', durationS: 240, extra: {} }]
    provider.failWith = new SourceAuthError('youtube', 'expired', '<redacted>')
    await callTool(tools, 'submit_pick', { ref: 'https://youtube.com/watch?v=a', why: 'w' })
    expect(await callTool(tools, 'search_music', { query: 'q' })).toEqual({ ok: false, reason: 'unavailable', mounted: ['netease'] })
    expect(await callTool(tools, 'search_music', { query: 'q', catalogue: 'youtube' })).toEqual({ ok: false, reason: 'unavailable', mounted: ['netease'] })
    // A rights-less track is that track's problem, not the catalogue's.
    const geo = build({ mounted: ['netease'] })
    geo.provider.failWith = new SourceAuthError('netease', 'geo', '<redacted>')
    const result = await callTool(geo.tools, 'submit_pick', { ref: 'https://music.163.com/#/song?id=5', why: 'w' })
    expect(result).toMatchObject({ ok: false, reason: 'auth', source: 'netease', detail: 'geo' })
    expect(String(result.note)).toMatch(/pick another/)
    expect(geo.auth).toHaveLength(1)
    geo.provider.failWith = null
    await callTool(geo.tools, 'search_music', { query: 'q', catalogue: 'netease' })
    expect(geo.provider.searches).toHaveLength(1)
  })

  it('a plain resolve failure is still just "pick another"', async () => {
    const { provider, tools, auth } = build({ mounted: ['netease'] })
    provider.broken.add('https://music.163.com/#/song?id=5')
    const result = await callTool(tools, 'submit_pick', { ref: 'https://music.163.com/#/song?id=5', why: 'w' })
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('reason')
    expect(auth).toHaveLength(0)
  })

  it('the preview trap: a 30 s netease clip against a 240 s candidate is login-required; 235 s plays (spec 14 §5.6)', async () => {
    const probes: string[] = []
    const short = build({ mounted: ['netease'], probeDurationS: async (s) => (probes.push(s), 30) })
    await callTool(short.tools, 'search_music', { query: 'q', catalogue: 'netease' })
    const trapped = await callTool(short.tools, 'submit_pick', { ref: 'https://music.163.com/#/song?id=5', why: 'w' })
    expect(trapped).toMatchObject({ ok: false, reason: 'auth', source: 'netease', detail: 'login-required' })
    expect(short.auth[0]).toMatchObject({ reason: 'login-required' })
    expect(probes).toEqual(['https://stream/https://music.163.com/#/song?id=5'])
    expect(short.picks).toHaveLength(0)

    const full = build({ mounted: ['netease'], probeDurationS: async () => 235 })
    await callTool(full.tools, 'search_music', { query: 'q', catalogue: 'netease' })
    const played = await callTool(full.tools, 'submit_pick', { ref: 'https://music.163.com/#/song?id=5', why: 'w' })
    expect(played.ok).toBe(true)
    expect(full.picks).toHaveLength(1)
  })

  it('never probes a non-netease ref for the trap', async () => {
    const probes: string[] = []
    const { provider, tools, picks } = build({ probeDurationS: async (s) => (probes.push(s), 30) })
    provider.candidates = [{ ref: 'https://youtube.com/watch?v=a', title: 'S', uploader: 'U', durationS: 240, extra: {} }]
    await callTool(tools, 'search_music', { query: 'q' })
    await callTool(tools, 'submit_pick', { ref: 'https://youtube.com/watch?v=a', why: 'w' })
    expect(probes).toEqual([])
    expect(picks).toHaveLength(1)
  })

  it('without taste options the tools are exactly their pre-spec-14 selves', async () => {
    const provider = new FakeMusicProvider()
    const tools = musicTools(provider, () => {})
    expect(tools.map((t) => t.name)).toEqual(['search_music', 'submit_pick'])
    expect(tools[0]!.description).not.toContain('available now')
  })
})

const DIGEST = '## What the listener keeps (as of 2026-09-06)\nSources: NetEase (3 liked)'

describe('the digest in the prompts (spec 14 §2.3/§3.3)', () => {
  it('rides the music situation under its own heading with the one added instruction', () => {
    const s = buildMusicSituation([], [], DIGEST)
    expect(s).toContain(DIGEST)
    expect(s).toMatch(/strong prior, not a playlist to replay/)
    expect(buildMusicSituation([], [])).not.toContain('What the listener keeps')
    expect(buildMusicSituation([], [], '')).toBe(buildMusicSituation([], []))
  })

  it('adds the taste paragraph to the instruction only when a digest is present', () => {
    expect(buildFindMusicInstruction(undefined, { taste: true })).toContain(TASTE_GUIDANCE)
    expect(buildFindMusicInstruction(undefined, { taste: false })).not.toContain(TASTE_GUIDANCE)
    expect(buildFindMusicInstruction()).not.toContain(TASTE_GUIDANCE)
    expect(TASTE_GUIDANCE).toMatch(/not two in a row/)
    expect(TASTE_GUIDANCE).toMatch(/NetEase or Bilibili/)
    expect(TASTE_GUIDANCE).toMatch(/one you've kept/)
  })

  it('renders after the profile and before the transcript in the talk and reply prompts, as background', () => {
    const ctx: ContextPack = { persona: 'p', recent: [{ role: 'radio', text: 'hello there' }], profile: 'likes jazz', taste: DIGEST }
    for (const p of [
      buildNextTalkPrompt(ctx),
      buildNextTalksPrompt(ctx, 2),
      buildRespondPrompt('hi', ctx),
      buildSteerPrompt('hi', ctx, { musicWired: true, shutdownArmed: false, settingsWired: false, memoryWired: false }),
    ]) {
      expect(p).toContain(DIGEST)
      expect(p.indexOf('likes jazz')).toBeLessThan(p.indexOf(DIGEST))
      expect(p.indexOf(DIGEST)).toBeLessThan(p.indexOf('hello there'))
      expect(p).toMatch(/when the moment earns it/)
    }
    expect(tasteBlock({ persona: 'p', recent: [] })).toBe('')
    expect(tasteBlock({ persona: 'p', recent: [], taste: '' })).toBe('')
    expect(buildNextTalksPrompt({ persona: 'p', recent: [] }, 2)).not.toContain('What the listener keeps')
  })
})
