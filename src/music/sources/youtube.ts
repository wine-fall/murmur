// YouTube as a taste source (spec 14 §2.8): yt-dlp reads the account's own
// lists — liked (:ytfav), history (:ythistory), subscriptions (:ytsubs) —
// with the browser's cookie, and the liked-videos playlist names the account
// (its uploader is the listener). No client of murmur's own: yt-dlp is the
// whole transport, and a failure's stderr is read for the auth shape. The
// cookie reaches each spawn as a leased jar (one store unlock per export,
// not one per list), released as soon as the call returns.

import { z } from 'zod'

import type { YtDlpRunner } from '../music.ts'
import { ytdlpFailureText } from '../music.ts'
import { classifyAuthFailure, SourceAuthError } from './auth.ts'
import { BrowserCookieError } from './cookies.ts'
import type { CookieLease } from './cookies.ts'
import { flatEntries } from './flat.ts'
import type { MountResult } from './netease.ts'
import type { BrowserName } from './store.ts'
import { BOUNDS, type TasteItem, type TasteSnapshot, type TasteSource, type VerifyResult } from './taste.ts'

export type YouTubeEntry = { browser: BrowserName; profile?: string | undefined }

export type YouTubeDeps = {
  run: YtDlpRunner
  // The jar for one call, from the browser the entry names.
  lease: (pick: YouTubeEntry) => Promise<CookieLease>
  now?: () => Date
}

async function leased<T>(deps: YouTubeDeps, entry: YouTubeEntry, work: (args: string[]) => Promise<T>): Promise<T> {
  const jar = await deps.lease(entry)
  try {
    return await work(jar.args)
  } finally {
    jar.release()
  }
}

const PlaylistSchema = z.object({ uploader: z.string().nullish(), channel: z.string().nullish() })

// Who the cookie signs in as: the liked-videos playlist's owner. Null = the
// list could not be read as a signed-in account.
async function who(entry: YouTubeEntry, deps: YouTubeDeps): Promise<string | null> {
  let stdout: string
  try {
    stdout = await leased(deps, entry, (cookie) => deps.run(['--dump-single-json', '--flat-playlist', '--playlist-items', '0', '--no-warnings', ...cookie, ':ytfav']))
  } catch (err) {
    // A cookie store that could not be read at all is not an answer about
    // the login: swallowed as one, it sends a listener with no yt-dlp to a
    // sign-in page that cannot help them.
    if (err instanceof BrowserCookieError) throw err
    const reason = classifyAuthFailure(ytdlpFailureText(err))
    if (reason !== null && reason !== 'login-required') throw new SourceAuthError('youtube', reason, ytdlpFailureText(err).slice(0, 200))
    return null
  }
  const start = stdout.indexOf('{')
  if (start === -1) return null
  let json: unknown
  try {
    json = JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
  const parsed = PlaylistSchema.safeParse(json)
  if (!parsed.success) return null
  return parsed.data.uploader ?? parsed.data.channel ?? 'your YouTube account'
}

export async function mountYouTube(entry: YouTubeEntry, deps: YouTubeDeps): Promise<MountResult<YouTubeEntry>> {
  const name = await who(entry, deps)
  if (name === null) return { ok: false, reason: 'login-required' }
  return { ok: true, who: name, entry: { browser: entry.browser, ...(entry.profile !== undefined && { profile: entry.profile }) } }
}

export class YouTubeSource implements TasteSource {
  readonly id = 'youtube' as const
  private entry: YouTubeEntry
  private deps: YouTubeDeps

  constructor(entry: YouTubeEntry, deps: YouTubeDeps) {
    this.entry = entry
    this.deps = deps
  }

  async verify(): Promise<VerifyResult> {
    const name = await who(this.entry, this.deps)
    return name === null ? { ok: false, reason: 'login-required' } : { ok: true, who: name }
  }

  async snapshot(): Promise<TasteSnapshot> {
    const [liked, history, subs] = await Promise.all([
      this.list(':ytfav', BOUNDS.liked),
      this.list(':ythistory', BOUNDS.history),
      this.list(':ytsubs', BOUNDS.subscription),
    ])
    const items: TasteItem[] = [
      ...liked.map((e): TasteItem => ({ kind: 'liked', title: e.title, ...(e.uploader !== '' && { artist: e.uploader }), ref: e.url })),
      // History rows carry no channel in the flat list; the title is the fact.
      ...history.map((e): TasteItem => ({ kind: 'history', title: e.title, ...(e.uploader !== '' && { artist: e.uploader }), ref: e.url })),
      ...subs.map((e): TasteItem => ({ kind: 'subscription', title: e.title })),
    ]
    return { source: 'youtube', takenAt: (this.deps.now ?? (() => new Date()))().toISOString(), items }
  }

  private async list(target: string, bound: number) {
    try {
      return await leased(this.deps, this.entry, (cookie) => flatEntries(this.deps.run, target, cookie, bound))
    } catch (err) {
      const text = ytdlpFailureText(err)
      const reason = classifyAuthFailure(text)
      if (reason !== null) throw new SourceAuthError('youtube', reason, text.trim().split('\n').at(-1) ?? '')
      throw err
    }
  }
}
