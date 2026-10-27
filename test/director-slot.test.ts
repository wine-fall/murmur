// The slot rule at the Director seam (spec 14 §3.10 step 5): whether this
// pick may play something the listener already knows is drawn from a shuffled
// deck BEFORE the task starts, said in the situation, and carried as data so
// submit_pick can enforce what the prompt only asks for.
import { describe, expect, it } from 'vitest'

import { EveryNCadence } from '../src/director/cadence.ts'
import type { SteerBrain } from '../src/contracts.ts'
import { Director, type DirectorDeps } from '../src/director/director.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import { directorSettings, FakeBrain, FakeHost, FakeMixingPlayer, FakePlayer, FakeTrackSource, FakeVoice, pickOf, until } from './fakes.ts'

function setup(over: Partial<DirectorDeps> = {}) {
  const brain = new FakeBrain()
  brain.batches = [['a', 'b'], ['c', 'd'], ['e', 'f']]
  const host = new FakeHost()
  const director = new Director({
    persona: 'p',
    brain,
    voice: new FakeVoice(),
    player: new FakePlayer(),
    memory: new InProcessMemoryStore(),
    host,
    settings: () => directorSettings({ gapSeconds: 0 }),
    openUrl: () => {},
    ...over,
  })
  return { brain, host, director }
}

// A shuffle that swaps each card with itself, so the deck keeps the order it
// was built in: three familiar-allowed cards first, and `draw()` takes from
// the end — the first seven slots of a fresh deck are new-only.
const KEEP_ORDER = (): number => 0.999

function music(source: FakeTrackSource, player: FakeMixingPlayer) {
  return { source, cadence: new EveryNCadence(1), engine: player }
}

describe('the rotation deck reaches the pick', () => {
  it('says the slot in the situation and carries it as data', async () => {
    const player = new FakeMixingPlayer()
    const source = new FakeTrackSource()
    source.picks = [pickOf('https://stream/1')]
    const { director } = setup({ player, music: music(source, player), random: KEEP_ORDER })
    const run = director.run(2)
    await until(() => source.contexts.length >= 1, 'a pick was asked for')
    const ctx = source.contexts[0]!
    expect(ctx.situation).toContain('this slot: something they have not heard')
    expect(ctx.newOnly).toBe(true)
    await until(() => player.handles.length === 1, 'song on air')
    player.handles[0]!.end()
    await run
  })

  it('a listener request owns the slot rule: the rule steps aside', async () => {
    const player = new FakeMixingPlayer()
    const source = new FakeTrackSource()
    source.picks = [pickOf('https://stream/1'), pickOf('https://stream/2'), pickOf('https://stream/3'), pickOf('https://stream/4')]
    const steer: SteerBrain = {
      respond: async (_text, _ctx, actions) => {
        actions.music!.switchTrack('that band again')
        return 'on it.'
      },
    }
    const { director, host } = setup({ player, music: music(source, player), random: KEEP_ORDER, steer })
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'first song on air')
    host.type('play that band again')
    await until(() => source.contexts.some((c) => c.situation.includes('listener request:')), 'the request reached a pick')
    const asked = source.contexts.find((c) => c.situation.includes('listener request:'))!
    expect(asked.newOnly).toBe(false)
    expect(asked.situation).not.toContain('this slot:')
    // ...while the slots around it still carry the rule.
    expect(source.contexts[0]!.newOnly).toBe(true)
    player.handles[0]!.end()
    host.type('/quit')
    await run
  })

  it('carries what murmur itself has aired, so a repeat can be labelled as one', async () => {
    const player = new FakeMixingPlayer()
    const source = new FakeTrackSource()
    source.picks = [pickOf('https://stream/1', { title: 'One', artist: 'A Band' }), pickOf('https://stream/2', { title: 'Two', artist: 'A Band' })]
    const { director } = setup({ player, music: music(source, player), random: KEEP_ORDER })
    const run = director.run(4)
    await until(() => player.handles.length === 1, 'first song on air')
    player.handles[0]!.end()
    await until(() => source.contexts.length >= 2, 'a second pick was asked for')
    expect(source.contexts.at(-1)!.played).toContain('One — A Band')
    await until(() => player.handles.length === 2, 'second song on air')
    player.handles[1]!.end()
    await run
  })
})

// The AI slot (spec 14 §3.10 step four): an independent draw at
// `aiShare`, only while the channels pool holds tag rows and never on a
// listener request; it takes the situation's slot line, and the deck's
// verdict still rides along so the familiarity refusal stays armed.
describe('the AI slot reaches the pick', () => {
  const AI_LINE =
    'this slot: one of the AI-generated songs in the channels catalogue. Search it (a style word, a language, "\u539f\u521b", or an empty query to browse) and choose the one that fits this hour; say on air that it is AI-made.'

  async function firstPick(aiShare: number, aiRows: number) {
    const player = new FakeMixingPlayer()
    const source = new FakeTrackSource()
    source.picks = [pickOf('https://stream/1')]
    const { director } = setup({
      player,
      music: { ...music(source, player), aiRows: () => aiRows },
      random: KEEP_ORDER,
      settings: () => directorSettings({ gapSeconds: 0, aiShare }),
    })
    const run = director.run(2)
    await until(() => source.contexts.length >= 1, 'a pick was asked for')
    await until(() => player.handles.length === 1, 'song on air')
    player.handles[0]!.end()
    await run
    return source.contexts[0]!
  }

  it('is drawn at the share, ends the situation with its line, and leaves the deck verdict armed', async () => {
    const ctx = await firstPick(1, 5)
    expect(ctx.aiSlot).toBe(true)
    // In the slot line's place, the one the 5c line takes: one slot, one line.
    expect(ctx.situation).toContain(`\n${AI_LINE}\n`)
    expect(ctx.situation.match(/this slot:/g)).toHaveLength(1)
    expect(ctx.situation).not.toContain('this slot: something they have not heard')
    expect(ctx.newOnly).toBe(true)
  })

  it('is never drawn at 0, nor while the pool holds no tag rows', async () => {
    for (const [share, rows] of [[0, 5], [1, 0]] as const) {
      const ctx = await firstPick(share, rows)
      expect(ctx.aiSlot).toBe(false)
      expect(ctx.situation).not.toContain(AI_LINE)
      expect(ctx.situation).toContain('this slot: something they have not heard')
    }
  })

  it('steps aside for a listener request', async () => {
    const player = new FakeMixingPlayer()
    const source = new FakeTrackSource()
    source.picks = [pickOf('https://stream/1'), pickOf('https://stream/2'), pickOf('https://stream/3'), pickOf('https://stream/4')]
    const steer: SteerBrain = {
      respond: async (_text, _ctx, actions) => {
        actions.music!.switchTrack('that band again')
        return 'on it.'
      },
    }
    const { director, host } = setup({
      player,
      music: { ...music(source, player), aiRows: () => 5 },
      random: KEEP_ORDER,
      steer,
      settings: () => directorSettings({ gapSeconds: 0, aiShare: 1 }),
    })
    const run = director.run(2)
    await until(() => player.handles.length === 1, 'first song on air')
    host.type('play that band again')
    await until(() => source.contexts.some((c) => c.situation.includes('listener request:')), 'the request reached a pick')
    const asked = source.contexts.find((c) => c.situation.includes('listener request:'))!
    expect(asked.aiSlot).toBe(false)
    expect(asked.situation).not.toContain('this slot:')
    expect(source.contexts[0]!.aiSlot).toBe(true)
    player.handles[0]!.end()
    host.type('/quit')
    await run
  })
})
