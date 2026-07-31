// The accent palette (spec 10 §3.7.2): one small palette the whole interface
// borrows from, swapped at segment boundaries so the UI breathes with the
// program instead of sitting in one fixed skin.
//
// v1 derives it from the time-of-day scene the engine already sends on every
// `state` — the fallback the spec allows while per-track art stays an open
// question (§6). Swapping the SOURCE later touches only `accentFor`; every
// caller keeps asking for "the accent right now".

export type Accent = {
  // The gradient the visualizer climbs, and the ink the status strip is written
  // in: `dim` at rest, `bright` at the top.
  dim: string
  bright: string
}

// Deep warm ink, constant across scenes — the room the accents light up.
export const INK = {
  bg: '#161310',
  dim: '#7d7166',
  text: '#e8ded2',
  user: '#9fc3a8',
  notice: '#8d8378',
}

const DEFAULT_ACCENT: Accent = { dim: '#8a5a3c', bright: '#f2c078' }

// Scene keys are spec 04's (`morning` | `afternoon` | `evening` | `late-night`),
// but this is the far side of a wire: an unknown scene from a newer engine gets
// the default rather than a missing color.
const ACCENTS: Record<string, Accent> = {
  morning: { dim: '#7c6a3f', bright: '#ffd98a' },
  afternoon: { dim: '#6f6a4a', bright: '#e8dfa8' },
  evening: { dim: '#8a4a3c', bright: '#f29a6b' },
  'late-night': { dim: '#3f4a7c', bright: '#9fb4f2' },
}

export function accentFor(scene: string | undefined): Accent {
  return (scene === undefined ? undefined : ACCENTS[scene]) ?? DEFAULT_ACCENT
}

function channel(hex: string, at: number): number {
  return Number.parseInt(hex.slice(at, at + 2), 16)
}

// Linear ramp between two #rrggbb colors. Used for the visualizer's vertical
// gradient and for fading the pet's ink toward the room when it dozes.
export function mix(from: string, to: string, t: number): string {
  const at = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1)
  let out = '#'
  for (const offset of [1, 3, 5]) {
    const a = channel(from, offset)
    const b = channel(to, offset)
    out += Math.round(a + (b - a) * at)
      .toString(16)
      .padStart(2, '0')
  }
  return out
}
