import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PROGRAM_IDS, type ProgramId } from '../src/programs/catalogue.ts'
import { drawProgram, ProgramFile, RESHUFFLE_DAYS, WEIGHTS } from '../src/programs/schedule.ts'

const DAY = 86_400_000
const file = () => join(mkdtempSync(join(tmpdir(), 'murmur-programs-')), 'programs.json')
const uniform: Record<ProgramId, number> = { puzzle: 1, today: 1, record: 1, poem: 1, origin: 1 }

describe('drawProgram (spec 15 §2.3)', () => {
  it('never draws one of the last two aired while another is eligible', () => {
    for (let i = 0; i < 50; i++) {
      const id = drawProgram({ weights: uniform, recent: ['poem', 'origin', 'record'], eligible: [...PROGRAM_IDS], random: () => i / 50 })
      expect(['origin', 'record']).not.toContain(id)
    }
  })

  it('relaxes the gap rather than go silent', () => {
    expect(drawProgram({ weights: uniform, recent: ['poem', 'origin'], eligible: ['origin'], random: () => 0.5 })).toBe('origin')
  })

  it('draws by weight', () => {
    const weights: Record<ProgramId, number> = { puzzle: 1, today: 0, record: 0, poem: 0, origin: 3 }
    // A quarter of the mass is puzzle, the rest origin.
    expect(drawProgram({ weights, recent: [], eligible: [...PROGRAM_IDS], random: () => 0.2 })).toBe('puzzle')
    expect(drawProgram({ weights, recent: [], eligible: [...PROGRAM_IDS], random: () => 0.3 })).toBe('origin')
  })

  it('draws nothing only when nothing is eligible', () => {
    expect(drawProgram({ weights: uniform, recent: [], eligible: [], random: () => 0 })).toBeNull()
  })
})

describe('ProgramFile', () => {
  it('assigns the five weights to the five programs on first read, and persists them', () => {
    const path = file()
    const now = { t: 10 * DAY }
    const weights = new ProgramFile({ path, now: () => now.t, random: () => 0.3 }).weights()
    expect(Object.values(weights).sort()).toEqual([...WEIGHTS].sort())
    // A second instance reads the same assignment, it does not re-roll.
    expect(new ProgramFile({ path, now: () => now.t, random: () => 0.9 }).weights()).toEqual(weights)
  })

  it(`reshuffles once the assignment is ${RESHUFFLE_DAYS} days old`, () => {
    const path = file()
    const now = { t: 10 * DAY }
    const rolls = [0.1, 0.7, 0.4, 0.9]
    let i = 0
    const store = new ProgramFile({ path, now: () => now.t, random: () => rolls[i++ % rolls.length]! })
    store.weights()
    const at = JSON.parse(readFileSync(path, 'utf-8')).shuffledAt
    now.t += RESHUFFLE_DAYS * DAY - 1
    store.weights()
    expect(JSON.parse(readFileSync(path, 'utf-8')).shuffledAt).toBe(at)
    now.t += 1
    store.weights()
    expect(JSON.parse(readFileSync(path, 'utf-8')).shuffledAt).toBe(now.t)
  })

  it('freezes a program name per language (spec 15 §2.2)', () => {
    const path = file()
    const store = new ProgramFile({ path })
    expect(store.name('Japanese', 'poem')).toBeUndefined()
    store.setName('Japanese', 'poem', 'One Poem (ja)')
    expect(new ProgramFile({ path }).name('Japanese', 'poem')).toBe('One Poem (ja)')
    expect(new ProgramFile({ path }).name('English', 'poem')).toBeUndefined()
  })

  it('reads a broken file as a fresh one', () => {
    const path = file()
    writeFileSync(path, '{not json')
    expect(Object.values(new ProgramFile({ path, random: () => 0.5 }).weights())).toHaveLength(5)
  })
})
