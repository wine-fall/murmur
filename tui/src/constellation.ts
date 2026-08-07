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

// The mist floor is an arc, not a flat line (§6.1): high at the panel's edges,
// dipping at the center, the pet floating in the hollow. Fractions of the
// panel's sub-pixel height, measured from the top.
const ARC_EDGE = 0.5
const ARC_DIP = 0.86

// How much of the panel the mist may climb at full level, in sub-pixel rows.
const MIST_CEILING = 0.45

// Peak dot density — the mist is scattered squares with dark between them,
// never a filled bar; density thins toward a column's top edge, and every dot
// is jittered a couple of sub-rows so cells rarely clump into heavy braille
// blocks — isolated dots are what read as fine grain.
const MIST_DENSITY = 0.62
const JITTER_SUBROWS = 3

// The sparse trail under the floor.
const FALLOUT_ROWS = 6
const FALLOUT_DENSITY = 0.18

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
// Exported for its regression test: the final XOR must be forced back to
// unsigned, or half of all hashes come out negative and pass any threshold.
export function hash01(x: number, y: number, tick: number): number {
  let mixed = (Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263) + Math.imul(tick, 2_246_822_519)) >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 13), 1_274_126_177) >>> 0
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4_294_967_296
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

    // The mist: scattered surviving dots per sub-pixel column, climbing from
    // the arced floor, with a thin fallout drifting below it.
    const bucket = Math.floor(tick / SHIMMER_DIVISOR)
    const dot = (sc: number, fromTop: number): void => {
      if (fromTop < 0 || fromTop >= subRows) return
      bits[Math.floor(fromTop / 4)]![Math.floor(sc / 2)]! |= DOT_BITS[fromTop % 4]![sc % 2]!
    }
    for (let sc = 0; sc < subCols; sc++) {
      const level =
        levels.length === 0 ? 0 : clamp01(levels[Math.floor((sc / subCols) * levels.length)]!)
      if (level === 0) continue
      // -1..1 across the panel; the floor bows from ARC_EDGE down to ARC_DIP,
      // and the mist thins out before it can hit the panel's side walls.
      const across = (2 * sc) / subCols - 1
      const fade = Math.min(1, (1 - Math.abs(across)) / 0.25)
      const floor = Math.floor(subRows * (ARC_DIP - (ARC_DIP - ARC_EDGE) * across * across))
      const target = level * subRows * MIST_CEILING
      for (let up = 0; up < target; up++) {
        const density = fade * MIST_DENSITY * (1 - (0.85 * up) / target)
        if (hash01(sc, up, bucket) >= density) continue
        const jitter = Math.floor((hash01(sc, up + 1000, bucket) - 0.5) * JITTER_SUBROWS)
        dot(sc, floor - up + jitter)
      }
      for (let down = 1; down <= FALLOUT_ROWS; down++) {
        if (hash01(sc, -down, bucket) < fade * FALLOUT_DENSITY * level) dot(sc, floor + down)
      }
    }

    // The pet floats above the mist floor, centred — with one clear cell of
    // halo so it sits IN the sky rather than on top of it.
    const petRows = pet?.length ?? 0
    const petCols = petRows > 0 ? pet![0]!.length : 0
    const fits = petRows > 0 && petCols <= this.width && petRows <= this.height
    // Centred in the arc's hollow: the figure floats where the floor dips.
    const petX = fits ? Math.floor((this.width - petCols) / 2) : 0
    const petY = fits ? Math.max(Math.floor(this.height * 0.4) - Math.floor(petRows / 2), 0) : 0

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
