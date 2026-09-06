import { describe, expect, it } from 'vitest'

import { Compactor, type CompactionStore } from '../src/memory/compaction.ts'
import type { Turn } from '../src/contracts.ts'
import { until } from './fakes.ts'

// A minimal in-memory stand-in for the store's compaction surface.
class FakeCompactionStore implements CompactionStore {
  profile = ''
  backlog: { ts: number; turn: Turn }[] = []
  every = 3
  applied: { profile: string; throughTs: number }[] = []

  push(text: string, ts: number): void {
    this.backlog.push({ ts, turn: { role: 'radio', text } })
  }

  compactionDue(): boolean {
    return this.backlog.length >= this.every
  }

  compactionSlice(): { profile: string; turns: Turn[]; throughTs: number } {
    return {
      profile: this.profile,
      turns: this.backlog.map((b) => b.turn),
      throughTs: this.backlog.at(-1)?.ts ?? 0,
    }
  }

  failApply = false

  applyCompaction(newProfile: string, throughTs: number): void {
    if (this.failApply) throw new Error('disk full')
    this.applied.push({ profile: newProfile, throughTs })
    this.profile = newProfile
    this.backlog = this.backlog.filter((b) => b.ts > throughTs)
  }
}

// Scripted compactProfile: blocks until released, so tests control fold timing.
class FakeCompactBrain {
  calls: { profile: string; turns: readonly Turn[] }[] = []
  fail = false
  private release: (() => void) | null = null

  async compactProfile(profile: string, transcript: readonly Turn[]): Promise<string> {
    this.calls.push({ profile, turns: transcript })
    if (this.release !== null) throw new Error('overlapping folds')
    await new Promise<void>((resolve) => (this.release = resolve))
    this.release = null
    if (this.fail) throw new Error('brain down')
    return `folded:${transcript.length}`
  }

  finish(): void {
    this.release?.()
  }

  get folding(): boolean {
    return this.release !== null
  }
}

function setup() {
  const store = new FakeCompactionStore()
  const brain = new FakeCompactBrain()
  const logs: string[] = []
  const compactor = new Compactor(store, brain, (m) => logs.push(m))
  return { store, brain, logs, compactor }
}

describe('Compactor', () => {
  it('does nothing below the threshold', async () => {
    const { store, brain, compactor } = setup()
    store.push('a', 1)
    expect(compactor.maybeSchedule()).toBe(false)
    await compactor.drain()
    expect(brain.calls.length).toBe(0)
  })

  it('folds the slice in the background and applies exactly its throughTs', async () => {
    const { store, brain, compactor } = setup()
    for (const [i, t] of ['a', 'b', 'c'].entries()) store.push(t, i + 1)
    expect(compactor.maybeSchedule()).toBe(true)
    await until(() => brain.folding, 'fold started')
    // A turn recorded while the fold is in flight stays in the next backlog.
    store.push('late', 99)
    brain.finish()
    await compactor.drain()
    expect(store.applied).toEqual([{ profile: 'folded:3', throughTs: 3 }])
    expect(store.backlog.map((b) => b.turn.text)).toEqual(['late'])
  })

  it('is single-flight, and can schedule again after a fold settles', async () => {
    const { store, brain, compactor } = setup()
    for (const [i, t] of ['a', 'b', 'c'].entries()) store.push(t, i + 1)
    expect(compactor.maybeSchedule()).toBe(true)
    expect(compactor.maybeSchedule()).toBe(false)
    await until(() => brain.folding, 'fold started')
    brain.finish()
    await compactor.drain()
    for (const [i, t] of ['d', 'e', 'f'].entries()) store.push(t, i + 10)
    expect(compactor.maybeSchedule()).toBe(true)
    await until(() => brain.folding, 'second fold')
    brain.finish()
    await compactor.drain()
    expect(store.applied.length).toBe(2)
  })

  it('a failed fold leaves profile and watermark untouched, logs once', async () => {
    const { store, brain, logs, compactor } = setup()
    brain.fail = true
    for (const [i, t] of ['a', 'b', 'c'].entries()) store.push(t, i + 1)
    compactor.maybeSchedule()
    await until(() => brain.folding, 'fold started')
    brain.finish()
    await compactor.drain()
    expect(store.applied).toEqual([])
    expect(store.backlog.length).toBe(3)
    expect(logs.some((l) => l.includes('compaction failed'))).toBe(true)
  })

  it('a store-apply failure (disk full) degrades like a brain failure, never rejects', async () => {
    const { store, brain, logs, compactor } = setup()
    store.failApply = true
    for (const [i, t] of ['a', 'b', 'c'].entries()) store.push(t, i + 1)
    compactor.maybeSchedule() // unawaited background fold, like the Director's poke
    await until(() => brain.folding, 'fold started')
    brain.finish()
    await compactor.drain() // must not throw
    expect(store.applied).toEqual([])
    expect(logs.some((l) => l.includes('compaction failed'))).toBe(true)
  })

  it('flush folds a below-threshold tail, draining an in-flight fold first', async () => {
    const { store, brain, compactor } = setup()
    for (const [i, t] of ['a', 'b', 'c'].entries()) store.push(t, i + 1)
    compactor.maybeSchedule()
    await until(() => brain.folding, 'fold started')
    store.push('tail', 50)
    const flushed = compactor.flush()
    brain.finish() // settle the in-flight fold (slice a..c)
    await until(() => store.applied.length === 1, 'first apply')
    await until(() => brain.folding, 'tail fold')
    brain.finish() // settle the tail fold
    await flushed
    expect(store.applied.map((a) => a.throughTs)).toEqual([3, 50])
    expect(store.backlog).toEqual([])
  })

  it('flush with nothing pending is a no-op', async () => {
    const { brain, compactor } = setup()
    await compactor.flush()
    expect(brain.calls.length).toBe(0)
  })

  // Ctrl-C landed here: the shutdown flush launches a real compactProfile, and
  // a measured run spent 53 s inside it while the user waited for the process
  // to die. The budget makes "never blocks exit" true instead of aspirational.
  it('flush gives up when the fold outlives its budget, and applies nothing', async () => {
    const { store, brain, compactor } = setup()
    for (const [i, text] of ['a', 'b'].entries()) store.push(text, i + 1)

    await compactor.flush(20) // the brain is never released — it hangs forever

    expect(store.applied).toEqual([])
    expect(store.backlog).toHaveLength(2) // the turns survive for the next run
    expect(brain.folding).toBe(true) // abandoned, not cancelled: promises cannot be
  })

  it('flush still completes a fold that finishes inside its budget', async () => {
    const { store, brain, compactor } = setup()
    store.push('a', 1)

    const flushed = compactor.flush(5_000)
    await until(() => brain.folding, 'fold started')
    brain.finish()
    await flushed

    expect(store.applied.map((a) => a.throughTs)).toEqual([1])
  })
})
