import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Harness, Task } from '../src/contracts.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import type { Plan, ProgramId } from '../src/programs/catalogue.ts'
import { ProgramDesk, RESUME_WINDOW_MS, type DeskDeps } from '../src/programs/desk.ts'
import { ProgramFile } from '../src/programs/schedule.ts'

const HOUR = 3_600_000

// Answers every planning call with the plan `answer` returns for the program
// it was asked to prepare (read off the prompt's quoted title).
class PlanHarness implements Harness {
  prompts: string[] = []
  private answer: (title: string, call: number) => Plan | null
  constructor(answer: (title: string, call: number) => Plan | null) {
    this.answer = answer
  }
  async runTask<T>(task: Task<T>): Promise<T | null> {
    this.prompts.push(task.prompt)
    const title = /Prepare your next program: "([^"]+)"/.exec(task.prompt)?.[1] ?? ''
    const plan = this.answer(title, this.prompts.length)
    if (plan === null) return null
    let captured: T | null = null
    const [submit] = task.tools((v) => (captured = v))
    await submit!.handler(plan, {})
    return captured
  }
}

const plan = (subject: string, over: Partial<Plan> = {}): Plan => ({
  name: 'NAME',
  subject,
  angle: 'an angle',
  points: [
    { title: 'p1', content: 'c1' },
    { title: 'p2', content: 'c2' },
    { title: 'p3', content: 'c3' },
  ],
  ...over,
})

function weightsFile(weights: Record<ProgramId, number>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'murmur-desk-')), 'programs.json')
  writeFileSync(path, JSON.stringify({ weights, shuffledAt: Date.now(), names: {} }))
  return path
}

const only = (id: ProgramId): Record<ProgramId, number> => ({ puzzle: 0, today: 0, record: 0, poem: 0, origin: 0, [id]: 1 })

type DeskOver = Partial<Omit<DeskDeps, 'memory' | 'harness'>> & {
  path?: string
  memory?: InProcessMemoryStore
  harness?: PlanHarness
}

function desk(over: DeskOver = {}) {
  const path = over.path ?? weightsFile(only('origin'))
  const memory = over.memory ?? new InProcessMemoryStore()
  const harness = over.harness ?? new PlanHarness(() => plan('osmanthus'))
  const d = new ProgramDesk({
    file: new ProgramFile({ path }),
    memory,
    harness,
    model: 'model-x',
    persona: () => 'persona',
    language: () => 'English',
    ...over,
  })
  return { d, memory, harness, path }
}

describe('ProgramDesk — planning (spec 15 §2.4)', () => {
  it('plans a drawn program in the background and puts it on the air when ready', async () => {
    const { d } = desk()
    expect(d.current()).toBeNull()
    d.ensure()
    await d.ready()
    expect(d.current()?.id).toBe('origin')
    expect(d.label()).toBe('NAME · osmanthus · 1/3')
  })

  it('replans once when the subject is in cooldown, telling the planner what to avoid', async () => {
    const memory = new InProcessMemoryStore()
    memory.recordProgram({ id: 'origin', label: 'Osmanthus', keys: ['osmanthus'] })
    // Two programs since, so the gap no longer holds origin back.
    memory.recordProgram({ id: 'poem', label: 'x', keys: ['x'] })
    memory.recordProgram({ id: 'record', label: 'y', keys: ['y'] })
    const harness = new PlanHarness((_, call) => plan(call === 1 ? ' OSMANTHUS! ' : 'tea'))
    const { d } = desk({ memory, harness })
    d.ensure()
    await d.ready()
    expect(d.current()?.plan.subject).toBe('tea')
    expect(harness.prompts).toHaveLength(2)
    expect(harness.prompts[0]).toContain('choose a different one: Osmanthus')
    expect(harness.prompts[1]).toContain('OSMANTHUS!')
  })

  it('a second hit draws another category', async () => {
    const memory = new InProcessMemoryStore()
    memory.recordProgram({ id: 'origin', label: 'osmanthus', keys: ['osmanthus'] })
    memory.recordProgram({ id: 'today', label: 'x', keys: [] })
    memory.recordProgram({ id: 'record', label: 'y', keys: ['y'] })
    const harness = new PlanHarness((title) => plan(title === 'Where It Comes From' ? 'osmanthus' : 'Li Bai·Quiet Night'))
    const { d } = desk({ memory, harness, path: weightsFile({ ...only('origin'), poem: 0.0001 }) })
    d.ensure()
    await d.ready()
    expect(d.current()?.id).not.toBe('origin')
    expect(harness.prompts).toHaveLength(3)
  })

  it('freezes the name the first plan gave, and hands it to the next plan', async () => {
    const harness = new PlanHarness((_, call) => plan(`s${call}`, { name: call === 1 ? 'FIRST' : 'DRIFTED' }))
    const { d } = desk({ harness })
    d.ensure()
    await d.ready()
    expect(d.current()?.plan.name).toBe('FIRST')
    d.request('origin')
    await d.ready()
    expect(harness.prompts[1]).toContain('name on your air is FIRST')
    expect(d.current()?.plan.name).toBe('FIRST')
  })

  it('a planner that never submits is retried, then the draw moves on', async () => {
    const harness = new PlanHarness((title) => (title === 'Where It Comes From' ? null : plan('x')))
    const { d } = desk({ harness, path: weightsFile({ ...only('origin'), record: 0.0001 }) })
    d.ensure()
    await d.ready()
    expect(harness.prompts).toHaveLength(3)
    expect(d.current()?.id).not.toBe('origin')
  })
})

