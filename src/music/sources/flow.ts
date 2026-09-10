// The /sources conversation (spec 14 §3.1): mount, list, refresh, unmount.
// Deterministic — every step is a fixed question through Host.ask / info,
// read with the guide's serialized line reader, so it is unit-testable with a
// scripted host and no model in the loop. It runs on the Director's floor
// parking: the loop waits inside it while the music plays on. It is the
// single writer of sources.json for its whole duration (store.busy).

import type { Host } from '../../host/host.ts'
import { ask } from '../../host/host.ts'
import { escPulse, lineReader, type QuitLatch } from '../../setup/guide.ts'
import { AUTH_LINES, type SourceAuthWatch } from './auth.ts'
import { BrowserCookieError, type CookieFailure } from './cookies.ts'
import type { BilibiliEntry } from './bilibili.ts'
import type { MountResult, NeteaseEntry } from './netease.ts'
import type { QishuiMountResult } from './qishui.ts'
import { qrHalfBlocks } from './qishui.ts'
import type { TasteRefresher } from './refresh.ts'
import { redirectUri, SPOTIFY_CALLBACK_PORT, spotifyClientId, type SpotifyMountResult } from './spotify.ts'
import type { BrowserName, SourceEntry, SourcesStore } from './store.ts'
import { SOURCE_IDS, SOURCE_NAMES, type SourceId, type TasteSource } from './taste.ts'
import type { YouTubeEntry } from './youtube.ts'

// The one onboarding line (spec 14 §3.9): said once on a real first run,
// between the persona being written and the first beat.
export const SOURCES_ONBOARDING_LINE =
  'when you like, /sources connects your NetEase, Spotify or YouTube likes so I pick better. Nothing is read until you do.'

export type BrowserPick = { browser: BrowserName; profile?: string | undefined }

export type SpotifyHooks = { onRedirect: (uri: string) => void; onUrl: (url: string) => void; cancelled: () => boolean }

// The platform adapters behind the conversation, injectable so the flow is
// tested with fakes and the real ones are wired once (build.ts).
export type SourceMounts = {
  youtube(b: BrowserPick): Promise<MountResult<YouTubeEntry>>
  bilibili(b: BrowserPick): Promise<MountResult<BilibiliEntry>>
  netease(b: BrowserPick): Promise<MountResult<NeteaseEntry>>
  spotify(clientId: string, hooks: SpotifyHooks): Promise<SpotifyMountResult>
  qishui(show: (url: string) => void, cancelled: () => boolean): Promise<QishuiMountResult>
}

export type SourcesFlowDeps = {
  host: Host
  store: SourcesStore
  quit: QuitLatch
  refresher: TasteRefresher
  watch: SourceAuthWatch
  mounts: SourceMounts
  // The live adapter for a freshly mounted entry, for the first snapshot.
  build: (id: SourceId, entry: SourceEntry[SourceId]) => TasteSource | null
  // Drop whatever was cached from the browser's cookie store: a mount that
  // found no login sends the listener off to sign in, and their retry has to
  // reach the browser again rather than the answer from a minute ago.
  forgetCookies?: () => void
  // Opens a URL in the browser murmur also reads (Chrome), so the listener
  // cannot sign in somewhere murmur will not look.
  openUrl?: (url: string) => void
  platform?: NodeJS.Platform
  now?: () => Date
}

const COOKIE_SOURCES = ['youtube', 'bilibili', 'netease'] as const
type CookieSource = (typeof COOKIE_SOURCES)[number]

const NAMES: Record<string, SourceId> = {
  youtube: 'youtube',
  yt: 'youtube',
  bilibili: 'bilibili',
  bili: 'bilibili',
  netease: 'netease',
  spotify: 'spotify',
  soda: 'qishui',
  qishui: 'qishui',
}

const MENU = 'what would you like to do? mount <name> | refresh | unmount <name> | done'

function ago(iso: string | undefined, now: Date): string {
  if (iso === undefined) return 'never read'
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'read just now'
  if (s < 3600) return `read ${Math.round(s / 60)}m ago`
  if (s < 86_400) return `read ${Math.round(s / 3600)}h ago`
  return `read ${Math.round(s / 86_400)}d ago`
}

