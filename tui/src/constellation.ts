// The quiet-constellation panel (spec 10 §6.1): a seeded starfield, the FFT
// bins re-rendered as a braille particle mist rising from the panel floor, and
// the pet floating in the middle of it. This is the wide-terminal composition
// of the alive band; bars.ts remains the narrow one.
//
// No OpenTUI and no React in here, same reasoning as bars.ts: the painted frame
// cannot be unit-asserted (§3.9), the arithmetic can. Everything random is
// seeded or hashed — the sky must survive a re-render without reshuffling, and
// a test must be able to hold two instances to the same frame.

import { INK, mix, type Accent } from './palette.ts'
import type { Cell } from './pet.ts'

export type Run = { text: string; fg: string; bg?: string | undefined }

// Below this many columns the two-column composition has no room to breathe and
// the client keeps the classic bottom band (§6.1's single breakpoint).
export const WIDE_MIN = 96

// The panel's share of a wide terminal, clamped to where the mist still reads:
// narrower has no sky, wider turns the log into a sidebar.
export function panelWidth(cols: number): number | null {
  if (cols < WIDE_MIN) return null
  return Math.min(Math.max(Math.round(cols * 0.42), 32), 64)
}

// Braille dot bits by [row-in-cell][column-in-cell], top row first.
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

const BRAILLE_BASE = 0x28_00

// The mist floats: its baseline hangs at this fraction of the panel's height,
// dots climb from there and a thin fallout drifts below — glued to the panel
// floor it reads as a bar chart, not a sky.
const BASELINE = 0.78

// How much of the panel the mist may climb at full level, in sub-pixel rows.
const MIST_CEILING = 0.55

// Peak dot density — the mist is scattered squares with dark between them,
// never a filled bar; density thins toward a column's top edge.
const MIST_DENSITY = 0.32

// The sparse trail under the baseline.
const FALLOUT_ROWS = 5
const FALLOUT_DENSITY = 0.12

// Stars per cell, roughly — sparse enough to stay a sky, not a texture.
const STAR_DENSITY = 0.03

// The mist shimmers slower than the 24fps feed, or it reads as static noise.
const SHIMMER_DIVISOR = 4

type Star = { x: number; y: number; glyph: string; phase: number }

const STAR_GLYPHS = ['·', '·', '·', '+', '✦'] as const

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}

// mulberry32 — one small seeded PRNG so the field is stable per seed.
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

// Deterministic per-dot jitter: same dot, same tick bucket, same verdict.
function hash01(x: number, y: number, tick: number): number {
  let mixed = (Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263) + Math.imul(tick, 2_246_822_519)) >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 13), 1_274_126_177) >>> 0
  return (mixed ^ (mixed >>> 16)) / 4_294_967_296
}

export class Constellation {
  private readonly stars: Star[]
  private readonly width: number
  private readonly height: number
  private tick = 0

  constructor(width: number, height: number, seed = 1) {
    this.width = width
    this.height = height
    const rand = prng(seed)
    const stars: Star[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rand() < STAR_DENSITY) {
          stars.push({
            x,
            y,
            glyph: STAR_GLYPHS[Math.floor(rand() * STAR_GLYPHS.length)]!,
            phase: rand(),
          })
        }
      }
    }
    this.stars = stars
  }

  // One painted frame: levels are the engine's 0..1 bins (empty = silence), pet
  // is pre-folded half-block cells (pet.ts `cells`) or null for a hidden pet.
  frame(levels: readonly number[], accent: Accent, pet: Cell[][] | null): Run[][] {
    const tick = this.tick++
    const subCols = this.width * 2
    const subRows = this.height * 4
    const bits = Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => 0))

    // The mist: scattered surviving dots per sub-pixel column, climbing from a
    // floating baseline, with a thin fallout drifting below it.
    const baseline = Math.floor(subRows * BASELINE)
    const bucket = Math.floor(tick / SHIMMER_DIVISOR)
    const dot = (sc: number, fromTop: number): void => {
      if (fromTop < 0 || fromTop >= subRows) return
      bits[Math.floor(fromTop / 4)]![Math.floor(sc / 2)]! |= DOT_BITS[fromTop % 4]![sc % 2]!
    }
    for (let sc = 0; sc < subCols; sc++) {
      const level =
        levels.length === 0 ? 0 : clamp01(levels[Math.floor((sc / subCols) * levels.length)]!)
      if (level === 0) continue
      const target = level * subRows * MIST_CEILING
      for (let up = 0; up < target; up++) {
        const density = MIST_DENSITY * (1 - (0.85 * up) / target)
        if (hash01(sc, up, bucket) < density) dot(sc, baseline - up)
      }
      for (let down = 1; down <= FALLOUT_ROWS; down++) {
        if (hash01(sc, -down, bucket) < FALLOUT_DENSITY * level) dot(sc, baseline + down)
      }
    }

    // The pet floats above the mist floor, centred — with one clear cell of
    // halo so it sits IN the sky rather than on top of it.
    const petRows = pet?.length ?? 0
    const petCols = petRows > 0 ? pet![0]!.length : 0
    const fits = petRows > 0 && petCols <= this.width && petRows <= this.height
    // Centred in the cloud's own region, not the panel's: the creature drifts
    // IN the mist, a little above the baseline.
    const petX = fits ? Math.floor((this.width - petCols) / 2) : 0
    const petY = fits ? Math.max(Math.floor(this.height * 0.52) - Math.floor(petRows / 2), 0) : 0

    const starAt = new Map<number, Star>()
    for (const star of this.stars) starAt.set(star.y * this.width + star.x, star)

    const rows: Run[][] = []
    for (let y = 0; y < this.height; y++) {
      const runs: Run[] = []
      const put = (text: string, fg: string, bg?: string): void => {
        const last = runs.at(-1)
        if (last !== undefined && last.fg === fg && last.bg === bg) last.text += text
        else runs.push({ text, fg, bg })
      }
      for (let x = 0; x < this.width; x++) {
        if (fits && y >= petY && y < petY + petRows && x >= petX && x < petX + petCols) {
          const cell = pet![y - petY]![x - petX]!
          put('▀', cell.fg, cell.bg)
          continue
        }
        const halo =
          fits &&
          y >= petY - 1 &&
          y <= petY + petRows &&
          x >= petX - 1 &&
          x <= petX + petCols
        const dots = halo ? 0 : bits[y]![x]!
        if (dots !== 0) {
          let lit = 0
          for (let bit = dots; bit > 0; bit >>= 1) lit += bit & 1
          put(String.fromCodePoint(BRAILLE_BASE + dots), mix(accent.dim, accent.bright, lit / 8))
          continue
        }
        const star = halo ? undefined : starAt.get(y * this.width + x)
        if (star === undefined) {
          put(' ', INK.dim)
          continue
        }
        // A slow triangle-wave twinkle, phase-shifted per star.
        const beat = (tick / 48 + star.phase) % 1
        const twinkle = beat < 0.5 ? beat * 2 : (1 - beat) * 2
        const ink =
          star.glyph === '✦'
            ? mix(accent.dim, accent.bright, twinkle)
            : mix(INK.dim, INK.text, twinkle * 0.6)
        put(star.glyph, ink)
      }
      rows.push(runs)
    }
    return rows
  }
}
