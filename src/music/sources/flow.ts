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
import { AUTH_LINES, SourceAuthError, type SourceAuthWatch } from './auth.ts'
import { type ChromeDeps, type ChromeProfileInfo, preselectProfile, profiles } from './chrome.ts'
import { BrowserCookieError, type CookieFailure } from './cookies.ts'
import type { BilibiliEntry } from './bilibili.ts'
import type { MountResult, NeteaseEntry } from './netease.ts'
import type { QQMusicEntry, QQMusicMountResult } from './qqmusic.ts'
import type { QishuiEntry, QishuiMountResult } from './qishui.ts'
import { qrHalfBlocks } from './qishui.ts'
import type { QrMountResult, QrStatus } from './qr.ts'
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
  'NetEase, QQ Music, Spotify, YouTube, Bilibili or Soda Music - murmur reads your likes there, so what it plays fits you.',
  'Nothing is read until you say yes; /sources any time later.',
] as const

export type BrowserPick = { browser: BrowserName; profile?: string | undefined }

// `openUrl` overrides the wiring's own opener so the consent page lands in
// the Chrome profile the listener picked on the sign-in card. murmur never
// reads a Spotify cookie — the profile decides which account is signed in on
// the page it opens, nothing more.
export type SpotifyHooks = { onRedirect: (uri: string) => void; onUrl: (url: string) => void; cancelled: () => boolean; openUrl?: (url: string) => void }

// The four sources that can be read out of a browser's cookie store.
// NetEase and Bilibili can also be scanned; YouTube cannot (issue #221) and
// QQ Music can also be scanned, with WeChat (spec 14 §2.10); YouTube cannot
// (issue #221), so for it this is the only road.
export type BrowserMounts = {
  youtube(b: BrowserPick): Promise<MountResult<YouTubeEntry>>
  netease(b: BrowserPick): Promise<MountResult<NeteaseEntry>>
  bilibili(b: BrowserPick): Promise<MountResult<BilibiliEntry>>
  qqmusic(b: BrowserPick): Promise<QQMusicMountResult>
}

// The platform adapters behind the conversation, injectable so the flow is
// tested with fakes and the real ones are wired once (build.ts).
export type SourceMounts = {
  browser: BrowserMounts
  bilibili(show: QrShow, cancelled: () => boolean, onStatus: QrOnStatus): Promise<QrMountResult<BilibiliEntry>>
  netease(show: QrShow, cancelled: () => boolean, onStatus: QrOnStatus): Promise<QrMountResult<NeteaseEntry>>
  spotify(clientId: string, hooks: SpotifyHooks): Promise<SpotifyMountResult>
  qishui(show: QrShow, cancelled: () => boolean, onStatus: QrOnStatus): Promise<QishuiMountResult>
  qqmusic(show: QrShow, cancelled: () => boolean, onStatus: QrOnStatus): Promise<QrMountResult<QQMusicEntry>>
}

// Where the code's URL goes (the flow draws it), and what the wait is
// waiting on — the two halves of the notice card the scan puts up.
type QrShow = (url: string) => void
type QrOnStatus = (status: QrStatus) => void

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
  // Where the Chrome profile list and the preselection are read from
  // (chrome.ts); injected whole so a test can hand over a Local State file.
  chrome?: ChromeDeps
  platform?: NodeJS.Platform
  now?: () => Date
}

// The sources a browser's cookie store can mount.
type CookieSource = keyof BrowserMounts
// The three that sign in by scanning a code with the platform's own app.
const QR_SOURCES = ['netease', 'bilibili', 'qishui', 'qqmusic'] as const
type QrSource = (typeof QR_SOURCES)[number]
// The three that can go either way, and so are the ones the card is a real
// question for. Soda Music has no browser road at all (its entry is minted by
// the scan itself), so it is never asked; YouTube has no scan.
const BOTH_ROADS = ['netease', 'bilibili', 'qqmusic'] as const

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
  qqmusic: 'qqmusic',
  qq: 'qqmusic',
  refresh: 'refresh',
}

