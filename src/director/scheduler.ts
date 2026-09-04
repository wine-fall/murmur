// Time anchors (spec 07 §2.3): good-morning / midday / good-night as fixed
// programming layered on the stream. Each fires at the first segment boundary
// inside its window, at most once per ANCHOR DAY, and survives a restart —
// the fired-history lives in the spec-05 tier-③ ledger, not in Director memory.
//
// Same shape as scene.ts: pure bucketing over an injected clock, boundaries
// unit-pinned.

import type { MemoryStore } from '../contracts.ts'

export const ANCHOR_IDS = ['morning', 'midday', 'night'] as const

export type AnchorId = (typeof ANCHOR_IDS)[number]

export interface Scheduler {
  // The anchor due right now, or null.
  due(now: Date): AnchorId | null
  // Record that an anchor aired.
  markFired(id: AnchorId, now: Date): void
}

// Local minutes-of-day, [start, end). `night` wraps past midnight (end <=
// start), like sceneFor's late-night bucket. By-ear tunable (spec 07 §6).
const WINDOWS: Record<AnchorId, readonly [number, number]> = {
  morning: [6 * 60, 10 * 60],
  midday: [11 * 60 + 30, 14 * 60],
  night: [22 * 60, 1 * 60],
}

// How far back to look for an already-fired occurrence. A handful of anchors a
// day, so this comfortably covers the current and previous anchor days.
const ANCHOR_DEPTH = 8

const minutesOfDay = (now: Date) => now.getHours() * 60 + now.getMinutes()

const wraps = ([start, end]: readonly [number, number]) => end <= start

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// The identity of ONE occurrence of an anchor: the local date its window
// OPENED, not the date it aired on. `night` runs 22:00-01:00, so keying by the
// air date would let 23:10 fire it and 00:30 fire it again eighty minutes
// later — both "once per calendar day" by the letter. due() and markFired()
// both route through here, so the read and the write can never disagree.
export function anchorDay(id: AnchorId, now: Date): string {
  const window = WINDOWS[id]
  if (wraps(window) && minutesOfDay(now) < window[1]) {
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    return localDate(yesterday)
  }
  return localDate(now)
}

// The anchor whose window contains `now`, or null. Pure.
export function anchorFor(now: Date): AnchorId | null {
  const minute = minutesOfDay(now)
  for (const id of ANCHOR_IDS) {
    const [start, end] = WINDOWS[id]
    const inside = wraps(WINDOWS[id]) ? minute >= start || minute < end : minute >= start && minute < end
    if (inside) return id
  }
  return null
}

export class LedgerScheduler implements Scheduler {
  private memory: Pick<MemoryStore, 'recordEvent' | 'recentAnchors'>

  constructor(memory: Pick<MemoryStore, 'recordEvent' | 'recentAnchors'>) {
    this.memory = memory
  }

  due(now: Date): AnchorId | null {
    const id = anchorFor(now)
    if (id === null) return null
    return this.memory.recentAnchors(ANCHOR_DEPTH).includes(key(id, now)) ? null : id
  }

  markFired(id: AnchorId, now: Date): void {
    this.memory.recordEvent('anchor', key(id, now))
  }
}

const key = (id: AnchorId, now: Date) => `${id}@${anchorDay(id, now)}`
