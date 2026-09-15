// The /sources conversation (spec 14 §3.1): mount, list, refresh, unmount.
// Deterministic — every step is a fixed question through Host.ask / info,
// read with the guide's serialized line reader, so it is unit-testable with a
// scripted host and no model in the loop. It runs on the Director's floor
// parking: the loop waits inside it while the music plays on. It is the
// single writer of sources.json for its whole duration (store.busy).

import type { Host, InfoTone } from '../../host/host.ts'
import { ask } from '../../host/host.ts'
import type { AskOption } from '../../host/ipc.ts'
import { escPulse, lineReader, type QuitLatch } from '../../setup/guide.ts'
import { AUTH_LINES, type SourceAuthWatch } from './auth.ts'
import { chromeProfile } from './chrome.ts'
import { BrowserCookieError, type CookieFailure } from './cookies.ts'
import type { BilibiliEntry } from './bilibili.ts'
import type { MountResult, NeteaseEntry } from './netease.ts'
import type { QishuiEntry, QishuiMountResult } from './qishui.ts'
import { qrHalfBlocks } from './qishui.ts'
import type { QrMountResult } from './qr.ts'
import type { TasteRefresher } from './refresh.ts'
import { redirectUri, SPOTIFY_CALLBACK_PORT, spotifyClientId, type SpotifyMountResult } from './spotify.ts'
import type { BrowserName, SourceEntry, SourcesStore } from './store.ts'
import { SOURCE_IDS, SOURCE_NAMES, type SourceId, type TasteSource } from './taste.ts'
import type { YouTubeEntry } from './youtube.ts'

// The onboarding card (spec 14 §3.9): one consent ask on a real first run,
// after the slice-B offer and before the persona call — the same shape as
// BOOTSTRAP_OFFER (the question leads, the framing rides as card notes). A
// yes runs the /sources conversation right there; anything else is a no, and
// the invitation (§3.8) carries the option from then on.
export const SOURCES_OFFER = [
  'Connect the music you already keep? [y/N]',
  'NetEase, Spotify, YouTube, Bilibili or Soda Music - murmur reads your likes there, so what it plays fits you.',
  'Nothing is read until you say yes; /sources any time later.',
] as const

export type BrowserPick = { browser: BrowserName; profile?: string | undefined }

export type SpotifyHooks = { onRedirect: (uri: string) => void; onUrl: (url: string) => void; cancelled: () => boolean }

// The platform adapters behind the conversation, injectable so the flow is
// tested with fakes and the real ones are wired once (build.ts).
export type SourceMounts = {
  youtube(b: BrowserPick): Promise<MountResult<YouTubeEntry>>
  bilibili(show: (url: string) => void, cancelled: () => boolean): Promise<QrMountResult<BilibiliEntry>>
  netease(show: (url: string) => void, cancelled: () => boolean): Promise<QrMountResult<NeteaseEntry>>
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
  // The profile rides along: the page must open in the very profile this
  // mount will read, so the two halves cannot name different ones.
  openUrl?: (url: string, profile: string) => void
  platform?: NodeJS.Platform
  now?: () => Date
}

// The one source still read out of a browser: Google has no sign-in murmur
// can drive without a registered app (issue #221), so YouTube keeps the
// Chrome cookie store while NetEase and Bilibili are scanned.
type CookieSource = 'youtube'
// The three that sign in by scanning a code with the platform's own app.
const QR_SOURCES = ['netease', 'bilibili', 'qishui'] as const
type QrSource = (typeof QR_SOURCES)[number]

// What a plain-host listener may type for a row, besides its number.
const NAMES: Record<string, MenuKey> = {
  youtube: 'youtube',
  yt: 'youtube',
  bilibili: 'bilibili',
  bili: 'bilibili',
  netease: 'netease',
  spotify: 'spotify',
  soda: 'qishui',
  qishui: 'qishui',
  refresh: 'refresh',
}