// The counts the status line shows: what the snapshot holds, by kind.
function counts(store: SourcesStore, id: SourceId): string {
  const snapshot = store.readSnapshot(id)
  if (snapshot === null) return 'nothing read yet'
  const by = new Map<string, number>()
  for (const item of snapshot.items) by.set(item.kind, (by.get(item.kind) ?? 0) + 1)
  const parts: string[] = []
  const liked = (by.get('liked') ?? 0) + (by.get('favourite') ?? 0)
  if (liked > 0) parts.push(`${liked} liked`)
  const playlists = by.get('playlist') ?? 0
  if (playlists > 0) parts.push(`${playlists} playlist${playlists === 1 ? '' : 's'}`)
  const tops = (by.get('top-artist') ?? 0) + (by.get('top-track') ?? 0)
  if (tops > 0) parts.push(`top ${tops}`)
  return parts.length === 0 ? `${snapshot.items.length} items` : parts.join(', ')
}

function statusLine(store: SourcesStore, now: Date): string {
  const file = store.read()
  const mounted = store.mounted()
  const available = SOURCE_IDS.filter((id) => !mounted.includes(id)).map((id) => SOURCE_NAMES[id])
  if (mounted.length === 0) return `nothing mounted yet · available: ${available.join(', ')}`
  const rows = mounted.map((id) => {
    const entry = file[id]!
    if (entry.status === 'expired') return `${SOURCE_NAMES[id]} (expired — mount it again to renew)`
    return `${SOURCE_NAMES[id]} (${counts(store, id)} · ${ago(entry.lastRefresh, now)})`
  })
  return `mounted: ${rows.join(' · ')}${available.length === 0 ? '' : ` · available: ${available.join(', ')}`}`
}

// The one browser murmur reads — and the one it opens for signing in, so
// the two can never disagree. Asking which browser only ever produced
// answers murmur then had to fail on: a browser that is not installed, one
// whose cookie store it may not read, or one never signed in to (§3.1).
const CHROME = 'chrome' as const

// Where each source is signed in, opened in Chrome when no login is found.
const SIGN_IN_URL: Record<CookieSource, string> = {
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube',
  bilibili: 'https://passport.bilibili.com/login',
  netease: 'https://music.163.com/',
}

// What to say when the cookie store cannot be read at all. Each of these
// used to arrive as "sign in there", which is advice that cannot work: no
// one can sign in to a browser they do not have, and signing in again never
// grants a terminal Full Disk Access.
function obstacleLine(reason: CookieFailure, platform: NodeJS.Platform): string {
  if (reason === 'no-ytdlp') return 'I need yt-dlp to read a browser login, and I cannot find it — `brew install yt-dlp`, then /sources again.'
  if (reason === 'no-browser') return 'I could not find Chrome on this machine — the taste sources read your Chrome login, so they need it installed.'
  return platform === 'darwin'
    ? 'Chrome is here, but I am not allowed to read its cookie store — give this terminal Full Disk Access (System Settings → Privacy & Security), then /sources again.'
    : "Chrome is here, but I am not allowed to read its cookie store — check this terminal's permissions, then /sources again."
}

export async function runSources(deps: SourcesFlowDeps): Promise<void> {
  const { host, store, quit } = deps
  const now = deps.now ?? (() => new Date())
  const platform = deps.platform ?? process.platform
  const esc = escPulse()
  let cancelled = false
  // Esc answers the pending read with '' (back to the menu, or out) and
  // cancels a poll in flight; a typed /quit ends everything through the latch.
  host.onInterrupt?.(() => {
    cancelled = true
    esc.fire()
  })
  const read = lineReader(host, quit, esc)
  store.busy = true
  host.start()
  try {
    while (!quit.requested) {
      host.info(statusLine(store, now()))
      ask(host, MENU, 'question')
      cancelled = false
      const line = (await read()).trim().toLowerCase()
      if (line === '' || line === 'done' || quit.requested) return
      const [verb, ...rest] = line.split(/\s+/)
      const target = NAMES[rest.join(' ')]
      if (verb === 'refresh') {
        await refresh(deps)
        continue
      }
      if ((verb === 'mount' || verb === 'unmount') && target === undefined) {
        host.info(`name one of ${SOURCE_IDS.map((id) => (id === 'qishui' ? 'soda' : id)).join(', ')}.`)
        continue
      }
      if (verb === 'unmount' && target !== undefined) {
        unmount(deps, target)
        continue
      }
      if (verb === 'mount' && target !== undefined) {
        if (target === 'spotify') await mountSpotifyFlow(deps, () => cancelled)
        else if (target === 'qishui') await mountQishuiFlow(deps, () => cancelled)
        else await mountCookieFlow(deps, read, target, platform)
        continue
      }
      host.info("I didn't catch that — mount <name>, refresh, unmount <name>, or done.")
    }
  } finally {
    store.busy = false
    host.onInterrupt?.(null)
  }
}

