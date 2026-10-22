import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Harness, Task } from '../src/contracts.ts'
import { InProcessMemoryStore } from '../src/memory/memory.ts'
import { fixedName, type Plan, type ProgramId } from '../src/programs/catalogue.ts'
import { ProgramDesk, RESUME_WINDOW_MS, type DeskDeps } from '../src/programs/desk.ts'
import { ProgramFile } from '../src/programs/schedule.ts'
import { PlanHarness } from './fakes.ts'

const HOUR = 3_600_000

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
  harness?: Harness
}

function desk(over: DeskOver = {}) {
  const path = over.path ?? weightsFile(only('origin'))
  const memory = over.memory ?? new InProcessMemoryStore()
  const harness = (over.harness ?? new PlanHarness(() => plan('osmanthus'))) as PlanHarness
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

  it('a Chinese air uses the shipped names, never the planner rendering', async () => {
    const harness = new PlanHarness(() => plan('s', { name: 'DRIFTED' }))
    const { d, path } = desk({ harness, language: () => 'Chinese (Mandarin)' })
    d.ensure()
    await d.ready()
    const shipped = fixedName('Chinese (Mandarin)', 'origin')
    expect(shipped).toMatch(/\p{Script=Han}/u)
    expect(d.current()?.plan.name).toBe(shipped)
    expect(harness.prompts[0]).toContain(`name on your air is ${shipped}`)
    // Nothing is frozen: the shipped table stays the source.
    expect(new ProgramFile({ path }).name('Chinese (Mandarin)', 'origin')).toBeUndefined()
  })

  it('a name the listener froze by hand still wins over the shipped one', async () => {
    const path = weightsFile(only('origin'))
    new ProgramFile({ path }).setName('Chinese', 'origin', 'MINE')
    const { d } = desk({ path, language: () => 'Chinese' })
    d.ensure()
    await d.ready()
    expect(d.current()?.plan.name).toBe('MINE')
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
  it('cues each point with its flags, and plans the next program while the second-to-last point is being written', async () => {
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
    expect(harness.prompts).toHaveLength(1)
    // Box music smoke: a plan takes over a minute, longer than one point; it
    // starts a point earlier so the change of program has no dead air.
    expect(d.cue({ returning: true, afterSong: true })).toMatchObject({ index: 1, returning: true, afterSong: true })
    expect(harness.prompts).toHaveLength(2) // the next program, planned ahead
    expect(d.cue({})?.opening).toBeUndefined()
    d.pointAired(1)
    expect(d.cue({})).toMatchObject({ index: 2, closing: true })
    expect(harness.prompts).toHaveLength(2)
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
      plan('An Artist', {
        points: [
          { title: 't1', content: 'c', track: { artist: 'An Artist', title: 'Song One' } },
          { title: 't2', content: 'c', track: { artist: 'An Artist', title: 'Song Two' } },
        ],
      }),
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

// Closing review (codex) findings, each pinned.
describe('ProgramDesk — planning ahead of a run not yet opened', () => {
  it('a two-point program plans its successor at the opening, counting itself in the gap and the cooldown', async () => {
    const two = (subject: string): Plan => ({ ...plan(subject), points: [{ title: 'a', content: 'c' }, { title: 'b', content: 'c' }] })
    const harness = new PlanHarness((title, call) => two(call <= 2 && title === 'Where It Comes From' ? 'osmanthus' : `s${call}`))
    const { d } = desk({ harness, path: weightsFile({ ...only('origin'), poem: 0.0001 }) })
    d.ensure()
    await d.ready()
    expect(d.cue({})).toMatchObject({ index: 0, opening: true })
    await d.ready()
    // The successor is not origin: the run about to open holds the gap.
    expect(harness.prompts.at(-1)).toContain('"Read One"')
  })
})

describe('ProgramDesk — review findings', () => {
  it('a puzzle without leads, or a dedupable plan with no usable key, is replanned', async () => {
    const harness = new PlanHarness((_, call) => (call === 1 ? plan('why work') : plan('why work', { leads: ['Zhuangzi'] })))
    const { d } = desk({ harness, path: weightsFile(only('puzzle')) })
    d.ensure()
    await d.ready()
    expect(harness.prompts).toHaveLength(2)
    expect(d.current()?.plan.leads).toEqual(['Zhuangzi'])
  })

  it('a one-point outline is not a program', async () => {
    const harness = new PlanHarness((_, call) =>
      call === 1 ? plan('thin', { points: [{ title: 'only', content: 'c' }] }) : plan('full'),
    )
    const { d } = desk({ harness })
    d.ensure()
    await d.ready()
    expect(d.current()?.plan.subject).toBe('full')
  })

  it('refuses a today request without two fresh items, and keeps the run on the air', async () => {
    const rwt = { fresh: () => [{ title: 'A', gist: 'a' }], take: () => [] }
    const { d, harness } = desk({ rwt })
    d.ensure()
    await d.ready()
    expect(d.request('today')).toBe(false)
    expect(d.current()?.plan.subject).toBe('osmanthus')
    expect(harness.prompts).toHaveLength(1)
    expect(d.request('poem')).toBe(true)
  })

  it('a superseded plan neither freezes a name nor keeps planning', async () => {
    // The first planning call is held until the request's plan has landed.
    const gates: (() => void)[] = []
    const prompts: string[] = []
    const gated: Harness = {
      async runTask<T>(task: Task<T>): Promise<T | null> {
        prompts.push(task.prompt)
        const n = prompts.length
        if (n === 1) await new Promise<void>((r) => gates.push(r))
        let captured: T | null = null
        const [submit] = task.tools((v) => (captured = v))
        await submit!.handler(plan('x', { name: `N${n}` }), {})
        return captured
      },
    }
    const { d, path } = desk({ harness: gated })
    d.ensure()
    await new Promise((r) => setTimeout(r, 5))
    d.request('origin')
    await d.ready()
    gates[0]!()
    await new Promise((r) => setTimeout(r, 20))
    expect(new ProgramFile({ path }).name('English', 'origin')).toBe('N2')
    expect(d.current()?.plan.name).toBe('N2')
    expect(prompts).toHaveLength(2)
  })

  it('reset drops the run on the air, the plan behind it, and the persisted copy', async () => {
    const { d, path } = desk()
    d.ensure()
    await d.ready()
    d.opened()
    d.reset()
    expect(d.current()).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf-8')).current).toBeUndefined()
  })

  it('the music hint for the song after a point names that point, not the next one', async () => {
    const harness = new PlanHarness(() =>
      plan('A', {
        points: [
          { title: 't1', content: 'c', track: { artist: 'A', title: 'One' } },
          { title: 't2', content: 'c', track: { artist: 'A', title: 'Two' } },
        ],
      }),
    )
    const { d } = desk({ harness, path: weightsFile(only('record')) })
    d.ensure()
    await d.ready()
    d.opened()
    d.pointAired(0)
    expect(d.musicHint(true)?.line).toContain('One')
    expect(d.musicHint()?.line).toContain('Two')
  })
})