type MenuKey = SourceId | 'refresh'
type MenuRow = AskOption & { key: MenuKey; note: string; checked: boolean }

const QUESTION = 'which accounts should I read? Enter with nothing changed leaves'
// An ACTION, not a state (spec 14 §3.1): re-reading is something you do
// now, not something you are connected to, so the row carries `action` and
// is drawn as a button — on the card and in the numbered rows alike.
const REFRESH_ROW: MenuRow = { key: 'refresh', label: 'refresh now', note: 're-read every connected account now', checked: false, action: true }

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
  const watched = by.get('history') ?? 0
  if (watched > 0) parts.push(`${watched} watched`)
  // 'frequents' is the same accounts in another order, so it is not added in.
  const followed = by.get('follows') ?? 0
  if (followed > 0) parts.push(`${followed} followed`)
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
  const numbered = rows.map((row, i) => `>> ${i + 1}) ${row.action === true ? `( ${row.label} )` : `[${row.checked ? 'x' : ' '}] ${row.label}`} - ${row.note}`)
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

// QQ Music plays, but only the half this account has rights to (spec 14
// §2.5): VIP tracks are dropped at search. The mount says so itself, before
// anything is read — a listener who connects it and then never hears the one
// song they went looking for has no other way to learn why.
export const QQMUSIC_VIP_NOTE =
  "QQ Music plays here - but not its VIP-only tracks, so when a song needs a subscription I'll skip it and find another."

// Where each source is signed in, opened in Chrome when no login is found.
const SIGN_IN_URL: Record<CookieSource, string> = {
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube',
  netease: 'https://music.163.com/',
  bilibili: 'https://passport.bilibili.com/login',
  qqmusic: 'https://y.qq.com/',
}

// --- the sign-in card (spec 14 §3.1) ------------------------------------- //

// How this mount signs in. The card asks it once, before anything is read,
// because both halves of the answer used to be guessed: which road (a scan,
// or a browser) and — for a browser — WHICH Chrome profile. Guessing the
// second one is what read a listener's work account when they meant their
// personal one, with no step anywhere to say so (user report, 2026-09-15).
export type SignIn = { kind: 'scan' } | { kind: 'chrome'; profile: string }

// A row of the card, carrying the road it stands for.
export type SignInRow = AskOption & { choice: SignIn }

const SCAN_KEY = 'scan'
const CHROME_KEY = 'chrome:'

// The note under the question: the one fix for the failure the card itself
// cannot prevent — the right profile picked, the wrong account signed in to
// the SITE inside it. murmur cannot sign anyone out, so it says where to.
export const SIGN_IN_NOTE = 'signed in to the wrong account there? sign out on the site in that Chrome window, then pick it again.'

// Which app scans this source's code, in the platform's own terms — a code
// with the wrong app pointed at it is what the row's wording prevents.
const SCAN_ROWS: Record<QrSource, string> = {
  netease: 'scan with the NetEase Cloud Music app',
  bilibili: 'scan with the Bilibili app',
  qishui: 'scan with the Douyin app',
  // WeChat, not QQ: the code is issued on the WeChat open platform, and a QQ
  // app pointed at it simply will not take.
  qqmusic: 'scan with WeChat',
}

