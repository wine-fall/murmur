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

// The quiet-constellation ground (§6.1 art direction): a deep blue-charcoal
// night sky, constant across scenes, with warm paper ink floating on it.
export const INK = {
  bg: '#0d0f16',
  dim: '#565c6b',
  text: '#d9d2c4',
  user: '#c9a878',
  notice: '#6e7280',
}

const DEFAULT_ACCENT: Accent = { dim: '#68625a', bright: '#d9c9a8' }

// Scene keys are spec 04's (`morning` | `afternoon` | `evening` | `late-night`),
// but this is the far side of a wire: an unknown scene from a newer engine gets
// the default rather than a missing color.
//
// The §6.1 discipline: each scene is ONE near-monochrome family on the shared
// night ground — the hour changes the warmth of the light, never the room.
const ACCENTS: Record<string, Accent> = {
  morning: { dim: '#6e6656', bright: '#e8d8b0' },
  afternoon: { dim: '#67705f', bright: '#cfd9b8' },
  evening: { dim: '#7c5f4e', bright: '#e5b98c' },
  'late-night': { dim: '#49527a', bright: '#a9b9e8' },
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
