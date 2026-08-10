// The grain-ripple raster wave (spec 10 §6.1): stardust rings breathing out
// from the figure. The PNG bytes are deterministic wire format — the frame a
// terminal shows cannot be unit-asserted (§3.9), but every pixel decision can.

import { describe, expect, it } from 'vitest'

import { INK } from '../tui/src/palette.ts'
import { encodeWavePng, ringLevel, waveGeomFor, waveRgba, WAVE_CYCLE } from '../tui/src/wave-image.ts'

// The user's real panel: 83x45 cells at 9x25 device px.
const GEOM = waveGeomFor(83, 45, { width: 9, height: 25 })
const LOUD = Array.from({ length: 24 }, (_, i) => Math.exp(-i / 9))
const ACCENT = '#d5ccb8'

function litPixels(rgba: Buffer): number {
  let lit = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 0) lit++
  return lit
}

describe('waveGeomFor (panel cells to device pixels)', () => {
  it('centers the ripple on the constellation circle', () => {
    expect(GEOM.width).toBe(83 * 9)
    expect(GEOM.height).toBe(45 * 25)
    expect(GEOM.cx).toBeCloseTo(GEOM.width / 2, 0)
    expect(GEOM.cy / GEOM.height).toBeCloseTo(0.44, 1)
    expect(GEOM.radius).toBeGreaterThan(0)
    expect(GEOM.halo).toBeGreaterThan(0)
  })
})

describe('waveRgba (the grains themselves)', () => {
  it('is deterministic per (levels, tick)', () => {
    expect(waveRgba(LOUD, 17, GEOM, ACCENT).equals(waveRgba(LOUD, 17, GEOM, ACCENT))).toBe(true)
  })

  it('paints nothing for silence — a transparent frame, not a dim one', () => {
    expect(litPixels(waveRgba([], 5, GEOM, ACCENT))).toBe(0)
    expect(litPixels(waveRgba([0, 0, 0, 0], 5, GEOM, ACCENT))).toBe(0)
  })

  it('scatters more grains the louder the frame', () => {
    const quiet = litPixels(waveRgba(LOUD.map((l) => l * 0.25), 5, GEOM, ACCENT))
    const loud = litPixels(waveRgba(LOUD, 5, GEOM, ACCENT))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
  })

  it('keeps the figure hollow and stays inside the panel, at every tick', () => {
    // A grain is a square drawn FROM its center, so a center that clears the
    // hollow can still bleed pixels into it — and a ripple only reaches the
    // hollow's edge at some phases of its drift.
    const bassy = Array.from({ length: 24 }, (_, i) => Math.exp(-i / 6) * 0.7)
    for (const tick of [0, 5, 17, 49, 61, 95]) {
      for (const levels of [LOUD, bassy]) {
        const rgba = waveRgba(levels, tick, GEOM, ACCENT)
        for (let i = 3; i < rgba.length; i += 4) {
          if (rgba[i]! === 0) continue
          const px = ((i - 3) / 4) % GEOM.width
          const py = Math.floor((i - 3) / 4 / GEOM.width)
          const dist = Math.hypot(px - GEOM.cx, py - GEOM.cy)
          expect(dist).toBeGreaterThanOrEqual(GEOM.halo)
          expect(dist).toBeLessThan(GEOM.radius * 1.15)
        }
      }
    }
  })

  it('breathes: the ripple drifts across the cycle instead of freezing', () => {
    const early = waveRgba(LOUD, 0, GEOM, ACCENT)
    const late = waveRgba(LOUD, Math.floor(WAVE_CYCLE / 2), GEOM, ACCENT)
    expect(early.equals(late)).toBe(false)
  })
})

describe('ringLevel (a ripple reads a slice of the spectrum, not one bin)', () => {
  it('averages its slice, so one dead bin does not blank a ring', () => {
    const spiky = [1, 0, 1, 0, 1, 0, 1, 0]
    for (let ring = 0; ring < 6; ring++) expect(ringLevel(spiky, ring, 6)).toBeGreaterThan(0.2)
  })

  it('holds its window open at the edges of a feed coarser than the rings', () => {
    // Fewer bins than rings: the outermost ring's window must not collapse
    // onto one dead edge bin while its neighbours carry energy.
    for (let ring = 0; ring < 6; ring++) {
      expect(ringLevel([1, 0, 1, 0], ring, 6)).toBeGreaterThan(0)
      expect(ringLevel([0, 1, 0, 1], ring, 6)).toBeGreaterThan(0)
    }
  })

  it('keeps a bass-tilted frame ordered inner-loud to outer-quiet', () => {
    const real = Array.from({ length: 24 }, (_, i) => Math.exp(-i / 6) * 0.7)
    const rings = Array.from({ length: 6 }, (_, ring) => ringLevel(real, ring, 6))
    for (let ring = 1; ring < rings.length; ring++) {
      expect(rings[ring]!).toBeLessThan(rings[ring - 1]!)
      expect(rings[ring]!).toBeGreaterThan(0)
    }
  })

  it('still reports silence as silence', () => {
    expect(ringLevel([0, 0, 0, 0], 2, 6)).toBe(0)
    expect(ringLevel([], 0, 6)).toBe(0)
  })
})

describe('the ripple reads against the night', () => {
  const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b
  const bg = [INK.bg.slice(1, 3), INK.bg.slice(3, 5), INK.bg.slice(5, 7)].map((h) =>
    Number.parseInt(h, 16),
  ) as [number, number, number]
  const groundLuma = luma(...bg)

  // What a grain actually looks like on screen: its ink composited over the
  // room at its own alpha. A grain that lands within a few levels of the
  // ground is invisible however "warm" its nominal ink was.
  function meanGrainLuma(rgba: Buffer): number {
    let sum = 0
    let n = 0
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3]! / 255
      if (a === 0) continue
      const over = (c: number, ground: number): number => rgba[i + c]! * a + ground * (1 - a)
      sum += luma(over(0, bg[0]), over(1, bg[1]), over(2, bg[2]))
      n++
    }
    return n === 0 ? groundLuma : sum / n
  }

  it('lifts an ordinary smoothed frame clear of the ground', () => {
    // Energy concentrated low, treble near-silent — the shape a real frame has
    // after Bars smoothing. Every ripple must still read (a real capture had
    // the outer ones painting near-black on near-black).
    const real = Array.from({ length: 24 }, (_, i) => Math.exp(-i / 6) * 0.7)
    expect(meanGrainLuma(waveRgba(real, 5, GEOM, ACCENT))).toBeGreaterThan(groundLuma + 30)
  })

  it('burns brighter still when everything is loud', () => {
    const quiet = meanGrainLuma(
      waveRgba(
        Array.from({ length: 24 }, (_, i) => Math.exp(-i / 6) * 0.7),
        5,
        GEOM,
        ACCENT,
      ),
    )
    const loud = meanGrainLuma(waveRgba(Array.from({ length: 24 }, () => 1), 5, GEOM, ACCENT))
    expect(loud).toBeGreaterThan(quiet)
  })
})

describe('encodeWavePng (the wire format)', () => {
  it('emits a valid PNG at panel size', () => {
    const png = encodeWavePng(LOUD, 5, GEOM, ACCENT)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(16)).toBe(GEOM.width)
    expect(png.readUInt32BE(20)).toBe(GEOM.height)
  })
})
