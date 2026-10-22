import { describe, expect, it } from 'vitest'

import { fixedName, PROGRAM_IDS } from '../src/programs/catalogue.ts'

// Built from code points: sources carry no CJK, escaped or not.
const cp = (...points: number[]): string => String.fromCodePoint(...points)
const OPEN = cp(0x300a)
const CLOSE = cp(0x300b)
const HAN_PROSE = cp(0x4eca, 0x5929, 0x8bfb, 0x4e00, 0x9996, 0x8bd7)
const KANA_PROSE = cp(0x4eca, 0x65e5, 0x306f, 0x8a69, 0x3092, 0x8aad, 0x3080)

describe('fixedName — the shipped program names (spec 15 §2.2)', () => {
  it('ships a title-marked Chinese name for every program', () => {
    const names = PROGRAM_IDS.map((id) => fixedName('Chinese', id))
    for (const name of names) expect(name).toMatch(new RegExp(`^${OPEN}\\p{Script=Han}+${CLOSE}$`, 'u'))
    expect(new Set(names).size).toBe(PROGRAM_IDS.length)
  })

  it('reads every way the air names Chinese', () => {
    for (const language of ['Chinese', 'Chinese (Mandarin)', 'Chinese, Simplified', 'mandarin chinese'])
      expect(fixedName(language, 'poem')).toBe(fixedName('Chinese', 'poem'))
    // A generated persona never names its language; its prose sample does.
    expect(fixedName(`the language this is written in: "${HAN_PROSE}"`, 'poem')).toBe(
      fixedName('Chinese', 'poem'),
    )
  })

  it('has no name for any other language, Japanese prose included', () => {
    expect(fixedName('English', 'poem')).toBeUndefined()
    expect(fixedName(`the language this is written in: "${KANA_PROSE}"`, 'poem')).toBeUndefined()
  })
})