type MenuKey = SourceId | 'refresh'
type MenuRow = AskOption & { key: MenuKey; note: string; checked: boolean }

const QUESTION = 'which accounts should I read? Enter with nothing changed leaves'
const REFRESH_ROW: MenuRow = { key: 'refresh', label: 'refresh', note: 're-read every connected account now', checked: false }

function ago(iso: string | undefined, now: Date): string {
  if (iso === undefined) return 'never read'
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'read just now'
  if (s < 3600) return `read ${Math.round(s / 60)}m ago`
  if (s < 86_400) return `read ${Math.round(s / 3600)}h ago`
  return `read ${Math.round(s / 86_400)}d ago`
}

// The counts a mounted source's menu row shows: what the snapshot holds, by kind.
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

// What the listener types for a source — one of the NAMES keys.
// The menu is a list to tick (spec 14 §3.1): one row per source, ticked
// when it is mounted (an expired login included — unticking it is how it
// is forgotten without signing in), its note the state; a refresh row once
// anything is mounted.
function menuRows(store: SourcesStore, now: Date): MenuRow[] {
  const file = store.read()
  const rows: MenuRow[] = SOURCE_IDS.map((id) => {
    const entry = file[id]
    const label = SOURCE_NAMES[id]
    if (entry === undefined) return { key: id, label, note: 'not connected', checked: false }
    if (entry.status === 'expired') return { key: id, label, note: 'expired — untick to forget it, tick refresh to sign in again', checked: true }
    return { key: id, label, note: `${counts(store, id)} · ${ago(entry.lastRefresh, now)}`, checked: true }
  })
  return store.mounted().length > 0 ? [...rows, REFRESH_ROW] : rows
}

// The card text: the question, the previous submit's results as ready/gap
// rows — IN the card, never as info lines the floating card then covers
// (#231) — and the rows numbered, so a host without a list surface reads
// the same menu and answers with numbers or names.
function menuText(rows: readonly MenuRow[], results: readonly string[]): string {
  const numbered = rows.map((row, i) => `>> ${i + 1}) [${row.checked ? 'x' : ' '}] ${row.label} - ${row.note}`)
  return [QUESTION, ...mergeRows(results), ...numbered].join('\n')
}

// Every row leads with what happened — connected / could not connect /
// disconnected / refreshed — so a card that reopens with three gap rows reads
// as the result it is, not as the same menu again (user report, 2026-09-14).
// Rows that end the same way share one: three cookie sources behind one
// Full Disk Access obstacle are one gap row naming all three, not three
// copies of a long line — which is what pushed the card off an 80x24 screen.
function mergeRows(rows: readonly string[]): string[] {
  const byTail = new Map<string, { marker: string; names: string[] }>()
  for (const row of rows) {
    const match = /^((?:ok|--) (?:connected|could not connect|disconnected|refreshed|could not refresh)) (.+?) — (.+)$/s.exec(row)
    if (match === null) {
      byTail.set(row, { marker: '', names: [] })
      continue
    }
    const [, marker, name, tail] = match as unknown as [string, string, string, string]
    const key = `${marker} — ${tail}`
    const seen = byTail.get(key)
    if (seen === undefined) byTail.set(key, { marker, names: [name] })
    else seen.names.push(name)
  }
  return [...byTail.entries()].map(([key, { marker, names }]) => (names.length === 0 ? key : `${marker} ${names.join(', ')} — ${key.slice(marker.length + 3)}`))
}

// A typed answer as the set of keys it names: the list's own keys (the TUI),
// or numbers / names on the plain host. One word it cannot place fails the
// whole line — half a selection applied would be worse than none.
function parsePick(line: string, rows: readonly MenuRow[]): Set<MenuKey> | string {
  const picked = new Set<MenuKey>()
  for (const word of line.split(/\s+/).filter((w) => w !== '')) {
    const byNumber = /^\d+$/.test(word) ? rows[Number(word) - 1]?.key : undefined
    const byLabel = rows.find((row) => row.label.toLowerCase() === word)?.key
    const key = byNumber ?? NAMES[word] ?? byLabel
    if (key === undefined || !rows.some((row) => row.key === key)) return `I didn't catch "${word}" — numbers or names from the list`
    picked.add(key)
  }
  return picked
}

