// The refresh policy (spec 14 §3.4/§3.5): keep each mounted source's
// snapshot fresh on a fixed clock, off the live loop. The Director pokes
// maybeRefresh once the broadcast has settled and never awaits it; the
// /sources conversation calls refreshAll in the foreground. A failed read
// keeps the last snapshot — a listener who stopped refreshing still has a
// taste — and an auth failure goes through the same watch a failed pick does.

import type { Host } from '../../host/host.ts'
import { SourceAuthError, SourceAuthWatch } from './auth.ts'
import type { SourcesStore } from './store.ts'
import { SOURCE_NAMES, type SourceId, type TasteSource } from './taste.ts'

export const STALE_MS = 24 * 60 * 60_000
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

  constructor(deps: TasteRefresherDeps) {
    this.deps = deps
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  // Which mounted sources are due: no snapshot yet, or last read over a day ago.
  private stale(): SourceId[] {
    const file = this.deps.store.read()
    const now = this.now().getTime()
    return this.deps.store.mounted().filter((id) => {
      if (this.deps.store.readSnapshot(id) === null) return true
      const stamp = file[id]?.lastRefresh ?? file[id]?.mountedAt ?? ''
      const at = new Date(stamp).getTime()
      return !Number.isFinite(at) || now - at > STALE_MS
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
    return this.run(this.deps.store.mounted())
  }

  private run(ids: readonly SourceId[]): Promise<RefreshOutcome[]> {
    const work = (async () => {
      const outcomes: RefreshOutcome[] = []
      for (const id of ids) outcomes.push(await this.refreshOne(id))
      return outcomes
    })()
    this.running = work.finally(() => (this.running = null))
    return work
  }

  private async refreshOne(id: SourceId): Promise<RefreshOutcome> {
    const { store, host, watch } = this.deps
    const source = this.deps.source(id)
    if (source === null) return { id, ok: false, error: 'no adapter for this entry' }
    const t = performance.now()
    try {
      const snapshot = await source.snapshot()
      store.writeSnapshot(snapshot)
      store.markRefreshed(id, this.now())
      // A read that works is a login that works: a status left behind by an
      // earlier failure clears, and the once-per-session line re-arms.
      if (store.read()[id]?.status !== 'ok') {
        store.setStatus(id, 'ok')
        watch.reset(id)
      }
      // Counts and time only — never a title (§3.6).
      host.debug?.(`sources.refresh ${id} n=${snapshot.items.length} ${Math.round(performance.now() - t)}ms`)
      return { id, ok: true, count: snapshot.items.length }
    } catch (err) {
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
