import { describe, expect, it } from 'vitest'
import type { CardLine } from '../tui/src/dock.ts'
import { CARD_INK } from '../tui/src/palette.ts'

describe('the spotlight card ink (spec 10 §3.2-B)', () => {
  it('every card role has an ink', () => {
    const roles: CardLine['role'][] = ['main', 'ready', 'gap', 'note', 'option']
    for (const role of roles) expect(CARD_INK[role]).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("a gap is the one thing that isn't fine, so it shares ink with nothing quiet", () => {
    expect(CARD_INK.gap).not.toBe(CARD_INK.option)
    expect(CARD_INK.gap).not.toBe(CARD_INK.note)
    expect(CARD_INK.gap).not.toBe(CARD_INK.ready)
  })
})