// Verify, first snapshot, write, say (spec 14 §3.1). The snapshot runs in
// the foreground with a progress line; a read that fails still mounts the
// verified account and leaves the refresh to try again.
async function finishMount<K extends SourceId>(deps: SourcesFlowDeps, id: K, who: string, entry: SourceEntry[K] extends infer E ? Omit<E, 'mountedAt' | 'status' | 'lastRefresh' | 'lastError'> : never): Promise<void> {
  const { host, store, watch } = deps
  const now = deps.now ?? (() => new Date())
  host.info(`signed in as ${who}`)
  host.info(`reading what you keep on ${SOURCE_NAMES[id]}...`)
  // A remount may be a different account: the previous one's snapshot goes
  // before the new one is read, so a read that fails leaves no taste rather
  // than the old account's taste under a fresh mount date.
  store.dropSnapshot(id)
  store.mount(id, entry as never, now())
  watch.reset(id)
  host.debug?.(`sources.mount ${id}`)
  const source = deps.build(id, store.read()[id] as SourceEntry[K])
  if (source === null) return
  try {
    const snapshot = await source.snapshot()
    store.writeSnapshot(snapshot)
    store.markRefreshed(id, now())
    host.info(`done — ${snapshot.items.length} items from ${SOURCE_NAMES[id]}; I'll keep it fresh.`)
  } catch (err) {
    host.info(`could not read ${SOURCE_NAMES[id]} right now (${err instanceof Error ? err.message : String(err)}); mounted anyway — I'll try again later.`)
  }
}

async function mountCookieFlow(deps: SourcesFlowDeps, read: () => Promise<string>, id: CookieSource, platform: NodeJS.Platform): Promise<void> {
  const { host } = deps
  const site = SOURCE_NAMES[id]
  const pick: BrowserPick = { browser: CHROME }
  host.info(`checking ${site} in Chrome...`)
  type CookieMount = MountResult<YouTubeEntry> | MountResult<BilibiliEntry> | MountResult<NeteaseEntry>
  const attempt = async (): Promise<CookieMount | null> => {
    try {
      return await deps.mounts[id](pick)
    } catch (err) {
      if (err instanceof BrowserCookieError) {
        host.info(obstacleLine(err.reason, platform))
        host.debug?.(`sources.cookies ${id} ${err.reason}: ${err.detail}`)
        return null
      }
      host.info(`could not reach ${site} (${err instanceof Error ? err.message : String(err)}) — try /sources again in a moment.`)
      return null
    }
  }
  let result = await attempt()
  if (result === null) return
  if (!result.ok) {
    // Not a dead end: open the page they sign in on, in the browser that
    // will then be read, and wait — rather than sending them back through
    // the whole /sources conversation.
    deps.openUrl?.(SIGN_IN_URL[id])
    host.info(`no ${site} login yet — opened ${site} in Chrome; sign in there.`)
    ask(host, 'press Enter when you have signed in (or leave it to stop).', 'question')
    await read()
    if (deps.quit.requested) return
    // The cached export answers from before they signed in; drop it first.
    deps.forgetCookies?.()
    result = await attempt()
    if (result === null) return
    if (!result.ok) {
      host.info(`still no ${site} login in Chrome — /sources when you have signed in.`)
      return
    }
  }
  if (id === 'youtube') await finishMount(deps, 'youtube', result.who, result.entry as YouTubeEntry)
  else if (id === 'bilibili') await finishMount(deps, 'bilibili', result.who, result.entry as BilibiliEntry)
  else await finishMount(deps, 'netease', result.who, result.entry as NeteaseEntry)
}

