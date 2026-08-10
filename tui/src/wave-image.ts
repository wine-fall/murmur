// The grain-ripple wave (spec 10 §6.1): the spectrum spoken as stardust —
// concentric ripples of small square grains breathing out from the figure,
// inner rings carrying the bass (warm, dense), outer rings the treble (cool,
// sparse). Drawn in device pixels and streamed over the kitty graphics
// channel; character terminals keep the constellation's block wave instead.
//
// No OpenTUI and no React in here (same reasoning as constellation.ts): the
// painted frame cannot be unit-asserted, the pixel decisions can. Everything
// random is hashed from stable ids — a ripple keeps its grains as it drifts.

import { circleOf, hash01 } from './constellation.ts'
import { packPng } from './figure-image.ts'
import { EMBER, INK, mix, QUIET } from './palette.ts'

export type WaveGeom = {
  width: number
  height: number
  cx: number
  cy: number
  radius: number
  // The figure's hollow: no grain lands inside it.
  halo: number
}

// The ripple's clock: frames per second, and how many ticks one ripple takes
// to drift a whole slot outward (8 seconds — a breath, not a strobe).
export const WAVE_FPS = 12
export const WAVE_CYCLE = 96

// The ripple field, tuned by eye on the design previews (h2-dense).
const RINGS = 6
const FRAC_MIN = 0.26
const FRAC_MAX = 0.92
const GAP = (FRAC_MAX - FRAC_MIN) / (RINGS - 1)
const GRAIN_STEP = 7
const DENSITY = 1.6
// The ripple's ink runs as a continuous ramp rather than the character wave's
// three tiers: a hard low tier paints the quiet grey flat on the night, where
// small grains simply vanish (seen in a real capture). The ramp keeps a warm
// floor at the quiet end and arrives at the ember when a ring is loud.
const FLOOR = mix(QUIET, INK.text, 0.35)

// Panel cells + the terminal's cell pixel size -> the ripple's device-pixel
// frame, centered on the same implied circle the character sky uses.
export function waveGeomFor(
  cols: number,
  rows: number,
  cell: { width: number; height: number },
): WaveGeom {
  const { cx, cy, radius } = circleOf(cols * 2, rows * 4)
  const subW = cell.width / 2
  const subH = cell.height / 4
  const scale = Math.min(subW, subH)
  const r = radius * scale * 1.35
  return {
    width: cols * cell.width,
    height: rows * cell.height,
    cx: cx * subW,
    cy: cy * subH,
    radius: r,
    halo: r * 0.22,
  }
}

type Rgb = [number, number, number]

function rgbOf(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}

// What one ripple hears. A ring owns a SLICE of the spectrum rather than a
// single bin — one dead bin must not blank a whole ripple — and the mean is
// curved upward, because a real smoothed frame puts almost all its energy in
// the low bins and the outer rings would otherwise paint dead grey on the
// night. Silence stays silence: the curve lifts quiet, never nothing.
export function ringLevel(levels: readonly number[], ring: number, rings: number): number {
  if (levels.length === 0) return 0
  // The window is centered on the ring and always at least three bins wide,
  // so neighbouring ripples overlap and a coarse feed (fewer bins than rings)
  // still gives every ring something to hear.
  const center = ((ring + 0.5) / rings) * levels.length
  const half = Math.max(1, levels.length / (2 * rings))
  let from = Math.max(0, Math.round(center - half))
  let to = Math.min(levels.length, Math.max(Math.round(center + half), from + 1))
  // Clamping at either end can collapse the window onto a single bin; grow it
  // back along the feed so an edge ring still hears its neighbours.
  const want = Math.min(Math.max(Math.round(2 * half), 3), levels.length)
  while (to - from < want) {
    if (from > 0) from--
    else if (to < levels.length) to++
    else break
  }
  let sum = 0
  for (let i = from; i < to; i++) sum += clamp01(levels[i]!)
  const mean = sum / (to - from)
  return mean === 0 ? 0 : clamp01(Math.sqrt(mean) * 0.92)
}