// The rows: the scan first where there is one — it is the road that needs no
// browser, no cookie store and no Full Disk Access — then one row per Chrome
// profile, named as Chrome's own profile menu names them. The preselected
// profile is always offered even when Chrome does not list it: the knob can
// name a directory that was deleted, and that mount has a road of its own
// (the no-login path, #240), which it cannot take if it cannot be picked.
//
// `scanPicked` opens the card on the scan row instead of a profile: a source
// that can scan and has never been mounted has no reason to prefer a browser,
// and the scan is the road that asks the listener's machine for nothing.
export function signInRows(id: SourceId, list: readonly ChromeProfileInfo[], preselect: string, scanPicked = false): SignInRow[] {
  const rows: SignInRow[] = []
  if ((BOTH_ROADS as readonly SourceId[]).includes(id)) rows.push({ key: SCAN_KEY, label: SCAN_ROWS[id as QrSource], choice: { kind: 'scan' }, checked: scanPicked })
  const dirs = list.some((p) => p.dir === preselect) ? list : [...list, { dir: preselect, name: preselect }]
  for (const profile of dirs) {
    rows.push({
      key: `${CHROME_KEY}${profile.dir}`,
      label: `Chrome — ${profile.name}${profile.email === undefined ? '' : ` (${profile.email})`}`,
      choice: { kind: 'chrome', profile: profile.dir },
      checked: !scanPicked && profile.dir === preselect,
    })
  }
  return rows
}

// The card's text, for a front-end with no list surface: the question, the
// note, and the same rows numbered — the shape every other menu here uses.
export function signInText(id: SourceId, rows: readonly SignInRow[]): string {
  return [
    `How should I sign in to ${SOURCE_NAMES[id]}?`,
    SIGN_IN_NOTE,
    ...rows.map((row, i) => `>> ${i + 1}) [${row.checked === true ? 'x' : ' '}] ${row.label}`),
  ].join('\n')
}

// One answer as the row it names: the row's own key (the TUI's list), its
// number, or the profile's directory typed bare. Anything else is refused
// rather than guessed — guessing here mounts the wrong account.
function parseSignIn(line: string, rows: readonly SignInRow[]): SignInRow | string {
  const word = line.trim()
  if (word === '') return rows.find((row) => row.checked === true) ?? rows[0]!
  const byNumber = /^\d+$/.test(word) ? rows[Number(word) - 1] : undefined
  const byKey = rows.find((row) => row.key.toLowerCase() === word.toLowerCase())
  const byDir = rows.find((row) => row.choice.kind === 'chrome' && row.choice.profile.toLowerCase() === word.toLowerCase())
  return byNumber ?? byKey ?? byDir ?? `I didn't catch "${word}" — numbers or names from the list`
}

// Ask, and re-ask a line that names no row. Null = the listener stopped
// (Esc, a front-end that left, or /quit): nothing is mounted and nothing is
// written, exactly as an Esc on the menu behind it.
async function askSignIn(deps: SourcesFlowDeps, read: () => Promise<string>, id: SourceId, previous: string | undefined, cancelled: () => boolean): Promise<SignIn | null> {
  const { host } = deps
  const pinned = (deps.store.read()[id] as { profile?: string } | undefined)?.profile
  // A source that can scan and carries no browser pin opens on its scan row;
  // one being reconnected opens on the profile that mount already chose.
  const scanPicked = (BOTH_ROADS as readonly SourceId[]).includes(id) && (pinned === undefined || pinned.trim() === '')
  const rows = signInRows(id, profiles(deps.chrome), preselectProfile(pinned, previous, deps.chrome), scanPicked)
  // The row's own road stays here; the wire carries the option alone.
  const options: AskOption[] = rows.map(({ choice: _choice, ...option }) => option)
  for (;;) {
    ask(host, signInText(id, rows), 'question', { options, multi: false })
    const picked = parseSignIn(await read(), rows)
    if (cancelled() || deps.quit.requested) return null
    if (typeof picked !== 'string') return picked.choice
    host.info(picked)
  }
}

// Which app scans the code, said in the platform's own terms so the listener
// reaches for the right phone app.
const QR_LINES: Record<QrSource, string> = {
  netease:
    "NetEase signs in with a scan: open the NetEase Cloud Music app, scan the code on screen, and confirm there. I'll wait up to three minutes (Esc cancels).",
  bilibili: "Bilibili signs in with a scan: open the Bilibili app, scan the code on screen, and confirm there. I'll wait up to three minutes (Esc cancels).",
  qishui:
    "Soda Music signs in with a Douyin scan: open the Douyin app, scan the code on screen, and confirm there. I'll wait up to three minutes (Esc cancels).",
  qqmusic:
    "QQ Music signs in with a WeChat scan: open WeChat, scan the code on screen, and confirm there. I'll wait up to three minutes (Esc cancels).",
}

