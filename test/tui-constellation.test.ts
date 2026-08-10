// The constellation panel's client half (spec 10 §3.6 / §6.1): the seeded
// ring-biased starfield, the FFT bins as a radial wave of square blocks, and
// the whisper figure at the circle's center.
//
// Like bars.ts, the module is free of OpenTUI and React on purpose: the frame
// a terminal paints cannot be unit-asserted (§3.9), but "which pixels for this
// level" can — and determinism (seeded stars, hashed jitter) is itself part of
// the contract, because a resize must not reshuffle the sky.

import { describe, expect, it } from 'vitest'

import {
  circleOf,
  Constellation,
  hash01,
  OCTANTS,
  panelWidth,
  seedStars,
  STAR_RINGS,
  waveBinAt,
  WIDE_MIN,
} from '../tui/src/constellation.ts'
import { accentFor, INK, WARM } from '../tui/src/palette.ts'
import type { Run } from '../tui/src/constellation.ts'

const ACCENT = accentFor('late-night')

function rowText(row: Run[]): string {
  return row.map((run) => run.text).join('')
}

// Cells carrying any ink (spaces are the empty ground).
function litCells(rows: Run[][]): number {
  let cells = 0
  for (const row of rows) {
    for (const run of row) {
      cells += [...run.text].filter((ch) => ch !== ' ').length
    }
  }
  return cells
}

// Per-column deepest lit cell row, over cells NOT present in the silence
// frame — which isolates the wave from the stars.
function waveDepth(rows: Run[][], silence: Run[][], fromCol: number, toCol: number): number {
  let deepest = -1
  rows.forEach((row, y) => {
    const chars = [...rowText(row)]
    const quiet = [...rowText(silence[y]!)]
    for (let x = fromCol; x < toCol; x++) {
      if (chars[x] !== ' ' && quiet[x] === ' ') deepest = Math.max(deepest, y)
    }
  })
  return deepest
}

