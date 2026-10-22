// The Director on programs (spec 15 §2.5/§2.7/§2.10): one beat call per
// outline point, a song after each point, the opening and closing flags, the
// next program prepared during the last point, replies coming back to the
// point, requests ending the run.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Brain, ContextPack, ProgramCue, SteerActions, SteerBrain, TalkBeat, Turn } from '../src/contracts.ts'
import { EveryNCadence } from '../src/director/cadence.ts'
import { Director, type DirectorDeps } from '../src/director/director.ts'
import type { AnchorId, Scheduler } from '../src/director/scheduler.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import type { Plan, ProgramId } from '../src/programs/catalogue.ts'
import { ProgramDesk } from '../src/programs/desk.ts'
import { ProgramFile } from '../src/programs/schedule.ts'
import {
  directorSettings,
  FakeHost,
  FakeMixingPlayer,
  FakeTrackSource,
  FakeVoice,
  pickOf,
  PlanHarness,
  until,
} from './fakes.ts'

// Says each point in its minimum beat count, beats named by point: "P<i>.<n>".
class PointBrain implements Brain {
  contexts: ContextPack[] = []
  async nextTalks(ctx: ContextPack, count: number): Promise<TalkBeat[]> {
    this.contexts.push(ctx)
    const p = ctx.program
    if (p === undefined) return Array.from({ length: count }, (_, i) => ({ text: `free${i}` }))
    return Array.from({ length: p.beats[0] }, (_, i) => ({ text: `${p.subject}:P${p.index}.${i + 1}` }))
  }
  async respond(userText: string): Promise<string> {
    return `re:${userText}`
  }
  async compactProfile(profile: string, _t: readonly Turn[]): Promise<string> {
    return profile
  }
  async seedPersona(): Promise<string> {
    return 'p'
  }
  async fetchTopics() {
    return []
  }
  cues(): ProgramCue[] {
    return this.contexts.flatMap((c) => (c.program === undefined ? [] : [c.program]))
  }
}

const threePoints = (subject: string): Plan => ({
  name: 'NAME',
  subject,
  angle: 'angle',
  points: [
    { title: 'a', content: 'ca' },
    { title: 'b', content: 'cb' },
    { title: 'c', content: 'cc' },
  ],
})

function programsFile(id: ProgramId = 'poem'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'murmur-dp-')), 'programs.json')
  const weights = { puzzle: 0, today: 0, record: 0, poem: 0, origin: 0, [id]: 1 }
  writeFileSync(path, JSON.stringify({ weights, shuffledAt: Date.now(), names: {} }))
  return path
}

function build(over: Partial<DirectorDeps> & { withMusic?: boolean; subjects?: string[] } = {}) {
  const { withMusic = false, subjects = ['s1', 's2', 's3', 's4'], ...rest } = over
  const brain = new PointBrain()
  const memory = new InProcessMemoryStore()
  const host = new FakeHost()
  const player = new FakeMixingPlayer()
  const source = new FakeTrackSource()
  source.picks = Array.from({ length: 12 }, (_, i) => pickOf(`https://stream/${i}`, { title: `Song${i}` }))
  const harness = new PlanHarness((_, call) => threePoints(subjects[(call - 1) % subjects.length]!))
  // Poem: 2-3 beats a point, so each point airs two beats.
  const programs = new ProgramDesk({
    file: new ProgramFile({ path: programsFile() }),
    memory,
    harness,
    model: 'm',
    persona: () => 'p',
    language: () => 'English',
  })
  const knobs = directorSettings({ gapSeconds: 0 })
  const deps: DirectorDeps = {
    persona: 'p',
    brain,
    voice: new FakeVoice(),
    player,
    memory,
    host,
    settings: () => knobs,
    openUrl: () => {},
    programs,
    ...(withMusic && { music: { source, cadence: new EveryNCadence(9), engine: player } }),
    ...rest,
  }
  return { brain, memory, host, player, source, harness, programs, director: new Director(deps) }
}

describe('programs on a talk-only air', () => {
  it('says one point per beat call, in order, opening and closing the program', async () => {
    const { brain, host, director } = build()
    await director.run(6) // three points of two beats
    expect(host.radio).toEqual(['s1:P0.1', 's1:P0.2', 's1:P1.1', 's1:P1.2', 's1:P2.1', 's1:P2.2'])
    const cues = brain.cues()
    // The fourth cue is the next program's opening, written as the last beat airs.
    expect(cues.map((c) => c.index).slice(0, 3)).toEqual([0, 1, 2])
    expect(cues[0]).toMatchObject({ opening: true, name: 'NAME', subject: 's1' })
    expect(cues[2]).toMatchObject({ closing: true })
  })

  it('prepares the next program during the last point, and opens it when this one ends', async () => {
    const { brain, harness, host, director } = build()
    await director.run(7)
    // The second plan was asked for while the first program's last point was
    // being written, and its opening aired straight after.
    expect(harness.prompts.length).toBeGreaterThanOrEqual(2)
    expect(host.radio[6]).toBe('s2:P0.1')
    expect(brain.cues().find((c) => c.subject === 's2')).toMatchObject({ index: 0, opening: true })
  })

  it('ledgers each program as its first beat airs, and shows it in the status line', async () => {
    const { memory, host, director } = build()
    await director.run(3)
    expect(memory.recentPrograms(9).map((r) => r.label)).toEqual(['s1'])
    expect(host.states.map((s) => s.program).filter(Boolean)).toContain('NAME · s1 · 2/3')
  })

  it('carries no free-talk batch at all once a program is on', async () => {
    const { brain, director } = build()
    await director.run(4)
    expect(brain.contexts.every((c) => c.program !== undefined)).toBe(true)
  })
})