// Every info line a sub-flow prints, kept as well as shown: the mount flows
// say what happened through `info`, and the menu card that follows needs
// those words as its result row. The flows themselves stay as they are.
function recording(host: Host, notes: string[]): Host {
  return new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === 'info') {
        return (message: string, tone?: InfoTone) => {
          notes.push(message)
          target.info(message, tone)
        }
      }
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// The one browser murmur reads — and the one it opens for signing in, so
// the two can never disagree. Asking which browser only ever produced
// answers murmur then had to fail on: a browser that is not installed, one
// whose cookie store it may not read, or one never signed in to (§3.1).
const CHROME = 'chrome' as const

// The profile for a NEW mount: resolved once here (chrome.ts), then written
// into the entry and pinned. Everything a mounted source does afterwards —
// refresh, verify, playback — reads that pin instead of coming back here.
export function chromePick(): { browser: typeof CHROME; profile: string } {
  return { browser: CHROME, profile: chromeProfile() }
}

// Where each source is signed in, opened in Chrome when no login is found.
const SIGN_IN_URL: Record<CookieSource, string> = {
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube',
}

// Which app scans the code, said in the platform's own terms so the listener
// reaches for the right phone app.
const QR_LINES: Record<QrSource, string> = {
  netease:
    "NetEase signs in with a scan: open the NetEase Cloud Music app, scan the code below, and confirm there. I'll wait up to three minutes (Esc cancels).",
  bilibili: "Bilibili signs in with a scan: open the Bilibili app, scan the code below, and confirm there. I'll wait up to three minutes (Esc cancels).",
  qishui:
    "Soda Music signs in with a Douyin scan: open the Douyin app, scan the code below, and confirm there. I'll wait up to three minutes (Esc cancels).",
}

// What to say when the cookie store cannot be read at all. Each of these
// used to arrive as "sign in there", which is advice that cannot work: no
// one can sign in to a browser they do not have, and signing in again never
// grants a terminal Full Disk Access.
function obstacleLine(reason: CookieFailure, detail: string, platform: NodeJS.Platform): string {
  if (reason === 'no-ytdlp') return 'I need yt-dlp to read a browser login, and I cannot find it — `brew install yt-dlp`, then /sources again.'
  if (reason === 'no-browser') return 'I could not find Chrome on this machine — the taste sources read your Chrome login, so they need it installed.'
  if (reason === 'unreadable') return `I could not read Chrome's cookie store, and yt-dlp did not say why in a way I know: ${detail}`
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
  // A front-end that goes away answers the read with '' like Esc does; on a
  // list that would read as "nothing ticked" and unmount everything.
  let gone = false
  void host.eof?.().then(() => (gone = true))
  store.busy = true
  host.start()
  try {
    let results: string[] = []
    while (!quit.requested) {
      const rows = menuRows(store, now())
      ask(host, menuText(rows, results), 'question', { options: rows, multi: true })
      results = []
      cancelled = false
      const line = (await read()).trim().toLowerCase()
      if (cancelled || gone || quit.requested) return
      // The plain host has no ticks to submit: its Enter keeps things as
      // they are. On a list, '' is the empty selection.
      if (line === '' && host.ask === undefined) return
      const picked = parsePick(line, rows)
      if (typeof picked === 'string') {
        host.info(picked)
        results.push(`-- ${picked}`)
        continue
      }
      // The diff against what stands: unticked-and-mounted goes, ticked-and-
      // not is signed in, refresh re-reads (an expired login is signed in
      // again first — a re-read cannot renew it). Nothing changed = done.
      const file = store.read()
      const toUnmount = store.mounted().filter((id) => !picked.has(id))
      const doRefresh = picked.has('refresh')
      const toRenew = doRefresh ? store.mounted().filter((id) => file[id]?.status === 'expired' && picked.has(id)) : []
      const toMount = SOURCE_IDS.filter((id) => picked.has(id) && file[id] === undefined)
      if (toUnmount.length === 0 && toMount.length === 0 && !doRefresh) return
      for (const id of toUnmount) results.push(unmount(deps, id))
      // Sign-ins may wait on the listener, and an Esc there ends the submit
      // — the rows already done stay done, the rest are not started.
      const stopped = (): boolean => cancelled || quit.requested
      for (const id of toRenew) {
        if (stopped()) break
        results.push(await mountOne(deps, read, id, platform, () => cancelled))
      }
      if (doRefresh && !stopped()) results.push(...(await refresh(deps)))
      for (const id of toMount) {
        if (stopped()) break
        results.push(await mountOne(deps, read, id, platform, () => cancelled))
      }
    }
  } finally {
    store.busy = false
    host.onInterrupt?.(null)
  }
}

