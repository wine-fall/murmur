import { describe, expect, it } from 'vitest'

import { InProcessMemoryStore } from '../src/memory.ts'

describe('InProcessMemoryStore', () => {
  it('returns the last n turns oldest-first', () => {
    const store = new InProcessMemoryStore()
    store.record({ role: 'radio', text: 'a' })
    store.record({ role: 'user', text: 'b' })
    store.record({ role: 'radio', text: 'c' })
    expect(store.recent(2).map((t) => t.text)).toEqual(['b', 'c'])
    expect(store.recent(10).map((t) => t.text)).toEqual(['a', 'b', 'c'])
  })

  it('returns empty for non-positive n', () => {
    const store = new InProcessMemoryStore()
    store.record({ role: 'radio', text: 'a' })
    expect(store.recent(0)).toEqual([])
    expect(store.recent(-1)).toEqual([])
  })

  it('bounds retained history to maxlen', () => {
    const store = new InProcessMemoryStore(3)
    for (const text of ['1', '2', '3', '4', '5']) store.record({ role: 'radio', text })
    expect(store.recent(10).map((t) => t.text)).toEqual(['3', '4', '5'])
  })
})
