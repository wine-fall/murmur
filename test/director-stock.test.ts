// The stock-line hand-off at the boundary (spec 04 §3.6): the opener beats live
// in a queue of their own, ahead of nothing and behind every live beat, so the
// program speaks while the cold batch is still thinking.

import { describe, expect, it } from 'vitest'

import { Director, type DirectorDeps } from '../src/director/director.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import type { StockBeat } from '../src/support/stock.ts'
import { directorSettings, FakeBrain, FakeHost, FakePlayer, FakeVoice, until } from './fakes.ts'

// What boot did NOT air: beat 1 went out before the Director existed, so the
// owed beats start at 2.
function stockBeats(...texts: string[]): StockBeat[] {
  return texts.map((text, i) => ({ text, clip: { source: `/stock/opener-${i + 2}.wav`, kind: 'talk' as const } }))
}

function setup(over: Partial<DirectorDeps> & { gapSeconds?: number } = {}) {
  const { gapSeconds = 0, ...rest } = over
  const brain = new FakeBrain()
  const voice = new FakeVoice()
  const player = new FakePlayer()
  const host = new FakeHost()
  const memory = new InProcessMemoryStore()
  const knobs = directorSettings({ gapSeconds })
  const director = new Director({
    persona: 'p',
    brain,
    voice,
    player,
    memory,
    host,
    settings: () => knobs,
    openUrl: () => {},
    ...rest,
  })
  return { brain, voice, player, host, memory, knobs, director }
}

function fakeStock(owed: StockBeat[], openedAtBoot = true) {
  const stock = { owed, openedAtBoot, refreshes: 0, maybeRefresh: (): void => void (stock.refreshes += 1) }
  return stock
}

describe('the stock hand-off (spec 04 §3.6)', () => {
  it('airs a stock beat instead of waiting on the cold batch, and fires the batch behind it', async () => {
    const stock = fakeStock(stockBeats('stock two', 'stock three'))
    const { brain, player, host, director, voice } = setup({ stock })
    brain.batches = [['live one', 'live two']]
    brain.nextTalksDelayMs = 40
    await director.run(1)
    expect(player.played.map((c) => c.source)).toEqual(['/stock/opener-2.wav'])
    // Nothing was synthesized for it — the wav was already on disk.
    expect(voice.synthesized).toEqual([])
    expect(host.debugs).toContain('stock.opener aired n=2')
    // The live batch went out behind it rather than being skipped.
    await until(() => brain.nextTalksCalls === 1, 'the cold batch fired')
  })

  it('a ready live beat beats the stock queue, and the hand-off names the beat it landed on', async () => {
    const stock = fakeStock(stockBeats('stock two', 'stock three'))
    const { brain, host, director } = setup({ stock })
    brain.batches = [['live one', 'live two'], ['live three']]
    await director.run(2)
    // Boundary 1 has no live beat yet (the batch is only fired behind the stock
    // beat); boundary 2 does, so the stock's third beat is never spent.
    expect(host.radio).toEqual(['stock two', 'live one'])
    expect(host.debugs).toContain('stock.handoff live at beat 3')
  })

  it('drops what is left of the opener once a live beat has caught up', async () => {
    const stock = fakeStock(stockBeats('stock two', 'stock three'))
    const { brain, host, director } = setup({ stock })
    // The refill comes back empty once, so the buffer is genuinely dry at the
    // third boundary — and an OPENING line must not air in the middle of a
    // sitting (nor read audio the refresh is busy rewriting under it).
    brain.batches = [['live one'], [], ['live two']]
    await director.run(3)
    expect(host.radio).toEqual(['stock two', 'live one', 'live two'])
  })

  it('with the stock queue empty the boundary waits exactly as today', async () => {
    const stock = fakeStock([], false)
    const { brain, host, director } = setup({ stock })
    brain.batches = [['live one', 'live two']]
    await director.run(1)
    expect(host.radio).toEqual(['live one'])
    expect(host.debugs.some((d) => d.startsWith('stock.'))).toBe(false)
  })

  it('a typed line discards the stock queue with the look-ahead', async () => {
    const stock = fakeStock(stockBeats('stock two', 'stock three'))
    const { brain, host, player, director } = setup({ stock })
    brain.batches = [['live one', 'live two'], ['after you']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.playing, 'the first stock beat is on the air')
    host.type('are you there')
    player.auto = true
    player.finish()
    await until(() => host.radio.includes('re:are you there'), 'the reply aired')
    await run
    // The beat on the air plays out; the rest of the stock predates the
    // listener's turn and is dropped with the look-ahead.
    expect(host.radio).toContain('stock two')
    expect(host.radio).not.toContain('stock three')
  })

  it('records the aired stock beat and opens the first live batch from it', async () => {
    const stock = fakeStock(stockBeats('stock two'))
    const { brain, memory, director } = setup({ stock })
    brain.batches = [['live one'], ['live two']]
    await director.run(2)
    expect(memory.recent(5).map((t) => t.text)).toEqual(['stock two', 'live one'])
    // The cold batch is fired with the stock beats it has NOT aired yet in
    // context, and told the program is opening with them.
    const cold = brain.talkContexts[0]!
    expect(cold.opening).toBe(true)
    expect(cold.recent.map((t) => t.text)).toEqual(['stock two'])
  })

  it('pokes the refresh once a LIVE beat has aired, never behind a stock one', async () => {
    const stock = fakeStock(stockBeats('stock two', 'stock three'))
    const { brain, director } = setup({ stock })
    brain.batches = [['live one', 'live two'], ['live three']]
    await director.run(1)
    expect(stock.refreshes).toBe(0)
    await director.run(1)
    expect(stock.refreshes).toBe(1)
  })
})
