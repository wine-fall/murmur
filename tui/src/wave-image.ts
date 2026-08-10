// The stardust wave (spec 10 §6.1): the spectrum spoken as grains blown
// outward from the figure. Each direction around the circle carries one band —
// bass straight down, treble sweeping up both sides, mirrored left to right —
// and its grains stream out as far and as thick as that band is loud, thinning
// as they go. Drawn in device pixels and streamed over the kitty graphics
// channel; character terminals keep the constellation's block wave instead.
//
// No OpenTUI and no React in here (same reasoning as constellation.ts): the
// painted frame cannot be unit-asserted, the pixel decisions can. Everything
// random is hashed from stable ids, so a grain keeps its lane while it flies.

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

// The wave's clock. Every frame is a full-panel image the terminal must decode
// and composite, so the rate is deliberately below the sky's: this is drifting
// dust, and 8fps reads the same as 12 while costing a third less.
export const WAVE_FPS = 8
// Ticks for a grain to travel its whole flight, out and respawned at the
// hollow — 6 seconds, a drift rather than a pulse.
export const WAVE_CYCLE = 48

// The burst field, tuned by eye on the design preview (v2-particle-burst).
const SECTORS = 180
const GRAINS_MAX = 26
const INNER = 0.3
// How much of a band's energy the grains spend on reach vs on staying near.
const REACH = 0.75
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

// Which band a direction carries. theta is measured from straight DOWN, so the
// bass sits under the figure and the treble sweeps up both sides; left and
// right mirror each other, which is why the wave blooms outward rather than
// marching across.
export function bandAt(theta: number, bands: number): number {
  const wrapped = Math.abs(((theta + Math.PI) % (2 * Math.PI)) - Math.PI) / Math.PI
  return Math.min(Math.floor(wrapped * bands), bands - 1)
}

// What one direction hears. A band owns a SLICE of the spectrum rather than a
// single bin — one dead bin must not blank a whole sector — and the mean is
// curved upward, because a real smoothed frame puts almost all its energy in
// the low bins and the outer bands would otherwise paint dead grey on the
// night. Silence stays silence: the curve lifts quiet, never nothing.
export function ringLevel(levels: readonly number[], ring: number, rings: number): number {
  if (levels.length === 0) return 0
  // The window is centered on the band and always at least three bins wide,
  // so neighbouring sectors overlap and a coarse feed (fewer bins than bands)
  // still gives every direction something to hear.
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
  const inner = geom.radius * INNER
  for (let sector = 0; sector < SECTORS; sector++) {
    const theta = (sector / SECTORS) * 2 * Math.PI - Math.PI
    const band = ringLevel(levels, bandAt(theta, SECTORS / 6), SECTORS / 6)
    if (band < 0.02) continue
    // Ink and alpha ride the lifted level so a quiet direction still reads,
    // but DENSITY rides the raw energy — lifting that too flattens the burst
    // into an even donut and loses the loud directions entirely.
    const raw = band * band
    const count = Math.round(1 + raw * GRAINS_MAX)
    for (let g = 0; g < count; g++) {
      // Every grain owns a lane and a starting place in the flight; the phase
      // carries it outward and wraps it back to the hollow, so the dust
      // streams continuously instead of pulsing as one body.
      const along = ((hash01(sector, g, 11) + phase) % 1) ** 0.7
      const dist = inner + along * (geom.radius - inner) * (0.25 + REACH * raw)
      if (dist < geom.halo) continue
      const lane = theta + (hash01(sector, g, 23) - 0.5) * 0.09
      const x = geom.cx + Math.sin(lane) * dist
      const y = geom.cy + Math.cos(lane) * dist
      // Thinning as it flies: a grain spends its light on the distance.
      const alpha = (1 - along) * (0.45 + 0.55 * band)
      if (alpha < 0.02) continue
      const sizeRoll = hash01(sector, g, 31)
      const size = sizeRoll < 0.15 * band ? 4 : sizeRoll < 0.5 ? 3 : 2
      grain(x, y, size, heat(clamp01(band * (1 - along * 0.5))), alpha)
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
