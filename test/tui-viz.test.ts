// The client half of the visualizer (spec 10 §3.6: "the DSP lives engine-side,
// the pretty lives client-side") and the accent palette (§3.7.2).
//
// These modules are deliberately free of OpenTUI and React so the fast layer can
// hold them: the rendering that CANNOT be unit-asserted is the frame OpenTUI
// paints (§3.9), not the arithmetic that decides what goes in it. The client
// still reaches into the engine for nothing but src/host/ipc.ts — a test importing a
// pure client module adds no dependency to either side.

import { describe, expect, it } from 'vitest'

import { Bars, render } from '../tui/src/bars.ts'
import { accentFor, mix } from '../tui/src/palette.ts'

const FULL = '█'
const EMPTY = ' '

describe('render (cava recipe: eighth-block bars)', () => {
  it('draws a grid of the asked-for height and one column per bar', () => {
    const rows = render([0, 0.5, 1], 4)
    expect(rows).toHaveLength(4)
    for (const row of rows) expect([...row]).toHaveLength(3)
  })

  it('reads silence as an empty strip and a full frame as a full one', () => {
    expect(render([0, 0, 0], 3).join('')).toBe(EMPTY.repeat(9))
    expect(render([1, 1, 1], 3).join('')).toBe(FULL.repeat(9))
  })

  it('fills from the bottom up, not the top down', () => {
    const rows = render([0.5], 4)
    expect(rows.at(-1)).toBe(FULL)
    expect(rows[0]).toBe(EMPTY)
  })

  it('spends the eighth-blocks on the partial row, so a short bar still shows', () => {
    // A single row of resolution would render anything under 1/height as blank;
    // the whole point of the eighths is that a quiet bed still breathes.
    const rows = render([0.05], 4)
    expect(rows.at(-1)).not.toBe(EMPTY)
    expect(rows.at(-1)).not.toBe(FULL)
  })

  it('never loses height as a bar gets louder', () => {
    let filled = -1
    for (let level = 0; level <= 1.0001; level += 0.01) {
      const painted = render([level], 4)
        .join('')
        .split('')
        .filter((glyph) => glyph !== EMPTY).length
      expect(painted).toBeGreaterThanOrEqual(filled)
      filled = painted
    }
  })

  it('clamps a frame from a peer that sends nonsense', () => {
    const rows = render([-5, 5, Number.NaN], 2)
    expect(rows[0]![1]).toBe(FULL)
    expect(rows.at(-1)![0]).toBe(EMPTY)
    expect(rows.at(-1)![2]).toBe(EMPTY)
  })
})

describe('Bars (per-bin attack/decay smoothing)', () => {
  it('rises toward a loud frame instead of snapping to it', () => {
    const bars = new Bars()
    bars.push([1])
    const first = bars.levels()[0]!
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(1)
    bars.push([1])
    expect(bars.levels()[0]!).toBeGreaterThan(first)
  })

  it('falls back slower than it rises — the bar hangs, then drops', () => {
    const bars = new Bars()
    for (let i = 0; i < 40; i++) bars.push([1])
    const loud = bars.levels()[0]!
    expect(loud).toBeGreaterThan(0.9)
    bars.push([0])
    const afterOne = bars.levels()[0]!
    expect(afterOne).toBeLessThan(loud)
    expect(loud - afterOne).toBeLessThan(1 - loud + 0.5)
    for (let i = 0; i < 60; i++) bars.push([0])
    expect(bars.levels()[0]!).toBeLessThan(0.01)
  })

  it('keeps every level inside 0..1 whatever the engine sends', () => {
    const bars = new Bars()
    for (const frame of [[2, -1], [Number.NaN, 0.5], [1, 1]]) {
      bars.push(frame)
      for (const level of bars.levels()) {
        expect(Number.isFinite(level)).toBe(true)
        expect(level).toBeGreaterThanOrEqual(0)
        expect(level).toBeLessThanOrEqual(1)
      }
    }
  })

  it('follows a change in bin count instead of rendering a stale width', () => {
    const bars = new Bars()
    bars.push([1, 1, 1])
    expect(bars.levels()).toHaveLength(3)
    bars.push([1, 1])
    expect(bars.levels()).toHaveLength(2)
  })

  it('starts out flat, so an unattached strip is quiet rather than random', () => {
    expect(new Bars().levels()).toEqual([])
  })
})

describe('the accent palette (spec 10 §3.7.2)', () => {
  it('gives every time-of-day scene its own accent', () => {
    const scenes = ['morning', 'afternoon', 'evening', 'late-night']
    const accents = scenes.map((scene) => accentFor(scene).bright)
    expect(new Set(accents).size).toBe(scenes.length)
  })

  it('falls back to one warm default for an unknown or absent scene', () => {
    expect(accentFor(undefined)).toEqual(accentFor('a scene from a later spec'))
  })

  it('mixes two colors on a ramp, endpoints exact', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    // Out-of-range t clamps rather than producing an unparseable color.
    expect(mix('#000000', '#ffffff', -1)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 9)).toBe('#ffffff')
  })
})