describe('ProgramDesk — the run (spec 15 §2.7)', () => {
  it('cues each point with its flags, and plans the next program while the last point is being written', async () => {
    const { d, harness } = desk()
    d.ensure()
    await d.ready()
    const first = d.cue({ anchor: 'morning' })!
    expect(first).toMatchObject({ name: 'NAME', subject: 'osmanthus', index: 0, opening: true, anchor: 'morning' })
    expect(first.outline).toEqual(['p1', 'p2', 'p3'])
    expect(first.point).toEqual({ title: 'p1', content: 'c1' })
    expect(first.beats).toEqual([3, 4])
    expect(first.closing).toBeUndefined()
    d.opened()
    d.pointAired(0)
    expect(d.cue({ returning: true, afterSong: true })).toMatchObject({ index: 1, returning: true, afterSong: true })
    expect(d.cue({})?.opening).toBeUndefined()
    d.pointAired(1)
    expect(harness.prompts).toHaveLength(1)
    expect(d.cue({})).toMatchObject({ index: 2, closing: true })
    expect(harness.prompts).toHaveLength(2) // the next program, planned ahead
    d.pointAired(2)
    await d.ready()
    expect(d.current()?.plan.subject).toBe('osmanthus')
    expect(d.current()?.next).toBe(0)
  })

  it('ledgers the program when its first beat airs, once', async () => {
    const { d, memory } = desk({ harness: new PlanHarness(() => plan('Q', { leads: ['Zhuangzi'] })), path: weightsFile(only('puzzle')) })
    d.ensure()
    await d.ready()
    d.opened()
    d.opened()
    expect(memory.recentPrograms(9)).toMatchObject([{ id: 'puzzle', label: 'Q', keys: ['zhuangzi'], leads: ['Zhuangzi'] }])
  })

  it('persists the run after every point, and a relaunch within six hours resumes it', async () => {
    const now = { t: 1_000 * HOUR }
    const { d, path } = desk({ now: () => now.t })
    d.ensure()
    await d.ready()
    d.opened()
    d.pointAired(0)
    expect(JSON.parse(readFileSync(path, 'utf-8')).current.next).toBe(1)
    now.t += RESUME_WINDOW_MS - 1
    const back = desk({ path, now: () => now.t }).d
    expect(back.current()?.next).toBe(1)
    expect(back.cue({})).toMatchObject({ index: 1, resumed: true })
    back.pointAired(1)
    expect(back.cue({})?.resumed).toBeUndefined()
  })

  it('a relaunch after six hours drops the run', async () => {
    const now = { t: 1_000 * HOUR }
    const { d, path } = desk({ now: () => now.t })
    d.ensure()
    await d.ready()
    d.opened()
    d.pointAired(0)
    now.t += RESUME_WINDOW_MS
    expect(desk({ path, now: () => now.t }).d.current()).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf-8')).current).toBeUndefined()
  })
})

describe('ProgramDesk — requests (spec 15 §2.8)', () => {
  it('drops the run on the air and plans the request at once, subject bypassing cooldown', async () => {
    const memory = new InProcessMemoryStore()
    memory.recordProgram({ id: 'poem', label: 'Li Bai·Quiet Night', keys: ['libaiquietnight'] })
    const harness = new PlanHarness((title) => plan(title === 'Read One' ? 'Li Bai·Quiet Night' : 'osmanthus'))
    const { d } = desk({ memory, harness })
    d.ensure()
    await d.ready()
    d.request('poem', 'Li Bai·Quiet Night')
    expect(d.current()).toBeNull()
    await d.ready()
    expect(d.current()).toMatchObject({ id: 'poem', requested: true })
    expect(harness.prompts.at(-1)).toContain('The listener asked for this subject: Li Bai·Quiet Night')
    d.opened()
    expect(memory.recentPrograms(9).at(-1)).toMatchObject({ id: 'poem', requested: true })
  })
})

describe('ProgramDesk — real-world items and music', () => {
  it('draws today only with two fresh items, and takes them at plan time', async () => {
    const taken: string[] = []
    const fresh = [
      { title: 'A', gist: 'a' },
      { title: 'B', gist: 'b' },
    ]
    const rwt = {
      fresh: () => fresh,
      take: (n: number) => {
        const out = fresh.splice(0, n)
        taken.push(...out.map((i) => i.title))
        return out
      },
    }
    const harness = new PlanHarness(() => plan('two stories'))
    const { d, memory } = desk({ rwt, harness, path: weightsFile({ ...only('today'), origin: 0.0001 }) })
    d.ensure()
    await d.ready()
    expect(d.current()?.id).toBe('today')
    expect(harness.prompts[0]).toContain('- A — a')
    expect(taken).toEqual(['A', 'B'])
    expect(memory.recentRwt(9)).toEqual(['A', 'B'])
  })

  it('never draws today with fewer than two fresh items', async () => {
    const rwt = { fresh: () => [{ title: 'A', gist: 'a' }], take: () => [] }
    const { d } = desk({ rwt, path: weightsFile({ ...only('today'), origin: 0.0001 }) })
    d.ensure()
    await d.ready()
    expect(d.current()?.id).toBe('origin')
  })

  it('a record asks for the point track; the others hand over a mood hint', async () => {
    const harness = new PlanHarness(() =>
      plan('An Artist', { points: [{ title: 't1', content: 'c', track: { artist: 'An Artist', title: 'Song One' } }] }),
    )
    const { d } = desk({ harness, path: weightsFile(only('record')) })
    d.ensure()
    await d.ready()
    expect(d.musicHint()).toEqual({ line: expect.stringContaining('An Artist — Song One'), request: true })
    const other = desk()
    other.d.ensure()
    await other.d.ready()
    expect(other.d.musicHint()).toEqual({ line: expect.stringContaining('osmanthus'), request: false })
  })
})