// One mount, as a result row for the next card: 'ok connected <name> — signed
// in as <who> - <counts>' or '-- could not connect <name> - <the flow's own
// last word>'.
async function mountOne(deps: SourcesFlowDeps, read: () => Promise<string>, id: SourceId, platform: NodeJS.Platform, cancelled: () => boolean): Promise<string> {
  const notes: string[] = []
  const recorded = { ...deps, host: recording(deps.host, notes) }
  if (id === 'spotify') await mountSpotifyFlow(recorded, cancelled)
  else if (id === 'youtube') await mountCookieFlow(recorded, read, id, platform, cancelled)
  else await mountQrFlow(recorded, id, cancelled)
  const name = SOURCE_NAMES[id]
  const who = notes.find((line) => line.startsWith('signed in as '))
  if (who !== undefined) return `ok connected ${name} — ${who} · ${counts(deps.store, id)}`
  return `-- could not connect ${name} — ${cancelled() ? 'stopped — nothing was written' : (notes.at(-1) ?? 'not connected')}`
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
  const pinned = (entry as { profile?: string }).profile
  host.debug?.(`sources.mount ${id}${pinned === undefined ? '' : ` profile=${pinned}`}`)
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

async function mountCookieFlow(
  deps: SourcesFlowDeps,
  read: () => Promise<string>,
  id: CookieSource,
  platform: NodeJS.Platform,
  cancelled: () => boolean,
): Promise<void> {
  const { host } = deps
  const site = SOURCE_NAMES[id]
  const pick = chromePick()
  host.info(`checking ${site} in Chrome...`)
  type CookieMount = MountResult<YouTubeEntry>
  const attempt = async (): Promise<CookieMount | null> => {
    try {
      return await deps.mounts[id](pick)
    } catch (err) {
      if (err instanceof BrowserCookieError) {
        host.debug?.(`sources.cookies ${id} profile=${pick.profile} ${err.reason}: ${err.detail}`)
        // A profile Chrome has never opened is, to a listener, the same thing
        // as not being signed in — and opening the sign-in page in it is what
        // creates it. So it takes the no-login path rather than an obstacle.
        if (err.reason === 'no-profile') return { ok: false, reason: 'login-required' }
        host.info(obstacleLine(err.reason, err.detail, platform))
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
    deps.openUrl?.(SIGN_IN_URL[id], pick.profile)
    host.info(`no ${site} login yet — opened ${site} in Chrome; sign in there.`)
    ask(host, 'press Enter when you have signed in (or Esc to stop).', 'question')
    await read()
    // Esc answers the read with '' exactly as Enter does, so the latch is
    // what separates "I have signed in" from "stop" — without it an Esc
    // would go on to mount the account anyway.
    if (cancelled() || deps.quit.requested) return
    // The cached export answers from before they signed in; drop it first.
    deps.forgetCookies?.()
    result = await attempt()
    if (result === null) return
    if (!result.ok) {
      host.info(`still no ${site} login in Chrome — /sources when you have signed in.`)
      return
    }
  }
  await finishMount(deps, 'youtube', result.who, result.entry as YouTubeEntry)
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

// The scan mount (spec 14 §3.1), the same conversation for all three: show
// the code, wait three minutes, Esc stops it. No browser is involved, so
// none of the browser obstacles — an uninstalled Chrome, a locked cookie
// store, a terminal without Full Disk Access — can reach this path.
async function mountQrFlow(deps: SourcesFlowDeps, id: QrSource, cancelled: () => boolean): Promise<void> {
  const { host } = deps
  const name = SOURCE_NAMES[id]
  // The QR is an authorization artifact: it goes to the screen only, never
  // through `info` (which the diagnostics keep — §3.6). A host without that
  // surface cannot be handed the code at all.
  const show = host.showPrivate?.bind(host)
  if (show === undefined) {
    host.info(`I cannot show the code here — run murmur in a terminal front-end to mount ${name}.`)
    return
  }
  host.info(QR_LINES[id])
  let result: QrMountResult<NeteaseEntry> | QrMountResult<BilibiliEntry> | QishuiMountResult
  try {
    result = await deps.mounts[id]((url) => show(qrHalfBlocks(url).join('\n')), cancelled)
  } catch (err) {
    host.info(`could not reach ${name} (${err instanceof Error ? err.message : String(err)}) — /sources to try again.`)
    return
  }
  if (!result.ok) {
    host.info(
      result.reason === 'timeout'
        ? 'the code timed out — /sources to get a fresh one.'
        : result.reason === 'cancelled'
          ? 'cancelled — nothing was written.'
          : AUTH_LINES['login-required'](name),
    )
    return
  }
  // Esc pressed while the confirming poll or the account read was in flight:
  // the scan succeeded, but the listener asked to stop, and "cancelled —
  // nothing was written" has to mean it (codex review).
  if (cancelled() || deps.quit.requested) return
  if (id === 'netease') await finishMount(deps, 'netease', result.who, result.entry as NeteaseEntry)
  else if (id === 'bilibili') await finishMount(deps, 'bilibili', result.who, result.entry as BilibiliEntry)
  else await finishMount(deps, 'qishui', result.who, result.entry as QishuiEntry)
}

// Re-read every mounted source; each outcome is said, and returned as the
// next card's result row.
async function refresh(deps: SourcesFlowDeps): Promise<string[]> {
  const { host } = deps
  const ids = deps.store.mounted()
  host.info(`refreshing ${ids.length} source${ids.length === 1 ? '' : 's'}...`)
  const rows: string[] = []
  for (const outcome of await deps.refresher.refreshAll()) {
    const said = outcome.ok ? `${outcome.count} items` : `could not read it (${outcome.error})`
    host.info(`${SOURCE_NAMES[outcome.id]}: ${said}`)
    rows.push(`${outcome.ok ? 'ok refreshed' : '-- could not refresh'} ${SOURCE_NAMES[outcome.id]} — ${said}`)
  }
  return rows
}

function unmount(deps: SourcesFlowDeps, id: SourceId): string {
  const { host, store } = deps
  store.unmount(id)
  host.debug?.(`sources.unmount ${id}`)
  const gone =
    id === 'spotify'
      ? 'its tokens are dropped here (there is no remote revoke without a secret — remove the app under your Spotify account settings if you want it gone there too).'
      : 'its snapshot is gone.'
  host.info(`${SOURCE_NAMES[id]} unmounted; ${gone}`)
  return `ok disconnected ${SOURCE_NAMES[id]} — ${gone}`
}
