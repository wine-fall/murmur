// In-process MemoryStore (spec 01 §2.4): a session-only turn log bounded to
// the last N turns. The unit-layer fake and the store for stub runs; the
// persistent three-tier store is Phase 4 (spec 05).

import type { MemoryStore, Turn } from './contracts.ts'

export class InProcessMemoryStore implements MemoryStore {
  private turns: Turn[] = []

  private maxlen: number

  constructor(maxlen = 256) {
    this.maxlen = maxlen
  }

  record(turn: Turn): void {
    this.turns.push(turn)
    if (this.turns.length > this.maxlen) this.turns.splice(0, this.turns.length - this.maxlen)
  }

  recent(n: number): Turn[] {
    if (n <= 0) return []
    return this.turns.slice(-n)
  }
}