describe('Constellation (§6.1: ring of stars, radial wave, square pixels)', () => {
  it('renders exactly height rows of exactly width cells', () => {
    const sky = new Constellation(40, 12, 7)
    const rows = sky.frame([0.2, 0.8, 0.5], ACCENT, null)
    expect(rows).toHaveLength(12)
    for (const row of rows) expect([...rowText(row)]).toHaveLength(40)
  })

  it('paints with the octant pen by default — every glyph from the mosaic table', () => {
    const allowed = new Set([...OCTANTS, ' '])
    const rows = new Constellation(40, 12, 7).frame([1, 0.5, 1], ACCENT, null)
    for (const char of rows.flatMap((row) => [...rowText(row)])) {
      expect(allowed.has(char), char).toBe(true)
    }
  })

  it('falls back to the universal half-block pen on request', () => {
    const rows = new Constellation(40, 12, 7, 'half').frame([1, 0.5, 1], ACCENT, null)
    for (const char of rows.flatMap((row) => [...rowText(row)])) {
      expect([' ', '▀']).toContain(char)
    }
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

  it('lights more pixels the louder the frame — the wave follows the music', () => {
    const silence = litCells(new Constellation(48, 20, 7).frame([], ACCENT, null))
    const quiet = litCells(new Constellation(48, 20, 7).frame([0.3, 0.3, 0.3], ACCENT, null))
    const loud = litCells(new Constellation(48, 20, 7).frame([1, 1, 1], ACCENT, null))
    expect(quiet).toBeGreaterThan(silence)
    expect(loud).toBeGreaterThan(quiet)
  })

  it('mirrors the spectrum from the center out — bass at the middle, treble at the arms', () => {
    expect(waveBinAt(0, 8)).toBe(0)
    expect(waveBinAt(0.99, 8)).toBe(7)
    expect(waveBinAt(-0.99, 8)).toBe(7)
    for (const span of [0.2, 0.5, 0.8]) {
      expect(waveBinAt(-span, 8)).toBe(waveBinAt(span, 8))
    }
  })

  it('lights both arms alike on a bass-only frame — the wave grows outward, not left-first', () => {
    const silence = new Constellation(48, 24, 7).frame([], ACCENT, null)
    // Bass alone: only the center of the arc may rise; the left arm must not
    // light up ahead of the right the way an edge-anchored mapping does.
    const rows = new Constellation(48, 24, 7).frame([1, 0, 0, 0, 0, 0, 0, 0], ACCENT, null)
    const left = waveDepth(rows, silence, 2, 12)
    const right = waveDepth(rows, silence, 36, 46)
    const center = waveDepth(rows, silence, 20, 28)
    expect(center).toBeGreaterThan(-1)
    expect(left).toBe(-1)
    expect(right).toBe(-1)
  })

  it('rides the circle: center columns bottom out deeper than the arms', () => {
    const levels = Array.from({ length: 24 }, () => 0.7)
    const silence = new Constellation(48, 24, 7).frame([], ACCENT, null)
    const rows = new Constellation(48, 24, 7).frame(levels, ACCENT, null)
    const arms = Math.max(
      waveDepth(rows, silence, 4, 10),
      waveDepth(rows, silence, 38, 44),
    )
    const center = waveDepth(rows, silence, 20, 28)
    expect(center).toBeGreaterThan(arms)
  })

  it('draws the figure at the center in cream ink', () => {
    const figure = ['xx', 'xx']
    const rows = new Constellation(40, 12, 7).frame([], ACCENT, figure)
    const cream = rows.flat().filter((run) => run.fg === INK.text && run.text.trim() !== '')
    expect(cream.length).toBeGreaterThan(0)
  })

  it('gives a fully-covered two-tone cell both inks: one on the glyph, one behind', () => {
    // 2 sub-cols x 4 sub-rows per cell: an 'xw' column pair over 4 rows fills a
    // cell with two colors and no gaps — the fold must not flatten it to one.
    const figure = Array.from({ length: 8 }, () => 'xwxw')
    const rows = new Constellation(40, 12, 7).frame([], ACCENT, figure)
    const twoTone = rows
      .flat()
      .filter((run) => run.fg === INK.text && run.bg === WARM && run.text.trim() !== '')
    expect(twoTone.length).toBeGreaterThan(0)
  })

  it('fades a dozing figure toward the room instead of swapping assets', () => {
    const figure = ['xx', 'xx']
    const awake = new Constellation(40, 12, 7).frame([], ACCENT, figure, 0)
    const dozing = new Constellation(40, 12, 7).frame([], ACCENT, figure, 0.5)
    const creamCells = (rows: Run[][]): number =>
      rows.flat().filter((run) => run.fg === INK.text && run.text.trim() !== '').length
    expect(creamCells(awake)).toBeGreaterThan(0)
    expect(creamCells(dozing)).toBe(0)
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

describe('seedStars (§6.1: ripple rings of stars + a loose free scatter)', () => {
  const subCols = 200
  const subRows = 240
  const stars = seedStars(subCols, subRows, 7)
  const { cx, cy, radius } = circleOf(subCols, subRows)
  const offRing = (star: { x: number; y: number }): number =>
    Math.min(...STAR_RINGS.map((frac) => Math.abs(Math.hypot(star.x - cx, star.y - cy) - radius * frac)))

  it('is deterministic per seed', () => {
    expect(seedStars(subCols, subRows, 7)).toEqual(stars)
    expect(seedStars(subCols, subRows, 8)).not.toEqual(stars)
  })

  it('lays the majority of stars along the concentric rings', () => {
    const onRings = stars.filter((star) => offRing(star) <= 4).length
    expect(onRings / stars.length).toBeGreaterThan(0.55)
  })

  it('spreads each ring around the circle instead of clumping', () => {
    const octants = new Set(
      stars
        .filter((star) => offRing(star) <= 4)
        .map((star) => Math.floor(((Math.atan2(star.y - cy, star.x - cx) + Math.PI) / (2 * Math.PI)) * 8)),
    )
    expect(octants.size).toBeGreaterThanOrEqual(6)
  })

  it('keeps a free scatter clear of the rings — order AND looseness', () => {
    expect(stars.filter((star) => offRing(star) > 6).length).toBeGreaterThan(5)
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
    expect(panelWidth(400)!).toBeLessThanOrEqual(110)
  })
})
