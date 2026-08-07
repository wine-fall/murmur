// The constellation panel's client half (spec 10 §3.6 / §6.1 quiet-constellation
// art direction): a seeded starfield, the FFT bins re-rendered as a braille
// particle mist, and the pet floating inside it.
//
// Like bars.ts, the module is free of OpenTUI and React on purpose: the frame a
// terminal paints cannot be unit-asserted (§3.9), but "which dots for this
// level" can — and determinism (seeded stars, hashed jitter) is itself part of
// the contract, because a resize must not reshuffle the sky.

import { describe, expect, it } from 'vitest'

import { Constellation, hash01, panelWidth, WIDE_MIN } from '../tui/src/constellation.ts'
import { accentFor } from '../tui/src/palette.ts'

const ACCENT = accentFor('late-night')

const BRAILLE_START = 0x28_00
const BRAILLE_END = 0x28_ff

function isBraille(char: string): boolean {
  const code = char.codePointAt(0)!
  return code >= BRAILLE_START && code <= BRAILLE_END
}

// Total lit sub-pixels in a frame: each braille cell carries its dots in the
// low byte of the code point.
function litDots(rows: { text: string }[][]): number {
  let dots = 0
  for (const row of rows) {
    for (const run of row) {
      for (const char of run.text) {
        if (isBraille(char)) {
          let bits = char.codePointAt(0)! - BRAILLE_START
          while (bits > 0) {
            dots += bits & 1
            bits >>= 1
          }
        }
      }
    }
  }
  return dots
}

function rowText(row: { text: string }[]): string {
  return row.map((run) => run.text).join('')
}

describe('Constellation (§6.1: starfield + particle mist)', () => {
  it('renders exactly height rows of exactly width cells', () => {
    const sky = new Constellation(40, 12, 7)
    const rows = sky.frame([0.2, 0.8, 0.5], ACCENT, null)
    expect(rows).toHaveLength(12)
    for (const row of rows) expect([...rowText(row)]).toHaveLength(40)
  })

  it('draws the same sky for the same seed — a resize must not reshuffle it', () => {
    const a = new Constellation(40, 12, 7).frame([], ACCENT, null)
    const b = new Constellation(40, 12, 7).frame([], ACCENT, null)
    expect(a).toEqual(b)
  })

  it('draws a different sky for a different seed', () => {
    const a = new Constellation(40, 12, 1).frame([], ACCENT, null)
    const b = new Constellation(40, 12, 2).frame([], ACCENT, null)
    expect(a).not.toEqual(b)
  })

  it('has stars but no particles in silence', () => {
    const sky = new Constellation(40, 12, 7)
    const rows = sky.frame([0, 0, 0], ACCENT, null)
    expect(litDots(rows)).toBe(0)
    const glyphs = rows.flatMap((row) => [...rowText(row)]).filter((char) => char !== ' ')
    expect(glyphs.length).toBeGreaterThan(0)
  })

  it('lights more dots the louder the frame — the mist follows the music', () => {
    const quiet = litDots(new Constellation(40, 12, 7).frame([0.2, 0.2, 0.2], ACCENT, null))
    const loud = litDots(new Constellation(40, 12, 7).frame([1, 1, 1], ACCENT, null))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
  })

  it('keeps every particle braille and every star a known glyph', () => {
    const sky = new Constellation(40, 12, 7)
    const rows = sky.frame([1, 0.5, 1], ACCENT, null)
    for (const char of rows.flatMap((row) => [...rowText(row)])) {
      expect(isBraille(char) || [' ', '·', '+', '✦'].includes(char)).toBe(true)
    }
  })

  it('blits the pet into the middle of the sky, background and all', () => {
    const pet = [
      [
        { fg: '#111111', bg: '#222222' },
        { fg: '#111111', bg: '#222222' },
      ],
    ]
    const rows = new Constellation(40, 12, 7).frame([], ACCENT, pet)
    const withPet = rows.flat().filter((run) => run.bg === '#222222')
    expect(withPet.length).toBeGreaterThan(0)
  })

  it('bows the mist floor into an arc — edge columns bottom out higher than center ones', () => {
    const rows = new Constellation(48, 20, 7).frame(Array.from({ length: 24 }, () => 0.6), ACCENT, null)
    const deepestBraille = (fromCol: number, toCol: number): number => {
      let deepest = -1
      rows.forEach((row, y) => {
        const chars = [...rowText(row)]
        for (let x = fromCol; x < toCol; x++) {
          if (isBraille(chars[x] ?? ' ')) deepest = Math.max(deepest, y)
        }
      })
      return deepest
    }
    const edge = Math.max(deepestBraille(0, 6), deepestBraille(42, 48))
    const center = deepestBraille(21, 27)
    expect(center).toBeGreaterThan(edge)
  })

  it('survives hostile bins and degenerate panels', () => {
    const sky = new Constellation(2, 2, 7)
    for (const frame of [[], [Number.NaN], [2, -1], [0.5]]) {
      const rows = sky.frame(frame, ACCENT, null)
      expect(rows).toHaveLength(2)
      for (const row of rows) expect([...rowText(row)]).toHaveLength(2)
    }
  })
})

describe('hash01 (the survival dice behind every density knob)', () => {
  it('stays inside 0..1 — a signed hash passes every threshold and defeats the knobs', () => {
    for (let x = 0; x < 200; x++) {
      for (const [y, tick] of [[0, 0], [7, 3], [-5, 11], [1000, 999]]) {
        const roll = hash01(x, y!, tick!)
        expect(roll).toBeGreaterThanOrEqual(0)
        expect(roll).toBeLessThan(1)
      }
    }
  })
})

describe('panelWidth (the one §6.1 breakpoint)', () => {
  it('declines a panel below the wide minimum', () => {
    expect(panelWidth(WIDE_MIN - 1)).toBeNull()
    expect(panelWidth(20)).toBeNull()
  })

  it('grants a panel from the minimum up, clamped to a readable band', () => {
    const atMin = panelWidth(WIDE_MIN)
    expect(atMin).not.toBeNull()
    expect(atMin!).toBeGreaterThanOrEqual(30)
    expect(panelWidth(400)!).toBeLessThanOrEqual(64)
  })
})