async function mountSpotifyFlow(deps: SourcesFlowDeps, cancelled: () => boolean): Promise<void> {
  const { host } = deps
  const clientId = spotifyClientId()
  host.info('opening Spotify in your browser — approve there; I\'ll wait up to three minutes (Esc cancels).')
  let result: SpotifyMountResult
  try {
    result = await deps.mounts.spotify(clientId, {
      onRedirect: (uri) => {
        if (uri !== redirectUri(SPOTIFY_CALLBACK_PORT, clientId)) host.info(`listening at ${uri} — the usual port was taken.`)
      },
      onUrl: (url) => host.info(`if the browser did not open, approve here: ${url}`),
      cancelled,
    })
  } catch (err) {
    host.info(`could not reach Spotify (${err instanceof Error ? err.message : String(err)}) — /sources to try again.`)
    return
  }
  if (!result.ok) {
    host.info(
      result.reason === 'timeout'
        ? "didn't hear back from Spotify — /sources to try again."
        : result.reason === 'cancelled'
          ? 'cancelled — nothing was written.'
          : 'Spotify did not accept that — /sources to try again.',
    )
    return
  }
  await finishMount(deps, 'spotify', result.who, result.entry)
}

async function mountQishuiFlow(deps: SourcesFlowDeps, cancelled: () => boolean): Promise<void> {
  const { host } = deps
  // The QR is an authorization artifact: it goes to the screen only, never
  // through `info` (which the diagnostics keep — §3.6). A host without that
  // surface cannot be handed the code at all.
  const show = host.showPrivate?.bind(host)
  if (show === undefined) {
    host.info('I cannot show the code here — run murmur in a terminal front-end to mount Soda Music.')
    return
  }
  host.info('Soda Music signs in with a Douyin scan: open the Douyin app, scan the code below, and confirm there. I\'ll wait up to three minutes (Esc cancels).')
  let result: QishuiMountResult
  try {
    result = await deps.mounts.qishui((url) => show(qrHalfBlocks(url).join('\n')), cancelled)
  } catch (err) {
    host.info(`could not reach Soda Music (${err instanceof Error ? err.message : String(err)}) — /sources to try again.`)
    return
  }
  if (!result.ok) {
    host.info(
      result.reason === 'timeout'
        ? 'the code timed out — /sources to get a fresh one.'
        : result.reason === 'cancelled'
          ? 'cancelled — nothing was written.'
          : AUTH_LINES['login-required'](SOURCE_NAMES.qishui),
    )
    return
  }
  await finishMount(deps, 'qishui', result.who, result.entry)
}

async function refresh(deps: SourcesFlowDeps): Promise<void> {
  const { host } = deps
  const ids = deps.store.mounted()
  if (ids.length === 0) {
    host.info('nothing mounted to refresh.')
    return
  }
  host.info(`refreshing ${ids.length} source${ids.length === 1 ? '' : 's'}...`)
  for (const outcome of await deps.refresher.refreshAll()) {
    host.info(outcome.ok ? `${SOURCE_NAMES[outcome.id]}: ${outcome.count} items` : `${SOURCE_NAMES[outcome.id]}: could not read it (${outcome.error})`)
  }
}

function unmount(deps: SourcesFlowDeps, id: SourceId): void {
  const { host, store } = deps
  if (!store.mounted().includes(id)) {
    host.info(`${SOURCE_NAMES[id]} is not mounted.`)
    return
  }
  store.unmount(id)
  host.debug?.(`sources.unmount ${id}`)
  host.info(
    id === 'spotify'
      ? 'Spotify unmounted; its tokens are dropped here (there is no remote revoke without a secret — remove the app under your Spotify account settings if you want it gone there too).'
      : `${SOURCE_NAMES[id]} unmounted; its snapshot is gone.`,
  )
}
