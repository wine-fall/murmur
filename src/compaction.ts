// Periodic profile compaction, off the live loop (spec 05 §3.6).
//
// The Compactor watches the persistent store's backlog and folds it into the
// long-term profile via the Brain seam — single-flight and in the background,
// so it never blocks a segment. Failure is inert: the store only advances
// profile + watermark on a successful apply, so a failed fold costs one log
// line and the backlog is retried next time. A stub Brain makes the fold a
// no-op (its compactProfile returns the profile unchanged).

import type { Brain, Turn } from './contracts.ts'

// The store's compaction surface (spec 05 §2.1) — impl-level, deliberately not
// on the MemoryStore contract: the Director never drives compaction.
export interface CompactionStore {
  compactionDue(): boolean
  compactionSlice(): { profile: string; turns: Turn[]; throughTs: number }
  applyCompaction(newProfile: string, throughTs: number): void
}

type Fold = { promise: Promise<void>; done: () => boolean }

// How long a shutdown flush may wait on the model before it gives up. A fold
// is a full model call — measured at 53 s on a real run — so this is not a
// generous version of "wait for it": it is only long enough to collect a fold
// that was already nearly done, and Ctrl-C must feel like stopping.
const FLUSH_TIMEOUT_MS = 3_000

export class Compactor {
  private store: CompactionStore
  private brain: Pick<Brain, 'compactProfile'>
  private log: (message: string) => void
  private fold: Fold | null = null

  constructor(
    store: CompactionStore,
    brain: Pick<Brain, 'compactProfile'>,
    log: (message: string) => void = () => {},
  ) {
    this.store = store
    this.brain = brain
    this.log = log
  }

  // If the backlog crossed the threshold and nothing is in flight, launch one
  // background fold. Returns whether it launched one.
  maybeSchedule(): boolean {
    if (!this.store.compactionDue()) return false
    return this.launch()
  }

  // Force a fold of any remaining backlog, regardless of the threshold
  // (shutdown / startup catch-up). Drains a fold already in flight first — its
  // slice predates the current tail — then folds what is left, so turns
  // recorded during that fold are not stranded until a future run.
  // Bounded two ways, so a persistently-failing fold can never spin here and a
  // slow one can never hold the process open: two rounds, and a wall-clock
  // budget. Losing the fold costs nothing — the turns are already on disk and
  // the watermark only advances on a successful apply, so the next run folds
  // them again. Overrunning the budget abandons the wait, not the fold: a
  // promise cannot be cancelled, so it keeps running — and its SDK subprocess
  // does not hold the process open, because main.ts exits explicitly rather
  // than waiting for the loop to drain (the same disposal the in-flight music
  // pick already relies on; measured: 3.5 s from Ctrl-C to exit).
  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    await Promise.race([
      this.foldRemaining(),
      // .unref(): the bound must never be the thing keeping the loop alive.
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ])
  }

  private async foldRemaining(): Promise<void> {
    await this.drain()
    if (this.store.compactionSlice().turns.length > 0) {
      this.launch()
      await this.drain()
    }
  }

  // Await the in-flight fold, if any (shutdown / tests).
  async drain(): Promise<void> {
    await this.fold?.promise
    this.fold = null
  }

  private launch(): boolean {
    if (this.fold !== null && !this.fold.done()) return false
    let settled = false
    this.fold = {
      promise: this.run().finally(() => (settled = true)),
      done: () => settled,
    }
    return true
  }

  // Total (never rejects): the fold runs unawaited in the background, so any
  // escape here — Brain failure OR a filesystem error in apply — would be an
  // unhandled rejection that takes the radio down instead of degrading.
  private async run(): Promise<void> {
    const { profile, turns, throughTs } = this.store.compactionSlice()
    if (turns.length === 0) return
    try {
      const updated = await this.brain.compactProfile(profile, turns)
      this.store.applyCompaction(updated, throughTs)
      this.log(`memory: compacted ${turns.length} turns into a ${updated.length}-char profile`)
    } catch (err) {
      this.log(`memory: compaction failed; keeping profile + watermark (${String(err)})`)
    }
  }
}
