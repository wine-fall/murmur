// The refresh policy (spec 14 §3.4/§3.5): keep each mounted source's
// snapshot fresh on a fixed clock, off the live loop. The Director pokes
// maybeRefresh once the broadcast has settled and never awaits it; the
// /sources conversation calls refreshAll in the foreground. A failed read
// keeps the last snapshot — a listener who stopped refreshing still has a
// taste — and an auth failure goes through the same watch a failed pick does.

import type { Host } from '../../host/host.ts'
import { SourceAuthError, SourceAuthWatch } from './auth.ts'
import { BrowserCookieError } from './cookies.ts'
import { emptyLedger, mergeLedger } from './ledger.ts'
import type { SourcesStore } from './store.ts'
import { mergeSnapshot, SOURCE_NAMES, type SourceId, type TasteKind, type TasteSource } from './taste.ts'

export const STALE_MS = 24 * 60 * 60_000
// What the listener is on RIGHT NOW is a different question from what they
// have collected (spec 14 §3.4). An afternoon's listening should reach the
// evening's picks, while a liked collection moves on the scale of days --
// and one clock for both meant either a stale afternoon or eight needless
// collection reads a day.
export const FRESH_MS = 3 * 60 * 60_000
const FRESH_KINDS: readonly TasteKind[] = ['history', 'subscription', 'daily']
export const staleMs = (kind: TasteKind): number => (FRESH_KINDS.includes(kind) ? FRESH_MS : STALE_MS)
// A read that failed is not tried again before this: a dead platform or a
// rate limit must not be hit at every segment boundary.
export const RETRY_MS = 60 * 60_000
// Past this, a snapshot that cannot be refreshed is named on screen (§3.7).
const OLD_MS = 30 * 24 * 60 * 60_000

export type RefreshOutcome = { id: SourceId; ok: true; count: number } | { id: SourceId; ok: false; error: string }

export type TasteRefresherDeps = {
  store: SourcesStore
  // The live adapter for a mounted source; null when the entry cannot be
  // turned into one (an unknown shape) — then there is nothing to read.
  source: (id: SourceId) => TasteSource | null
  watch: SourceAuthWatch
  host: Pick<Host, 'info' | 'debug'>
  now?: () => Date
}

export class TasteRefresher {
  private deps: TasteRefresherDeps
  private running: Promise<unknown> | null = null
  private saidOld = new Set<SourceId>()
  // When each source was last tried, success or failure — in memory, so a
  // restart tries again at once.
  private tried = new Map<SourceId, number>()

