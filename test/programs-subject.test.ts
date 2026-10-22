import { describe, expect, it } from 'vitest'

import { PROGRAM_IDS, PROGRAMS } from '../src/programs/catalogue.ts'
import { cooldownKeys, normalizeSubject } from '../src/programs/subject.ts'

// CJK never appears in source (master \u00A70): the fixtures are escapes.
const LONG_TREE_TRAD = '\u9F8D\u6A39' // dragon-tree, traditional
const LONG_TREE_SIMP = '\u9F99\u6811' // the same, simplified
const OSMANTHUS = '\u6842\u82B1'

describe('the catalogue (spec 15 \u00A72.1)', () => {
  it('holds exactly the five programs, with their shapes', () => {
    expect([...PROGRAM_IDS]).toEqual(['puzzle', 'today', 'record', 'poem', 'origin'])
    expect(PROGRAMS.puzzle.targetMin).toBe(40)
    expect(PROGRAMS.today.targetMin).toBe(20)
    for (const id of ['record', 'poem', 'origin'] as const) expect(PROGRAMS[id].targetMin).toBe(30)
    expect(PROGRAMS.poem.cooldownDays).toBe(180)
    expect(PROGRAMS.origin.cooldownDays).toBe(90)
    expect(PROGRAMS.record.cooldownDays).toBe(30)
    expect(PROGRAMS.puzzle.cooldownDays).toBe(30)
    expect(PROGRAMS.today.cooldownDays).toBe(0)
    expect(PROGRAMS.record.beats).toEqual([1, 2])
  })
})

describe('normalizeSubject (spec 15 \u00A72.6)', () => {
  it('folds traditional to simplified', () => {
    expect(normalizeSubject(LONG_TREE_TRAD)).toBe(LONG_TREE_SIMP)
  })

  it('strips whitespace, punctuation and symbols, and folds width and case', () => {
    expect(normalizeSubject(` \u300A${OSMANTHUS}\u300B\uFF01 `)).toBe(OSMANTHUS)
    expect(normalizeSubject('Li Bai \u00B7 Jing Ye Si')).toBe('libaijingyesi')
    expect(normalizeSubject('\uFF2C\uFF49 Bai')).toBe('libai')
  })
})

describe('cooldownKeys', () => {
  it('keys a puzzle by its lead thinkers, not its question', () => {
    expect(cooldownKeys('puzzle', { subject: 'why must we work', leads: ['Zhuangzi', ' Hannah Arendt '] })).toEqual([
      'zhuangzi',
      'hannaharendt',
    ])
  })

  it('keys every other dedupable program by its subject, and today by nothing', () => {
    expect(cooldownKeys('origin', { subject: OSMANTHUS })).toEqual([OSMANTHUS])
    expect(cooldownKeys('today', { subject: 'two stories' })).toEqual([])
  })

  it('a puzzle with no leads falls back to nothing rather than its question', () => {
    expect(cooldownKeys('puzzle', { subject: 'why must we work' })).toEqual([])
  })
})