// Straight-alpha RGBA, geom.width x geom.height, transparent ground. A grain
// writes its ink at full color and carries the energy in alpha; overlaps keep
// the brighter grain.
export function waveRgba(
  levels: readonly number[],
  tick: number,
  geom: WaveGeom,
  accentBright: string,
): Buffer {
  const rgba = Buffer.alloc(geom.width * geom.height * 4)
  if (levels.length === 0) return rgba
  // A smoothed frame rarely pins a bin, so the ramp reaches the accent early
  // and spends its top half climbing to the ember.
  const heat = (lv: number): Rgb =>
    rgbOf(
      lv < 0.4 ? mix(FLOOR, accentBright, lv / 0.4) : mix(accentBright, EMBER, (lv - 0.4) / 0.6),
    )
  const span = FRAC_MAX + GAP - FRAC_MIN
  const lap = Math.floor(tick / WAVE_CYCLE)
  const phase = (tick % WAVE_CYCLE) / WAVE_CYCLE
  const grain = (x: number, y: number, size: number, ink: Rgb, alpha: number): void => {
    for (let yy = Math.round(y); yy < Math.round(y) + size; yy++) {
      for (let xx = Math.round(x); xx < Math.round(x) + size; xx++) {
        if (xx < 0 || xx >= geom.width || yy < 0 || yy >= geom.height) continue
        // The hollow is checked per PIXEL, not per grain center: a grain is a
        // square drawn from its center and would otherwise bleed into the
        // figure's space at the ripple's closest phases.
        if (Math.hypot(xx - geom.cx, yy - geom.cy) < geom.halo) continue
        const at = (yy * geom.width + xx) * 4
        const a = Math.round(clamp01(alpha) * 255)
        if (a <= rgba[at + 3]!) continue
        rgba[at] = ink[0]
        rgba[at + 1] = ink[1]
        rgba[at + 2] = ink[2]
        rgba[at + 3] = a
      }
    }
  }
  for (let ri = 0; ri < RINGS; ri++) {
    // A ripple keeps one identity while it drifts outward across cycle
    // boundaries; the ripple born at the center each cycle draws fresh dice.
    const rippleId = (((ri - lap) % 8192) + 8192) % 8192
    const frac0 = FRAC_MIN + (ri + phase) * GAP
    const frac = frac0 > FRAC_MAX + GAP / 2 ? frac0 - span : frac0
    const pos = (frac - FRAC_MIN) / span
    const band = ringLevel(levels, Math.min(Math.floor(clamp01(pos) * RINGS), RINGS - 1), RINGS)
    if (band < 0.02) continue
    // Born at the hollow, gone at the rim: fade both ends of the drift.
    const edge = 0.35 + 0.65 * (Math.min(pos, 1 - pos, 0.2) / 0.2)
    const baseR = geom.radius * frac * (0.94 + 0.12 * band)
    const grains = Math.round(((2 * Math.PI * baseR) / GRAIN_STEP) * DENSITY * (0.25 + 0.75 * band))
    const twinkleBucket = Math.floor(tick / 4)
    for (let g = 0; g < grains; g++) {
      const theta = hash01(rippleId * 977 + g, 1, 1) * 2 * Math.PI
      const wobble =
        1 +
        0.05 * Math.sin(theta * 3 + hash01(rippleId, 2, 2) * 6.28) +
        0.03 * Math.sin(theta * 5 + hash01(rippleId, 3, 3) * 6.28)
      // Grains hug their ripple: a wide scatter smears the ring into haze and
      // loses most of its alpha to the falloff — the arc has to read as an arc.
      const spread = (hash01(rippleId * 977 + g, 4, 4) - 0.5) * (5 + 15 * band)
      const dist = baseR * wobble + spread
      if (dist < geom.halo) continue
      const x = geom.cx + Math.sin(theta) * dist
      const y = geom.cy + Math.cos(theta) * dist * 0.98
      const off = Math.abs(spread) / (5 + 16 * band)
      const twinkle = 0.78 + 0.22 * hash01(rippleId * 7919 + g, 9, twinkleBucket)
      const alpha = (0.46 + 0.54 * band) * Math.exp(-off * off) * edge * twinkle
      if (alpha < 0.02) continue
      const sizeRoll = hash01(rippleId * 977 + g, 5, 5)
      const size = sizeRoll < 0.12 * band ? 4 : sizeRoll < 0.45 ? 3 : 2
      const tone = band * (0.75 + 0.5 * hash01(rippleId * 977 + g, 6, 6))
      grain(x, y, size, heat(clamp01(tone)), alpha)
    }
  }
  return rgba
}

// One frame of the ripple as a PNG the graphics channel can carry.
export function encodeWavePng(
  levels: readonly number[],
  tick: number,
  geom: WaveGeom,
  accentBright: string,
): Buffer {
  const rgba = waveRgba(levels, tick, geom, accentBright)
  const raw = Buffer.alloc(geom.height * (1 + geom.width * 4))
  for (let y = 0; y < geom.height; y++) {
    rgba.copy(raw, y * (1 + geom.width * 4) + 1, y * geom.width * 4, (y + 1) * geom.width * 4)
  }
  return packPng(geom.width, geom.height, raw)
}
