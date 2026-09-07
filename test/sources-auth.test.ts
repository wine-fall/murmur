// Typed auth failure (spec 14 §2.6): one pure classification over captured
// yt-dlp / client text, the preview trap on two durations, and the watch that
// says "expired" on screen exactly once per source per session.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AUTH_LINES, classifyAuthFailure, previewTrap, SourceAuthError, SourceAuthWatch } from '../src/music/sources/auth.ts'
import { SourcesStore } from '../src/music/sources/store.ts'
import { FakeHost } from './fakes.ts'

// Captured shapes, values redacted: yt-dlp's own messages (neteasemusic.py,
// youtube/_base.py, common.py) and the clients' JSON.
const FIXTURES: [string, ReturnType<typeof classifyAuthFailure>][] = [
  ['ERROR: [netease:song] 1: Login required to download: <redacted>. Use --cookies-from-browser or --cookies for the authentication.', 'login-required'],
  ['{"code":-462,"message":"<redacted>"}', 'login-required'],
  ['ERROR: [youtube] x: Sign in to confirm you\'re not a bot. Use --cookies-from-browser or --cookies for the authentication.', 'login-required'],
  ['ERROR: [youtube:tab] :ytfav: This video is only available for registered users. Use --cookies-from-browser', 'login-required'],
  ['WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser as a security measure.', 'expired'],
  ['ERROR: [netease:song] 1: No media links found; possibly due to geo restriction. You might want to use a VPN or a proxy server (with --proxy) to try again', 'geo'],
  ['ERROR: [youtube] x: This video is not available from your location due to geo restriction', 'geo'],
  ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'rate-limited'],
  ['{"error":{"status":429,"message":"rate limited"}}', 'rate-limited'],
  ['ERROR: [youtube] x: Video unavailable', null],
  ['ffmpeg exited with code 1', null],
  ['', null],
]

describe('classifyAuthFailure', () => {
  it.each(FIXTURES)('%s -> %s', (text, expected) => {
    expect(classifyAuthFailure(text)).toBe(expected)
  })
})

describe('previewTrap (yt-dlp issue 14142)', () => {
  it('a 30 s clip against a 240 s candidate is a login problem; 235 s passes', () => {
    expect(previewTrap(240, 30)).toBe(true)
    expect(previewTrap(240, 235)).toBe(false)
  })

  it('never invents a failure from a missing number', () => {
    expect(previewTrap(0, 30)).toBe(false) // the candidate never said
    expect(previewTrap(240, null)).toBe(false) // the probe never answered
    expect(previewTrap(60, 30)).toBe(false) // a short song is a short song
  })
})

describe('SourceAuthWatch', () => {
  function build() {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-auth-'))
    const store = new SourcesStore({ path: join(dir, 'sources.json'), tasteDir: join(dir, 'taste') })
    store.mount('netease', { browser: 'chrome', userId: '1', likedPlaylistId: '2' })
    const host = new FakeHost()
    return { store, host, watch: new SourceAuthWatch({ store, host }) }
  }

  it('says the §3.7 line exactly once per source across three failures, flips the file, logs each', () => {
    const { store, host, watch } = build()
    const err = new SourceAuthError('netease', 'expired', 'cookies are no longer valid')
    watch.note(err)
    watch.note(err)
    watch.note(new SourceAuthError('netease', 'login-required', 'code -462'))
    expect(host.infos).toEqual([AUTH_LINES.expired('NetEase')])
    expect(host.infos[0]).toBe('your NetEase login has expired — /sources to renew; picking from elsewhere for now.')
    expect(store.read().netease?.status).toBe('expired')
    expect(host.debugs.filter((d) => d.startsWith('sources.auth netease'))).toHaveLength(3)
    // Never the detail on screen, never a cookie in the log.
    expect(host.debugs.join('\n')).not.toContain('cookies are no longer valid')
  })

  it('a second source gets its own line, and rate limiting reads as rate limiting', () => {
    const { host, watch } = build()
    watch.note(new SourceAuthError('netease', 'expired', 'x'))
    watch.note(new SourceAuthError('bilibili', 'rate-limited', 'x'))
    expect(host.infos).toHaveLength(2)
    expect(host.infos[1]).toBe('Bilibili is asking us to slow down — I\'ll try again later.')
  })

  it('a renewed mount resets the once-per-session gate', () => {
    const { host, watch } = build()
    watch.note(new SourceAuthError('netease', 'expired', 'x'))
    watch.reset('netease')
    watch.note(new SourceAuthError('netease', 'expired', 'x'))
    expect(host.infos).toHaveLength(2)
  })
})
