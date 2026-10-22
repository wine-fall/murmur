// The Director's side of spec 13 (§2.4) after spec 15: the refresh poked at
// every boundary and never awaited; the talk path itself never offers an item
// (programs carry them, spec 15 §2.1).
import { describe, expect, it } from 'vitest'

import { Director, type DirectorDeps } from '../src/director/director.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import { directorSettings, FakeBrain, FakeHost, FakeMixingPlayer, FakeVoice } from './fakes.ts'

class FakeRwt {
  refreshes = 0

  maybeRefresh(): boolean {
    this.refreshes++
    return false
  }
}

function build(over: Partial<DirectorDeps> & { rwtEnabled?: boolean; player?: FakeMixingPlayer } = {}) {
  const { rwtEnabled = true, player = new FakeMixingPlayer(), ...rest } = over
  const brain = new FakeBrain()
  const host = new FakeHost()
  const rwt = new FakeRwt()
  const knobs = directorSettings({ gapSeconds: 0, rwtEnabled })
  const memory = new InProcessMemoryStore()
  const deps: DirectorDeps = {
    persona: 'p',
    brain,
    voice: new FakeVoice(),
    player,
    memory,
    host,
    settings: () => knobs,
    openUrl: () => {},
    rwt,
    ...rest,
  }
  return { brain, host, player, rwt, knobs, memory, director: new Director(deps) }
}

describe('real-world topics on the talk path (spec 13 §2.4)', () => {
  it('a free beat never carries an item, and nothing is ledgered', async () => {
    const { brain, memory, director } = build()
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(2)
    for (const ctx of brain.talkContexts) expect(ctx).not.toHaveProperty('rwt')
    expect(memory.recentRwt(10)).toEqual([])
  })

  it('the refresh is poked at every boundary', async () => {
    const { brain, rwt, director } = build()
    brain.batches = [['a', 'b', 'c']]
    await director.run(3)
    expect(rwt.refreshes).toBeGreaterThanOrEqual(3)
  })
})