  constructor(deps: TasteRefresherDeps) {
    this.deps = deps
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  // Which of a source's lists are due: each on its own clock, from the
  // read stamps the ledger carries (spec 14 §2.11). A list never read is
  // due, which on a fresh mount is every list and then the new clock.
  private due(id: SourceId): TasteKind[] {
    const source = this.deps.source(id)
    if (source === null) return []
    // The stamps are the authority: a list with none has never been read and
    // is due, which on a fresh mount is every list. The snapshot and the
    // ledger are dropped together (`dropSnapshot`), so one cannot outlive
    // the other and leave a stamp claiming a read whose rows are gone.
    const lastRead = this.deps.store.readLedger(id)?.lastRead ?? {}
    const now = this.now().getTime()
    return source.kinds.filter((kind) => {
      const at = new Date(lastRead[kind] ?? '').getTime()
      return !Number.isFinite(at) || now - at > staleMs(kind)
    })
  }

  // Which mounted sources have anything due — never one whose login is known
  // to be gone (only /sources renews that), and never one tried within the
  // retry window, whatever the kind.
  private stale(): SourceId[] {
    const file = this.deps.store.read()
    const now = this.now().getTime()
    return this.deps.store.mounted().filter((id) => {
      if (file[id]?.status === 'expired') return false
      const tried = this.tried.get(id)
      if (tried !== undefined && now - tried < RETRY_MS) return false
      return this.due(id).length > 0
    })
  }

  // The background poke. True when a refresh started; false when one is
  // already running, the conversation holds the store, or nothing is due.
  maybeRefresh(): boolean {
    if (this.running !== null || this.deps.store.busy) return false
    const due = this.stale()
    if (due.length === 0) return false
    this.run(due)
    return true
  }

  // The foreground refresh (a typed /sources refresh): every mounted source,
  // stale or not, awaited, with its outcomes.
  async refreshAll(): Promise<RefreshOutcome[]> {
    if (this.running !== null) await this.running.catch(() => {})
    return this.run(this.deps.store.mounted(), false)
  }

  private run(ids: readonly SourceId[], partial = true): Promise<RefreshOutcome[]> {
    const work = (async () => {
      const outcomes: RefreshOutcome[] = []
      // The background poke reads only what is due; a typed /sources refresh
      // is the listener asking for everything, so it narrows nothing.
      for (const id of ids) outcomes.push(await this.refreshOne(id, partial ? this.due(id) : undefined))
      return outcomes
    })()
    this.running = work.finally(() => (this.running = null))
    return work
  }

  private async refreshOne(id: SourceId, kinds?: readonly TasteKind[]): Promise<RefreshOutcome> {
    const { store, host, watch } = this.deps
    // An expired login is renewed by mounting again, never by re-reading:
    // some platforms serve public lists anonymously, and a read that
    // "works" would flip the status back to ok on a login that is gone.
    if (store.read()[id]?.status === 'expired') return { id, ok: false, error: 'expired' }
    const source = this.deps.source(id)
    if (source === null) return { id, ok: false, error: 'no adapter for this entry' }
    this.tried.set(id, this.now().getTime())
    // The mounts as they stand now: the conversation may unmount — or
    // unmount and mount a different account — while this read is in flight,
    // and a snapshot for the account that is gone must not land on the one
    // that replaced it.
    const epoch = store.epoch
    const t = performance.now()
    try {
      const read = await source.snapshot(kinds)
      // Only the kinds that were asked for. An adapter whose endpoint is
      // mixed answers with more than it was asked for (Soda's collection
      // carries kept playlist names beside kept tracks), and mergeSnapshot
      // would then keep the old rows of that kind beside the new ones.
      const snapshot = kinds === undefined ? read : { ...read, items: read.items.filter((i) => kinds.includes(i.kind)) }
      if (store.epoch !== epoch || !store.mounted().includes(id)) return { id, ok: false, error: 'unmounted' }
      // The snapshot is the latest read of each list; the ledger is every
      // read there has ever been (spec 14 §2.11).
      store.writeSnapshot(mergeSnapshot(store.readSnapshot(id), snapshot, kinds))
      store.writeLedger(mergeLedger(store.readLedger(id) ?? emptyLedger(id), snapshot, kinds ?? source.kinds))
      store.markRefreshed(id, this.now())
      // The read worked, so the profile it used is the one this account lives
      // in: pin it (spec 14 §3.1). A mount made before murmur named profiles
      // gets its pin here; from then on nothing re-guesses.
      store.pinChromeProfile(id)
      // A read that works clears an error left by an earlier failure, and
      // the once-per-session line re-arms.
      if (store.read()[id]?.status === 'error') {
        store.setStatus(id, 'ok')
        watch.reset(id)
      }
      // Counts and time only — never a title (§3.6).
      host.debug?.(`sources.refresh ${id} n=${snapshot.items.length} ${Math.round(performance.now() - t)}ms`)
      return { id, ok: true, count: snapshot.items.length }
    } catch (err) {
      if (store.epoch !== epoch || !store.mounted().includes(id)) return { id, ok: false, error: 'unmounted' }
      // The pinned profile is gone — deleted or renamed. murmur does not
      // quietly move the mount to another one: that is how it would change
      // account behind the listener's back. It takes the same road as a lost
      // login, so the /sources card says to connect it again (§3.1).
      if (err instanceof BrowserCookieError && err.reason === 'no-profile') {
        watch.note(new SourceAuthError(id, 'expired', `chrome profile ${err.profile ?? ''} is gone`))
        return { id, ok: false, error: 'no-profile' }
      }
      if (err instanceof SourceAuthError) {
        watch.note(err)
        return { id, ok: false, error: err.reason }
      }
      const message = err instanceof Error ? err.message : String(err)
      host.debug?.(`sources.refresh ${id} failed: ${message}`)
      this.noteOld(id)
      return { id, ok: false, error: message }
    }
  }

  // The §3.7 line for a snapshot past thirty days whose refresh keeps
  // failing: said once per session per source.
  private noteOld(id: SourceId): void {
    const snapshot = this.deps.store.readSnapshot(id)
    if (snapshot === null || this.saidOld.has(id)) return
    if (this.now().getTime() - new Date(snapshot.takenAt).getTime() <= OLD_MS) return
    this.saidOld.add(id)
    this.deps.host.info(`still going on what I knew about your ${SOURCE_NAMES[id]} music as of ${snapshot.takenAt.slice(0, 10)}.`)
  }
}
