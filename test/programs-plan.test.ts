import { describe, expect, it } from 'vitest'

import type { Plan } from '../src/programs/catalogue.ts'
import { planTask, type PlanRequest } from '../src/programs/plan.ts'
import { buildPlanPrompt } from '../src/prompts/program.ts'

const req = (over: Partial<PlanRequest> = {}): PlanRequest => ({
  id: 'origin',
  persona: 'the persona',
  today: '2026-10-15',
  avoid: [],
  about: '',
  taste: '',
  items: [],
  ...over,
})

describe('the planning prompt (spec 15 §2.4)', () => {
  it('sizes the outline from the program and asks for sourced material', () => {
    const p = buildPlanPrompt(req({ id: 'puzzle' }))
    expect(p).toContain('6 points')
    expect(p).toContain('40 minutes')
    expect(p).toContain('source')
    expect(p).toContain('`leads`')
  })

  it('lists the subjects in cooldown to avoid', () => {
    expect(buildPlanPrompt(req({ avoid: ['osmanthus', 'tea'] }))).toContain('osmanthus; tea')
  })

  it('a requested subject replaces the avoid list', () => {
    const p = buildPlanPrompt(req({ avoid: ['osmanthus'], subject: 'osmanthus' }))
    expect(p).toContain('The listener asked for this subject: osmanthus')
    expect(p).not.toContain('choose a different one')
  })

  it('freezes a known name, and asks for a literal rendering of the title otherwise', () => {
    expect(buildPlanPrompt(req({ name: 'NAME-ON-AIR' }))).toContain('return exactly that as `name`')
    const fresh = buildPlanPrompt(req())
    expect(fresh).toContain('Where It Comes From')
    expect(fresh).toContain('literal')
  })

  it('hands real-world items to today and puzzle only', () => {
    const items = [{ title: 'A port strike ends', gist: 'Ten days on, the cranes move again.' }]
    expect(buildPlanPrompt(req({ id: 'today', items }))).toContain('A port strike ends')
    expect(buildPlanPrompt(req({ id: 'puzzle', items }))).toContain('A port strike ends')
    expect(buildPlanPrompt(req({ id: 'origin', items }))).not.toContain('A port strike ends')
  })

  it('a puzzle with no item fitting talks trends, never forced news', () => {
    expect(buildPlanPrompt(req({ id: 'puzzle' }))).toContain('trends only')
  })

  it('hands the taste digest to the record program only', () => {
    expect(buildPlanPrompt(req({ id: 'record', taste: 'keeps city pop' }))).toContain('keeps city pop')
    expect(buildPlanPrompt(req({ id: 'poem', taste: 'keeps city pop' }))).not.toContain('keeps city pop')
  })
})

describe('planTask', () => {
  it('is a plan-category task on the host prompt, thinking left on', () => {
    const task = planTask(req(), 'model-x')
    expect(task.category).toBe('plan')
    expect(task.systemPrompt).toContain('the persona')
    expect(task.thinking).toBeUndefined()
    expect(task.model).toBe('model-x')
  })

  it('submit_plan cleans the outline and finishes with it', async () => {
    let plan: Plan | null = null
    const [tool] = planTask(req(), 'm').tools((p) => (plan = p))
    await tool!.handler(
      {
        name: ' Name ',
        subject: ' osmanthus ',
        angle: ' why it smells like October ',
        points: [
          { title: ' one ', content: ' facts ' },
          { title: '', content: '' },
          { title: 'two', content: 'more', track: { artist: ' A ', title: ' B ' } },
        ],
      },
      {},
    )
    expect(plan).toEqual({
      name: 'Name',
      subject: 'osmanthus',
      angle: 'why it smells like October',
      points: [
        { title: 'one', content: 'facts' },
        { title: 'two', content: 'more', track: { artist: 'A', title: 'B' } },
      ],
    })
  })

  it('does not finish on an outline with nothing in it', async () => {
    let plan: Plan | null = null
    const [tool] = planTask(req(), 'm').tools((p) => (plan = p))
    await tool!.handler({ name: 'n', subject: 's', angle: 'a', points: [{ title: ' ', content: ' ' }] }, {})
    expect(plan).toBeNull()
  })
})