// Keep releasing the manual player until the run is over.
async function pumped(player: FakeMixingPlayer, run: Promise<void>): Promise<void> {
  const pump = setInterval(() => player.finish(), 5)
  try {
    await run
  } finally {
    clearInterval(pump)
  }
}

describe('programs with music (spec 15 §2.10)', () => {
  it('holds the air with music while the first program is planned, then a song after each point', async () => {
    const { host, player, director } = build({ withMusic: true })
    const run = director.run(5) // the fill song, point 0 (two beats), a song, point 1's first beat
    await until(() => player.handles.length === 1, 'the song while planning')
    expect(host.radio).toEqual([])
    player.handles[0]!.end()
    await until(() => player.handles.length === 2, 'the song after point 0')
    expect(host.radio).toEqual(['s1:P0.1', 's1:P0.2'])
    player.handles[1]!.end()
    await run
    expect(host.radio.at(-1)).toBe('s1:P1.1')
  })

  it('writes the next point as the song starts, so its first beat comes out of the song', async () => {
    const { brain, player, director } = build({ withMusic: true })
    const run = director.run(5)
    await until(() => player.handles.length === 1, 'fill song')
    player.handles[0]!.end()
    await until(() => player.handles.length === 2, 'song after point 0')
    await until(() => brain.cues().length === 2, 'point 1 written during the song')
    expect(brain.cues()[1]).toMatchObject({ index: 1, afterSong: true })
    expect(brain.contexts[1]!.music).toMatchObject({ kind: 'playing' })
    player.handles[1]!.end()
    await run
  })

  it('the pick is told the program on the air', async () => {
    const { source, player, director } = build({ withMusic: true })
    const run = director.run(4)
    await until(() => player.handles.length === 1, 'fill song')
    player.handles[0]!.end()
    await until(() => player.handles.length === 2, 'song')
    expect(source.contexts.some((c) => c.situation.includes('the program on the air'))).toBe(true)
    player.handles[1]!.end()
    await run
  })
})

describe('replies and requests inside a program', () => {
  it('a reply drops the point beats not yet said, and the refill comes back to the point', async () => {
    const { brain, host, player, director } = build()
    player.auto = false
    const run = director.run(4)
    await until(() => host.radio.length === 1, 'first beat')
    host.type('hello')
    await until(() => host.radio.includes('re:hello'), 'the reply')
    await pumped(player, run)
    const back = brain.cues().find((c) => c.returning === true)
    expect(back).toMatchObject({ index: 0 })
    // One beat of point 0 aired before the reply, so the rest of it is asked for.
    expect(back!.beats).toEqual([1, 2])
  })

  it('request_program ends the run and the requested program opens next', async () => {
    let actions: SteerActions | undefined
    const steer: SteerBrain = {
      respond: async (_text, _ctx, a) => {
        actions = a
        a.programs?.request('poem', 'a requested poem')
        return 'sure'
      },
    }
    const { host, memory, player, director } = build({ steer, subjects: ['s1', 'a requested poem'] })
    player.auto = false
    const run = director.run(4)
    await until(() => host.radio.length === 1, 'first beat')
    host.type('read me a poem')
    await until(() => host.radio.includes('sure'), 'the reply')
    await pumped(player, run)
    expect(actions?.programs).toBeDefined()
    const after = host.radio.slice(host.radio.indexOf('sure') + 1)
    expect(after[0]).toBe('a requested poem:P0.1')
    expect(after.some((t) => t.startsWith('s1:'))).toBe(false)
    expect(memory.recentPrograms(9).at(-1)).toMatchObject({ label: 'a requested poem', requested: true })
  })
})

describe('time anchors fold into an opening (spec 15 §2.7)', () => {
  class OneAnchor implements Scheduler {
    fired: AnchorId[] = []
    pending: AnchorId | null = 'morning'
    due(): AnchorId | null {
      return this.pending
    }
    markFired(id: AnchorId): void {
      this.fired.push(id)
      this.pending = null
    }
  }

  it('the due anchor rides the opening point and is marked fired when it airs; no anchor beat of its own', async () => {
    const scheduler = new OneAnchor()
    const sensor = { state: () => 'present' as const, idleMs: () => 0, noteInput: () => {} }
    const { brain, host, director } = build({ pacing: { sensor, scheduler } })
    await director.run(2)
    expect(brain.cues()[0]).toMatchObject({ opening: true, anchor: 'anchor:morning' })
    expect(brain.contexts.every((c) => c.cue === undefined)).toBe(true)
    expect(scheduler.fired).toEqual(['morning'])
    expect(host.radio).toEqual(['s1:P0.1', 's1:P0.2'])
  })
})