// Which app the card's title names — a code with the wrong app pointed at it
// is the failure this text exists to prevent.
const QR_APPS: Record<QrSource, string> = {
  netease: 'the NetEase Cloud Music app',
  bilibili: 'the Bilibili app',
  qishui: 'Douyin',
  qqmusic: 'WeChat',
}

// The notice card's footer: what is being waited on, then the way out.
const QR_WAITING = 'waiting for the scan · esc - cancel'
const QR_SCANNED = 'scanned — confirm on your phone'

// Where one sign-in sits in the rows being mounted this submit, so a listener
// three codes deep knows there are two more coming. `of` 1 carries no counter.
type Step = { at: number; of: number }

// The Chrome profile this submit has already settled on, carried across its
// mounts as the next card's preselection.
type Chosen = { profile?: string }

// A mount the listener stopped before it started, as the next card's row.
function stoppedRow(id: SourceId): string {
  return `-- could not connect ${SOURCE_NAMES[id]} — stopped — nothing was written`
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
      // Sign-ins may wait on the listener, and an Esc — or a typed /quit,
      // which no open read is there to catch while a code is on screen —
      // ends the submit: the rows already done stay done, the rest are not
      // started, and the sign-in in flight is told to stop.
      // A front-end that went away answers every read with '' — which on a
      // sign-in card would read as "take the preselected profile", mounting
      // an account nobody chose (codex review). It stops the submit, exactly
      // as an Esc does.
      const stopped = (): boolean => cancelled || gone || quit.requested
      // The sign-ins this submit will run, counted up front: the card's title
      // carries the position, and a refresh in between does not change it.
      const of = toRenew.length + toMount.length
      let at = 0
      // What the last sign-in card chose, so the next one opens on it: a
      // listener connecting three sources is connecting three accounts of one
      // person, not answering the same question three times.
      const chosen: Chosen = {}
      for (const id of toRenew) {
        if (stopped()) break
        results.push(await mountOne(deps, read, id, platform, stopped, { at: ++at, of }, chosen))
      }
      if (doRefresh && !stopped()) results.push(...(await refresh(deps)))
      for (const id of toMount) {
        if (stopped()) break
        results.push(await mountOne(deps, read, id, platform, stopped, { at: ++at, of }, chosen))
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
async function mountOne(
  deps: SourcesFlowDeps,
  read: () => Promise<string>,
  id: SourceId,
  platform: NodeJS.Platform,
  cancelled: () => boolean,
  step: Step,
  chosen: Chosen,
): Promise<string> {
  const notes: string[] = []
  const recorded = { ...deps, host: recording(deps.host, notes) }
  // Soda Music has one road and is asked nothing: its entry is minted by the
  // scan itself, so there is no browser to offer and a one-row card is noise.
  // Said before either road runs, so it frames the result whichever way the
  // listener signs in.
  if (id === 'qqmusic') recorded.host.info(QQMUSIC_VIP_NOTE)
  if (id === 'qishui') await mountQrFlow(recorded, id, cancelled, step)
  else {
    const how = await askSignIn(recorded, read, id, chosen.profile, cancelled)
    if (how === null) return stoppedRow(id)
    if (how.kind === 'chrome') chosen.profile = how.profile
    if (how.kind === 'scan') await mountQrFlow(recorded, id as QrSource, cancelled, step)
    else if (id === 'spotify') await mountSpotifyFlow(recorded, cancelled, how.profile)
    else await mountCookieFlow(recorded, read, id as CookieSource, platform, cancelled, how.profile)
  }
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
  profile: string,
): Promise<void> {
  const { host } = deps
  const site = SOURCE_NAMES[id]
  // The profile the listener picked on the card, pinned into the entry by the
  // mount and read by every refresh after it — never resolved a second time.
  const pick = { browser: CHROME, profile }
  host.info(`checking ${site} in Chrome...`)
  type CookieMount = MountResult<YouTubeEntry | NeteaseEntry | BilibiliEntry | QQMusicEntry>
  const attempt = async (): Promise<CookieMount | null> => {
    try {
      return await deps.mounts.browser[id](pick)
    } catch (err) {
      // NetEase answers an expired cookie with `code: 301`, which the client
      // raises rather than returns. It is the same "no login here" the
      // no-login road exists for — reported as "could not reach", it left
      // the listener with no sign-in page and nothing to do (codex review).
      if (err instanceof SourceAuthError && err.reason === 'login-required') return { ok: false, reason: 'login-required' }
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
  // Esc pressed while the cookie export or the account read was in flight:
  // the read succeeded, but the listener asked to stop, and "stopped —
  // nothing was written" has to mean it — as it already does on the scan
  // road (codex review).
  if (cancelled() || deps.quit.requested) return
  if (id === 'youtube') await finishMount(deps, 'youtube', result.who, result.entry as YouTubeEntry)
  else if (id === 'netease') await finishMount(deps, 'netease', result.who, result.entry as NeteaseEntry)
  else if (id === 'qqmusic') await finishMount(deps, 'qqmusic', result.who, result.entry as QQMusicEntry)
  else await finishMount(deps, 'bilibili', result.who, result.entry as BilibiliEntry)
}

async function mountSpotifyFlow(deps: SourcesFlowDeps, cancelled: () => boolean, profile: string): Promise<void> {
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
      // The consent page opens in the profile the card chose, so the account
      // it offers is the one the listener meant. No cookie is read from it.
      ...(deps.openUrl !== undefined && { openUrl: (url: string) => deps.openUrl?.(url, profile) }),
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
async function mountQrFlow(deps: SourcesFlowDeps, id: QrSource, cancelled: () => boolean, step: Step): Promise<void> {
  const { host } = deps
  const name = SOURCE_NAMES[id]
  // The QR is an authorization artifact, and it is 21 to 25 rows tall: it
  // goes to the notice CARD only (spec 10 §3.2-E) — never through `info`,
  // which the diagnostics keep (§3.6) and which the program log scrolls, so
  // a listener back from their phone found half a code and no instruction
  // above it. A host without that surface cannot be handed the code at all.
  const notice = host.notice?.bind(host)
  if (notice === undefined) {
    host.info(`I cannot show the code here — run murmur in a terminal front-end to mount ${name}.`)
    return
  }
  host.info(QR_LINES[id])
  const title = `${step.of > 1 ? `${step.at}/${step.of} ` : ''}${name} — scan with ${QR_APPS[id]}`
  // Kept so the status change can redraw the same code under a new footer.
  let code: readonly string[] = []
  let result: QrMountResult<NeteaseEntry> | QrMountResult<BilibiliEntry> | QrMountResult<QQMusicEntry> | QishuiMountResult
  try {
    result = await deps.mounts[id](
      (url) => {
        code = qrHalfBlocks(url)
        notice(title, code, QR_WAITING)
      },
      cancelled,
      (status) => {
        if (status === 'scanned') notice(title, code, QR_SCANNED)
      },
    )
  } catch (err) {
    host.info(`could not reach ${name} (${err instanceof Error ? err.message : String(err)}) — /sources to try again.`)
    return
  } finally {
    // However it ended, the code is dead: an expired one left on screen is
    // an invitation to keep scanning it.
    notice(title, [])
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
  else if (id === 'qqmusic') await finishMount(deps, 'qqmusic', result.who, result.entry as QQMusicEntry)
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
