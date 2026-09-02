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

// The quiet-constellation ground (§6.1 art direction), every value sampled
// from the 04 concept itself: a deep blue-black night, and — the design's
// defining temperature — WARM greys for everything quiet. The only cold ink
// in the whole room is the periwinkle the listener types in.
export const INK = {
  bg: '#090e17',
  dim: '#4a4642',
  text: '#ddd0c0',
  // The listener's ink is sage — the one green in the room.
  user: '#96a47e',
  notice: '#787068',
}

// The three temperatures of the constellation wave (§6.1, sampled from the 04
// concept): peach-ember peaks over cream mids over a warm quiet grey, the
// same trio the stars borrow.
export const EMBER = '#eab48c'
export const QUIET = '#5e5852'
// The figure's outline ink, sampled from the designer's own figure: the
// whisper-girl is two-tone — cream fill inside a warm brown line.
export const WARM = '#b07849'
// The listener's channel: the input line and the now-playing note glyph,
// the room's one cold accent.
export const PERIWINKLE = '#a4aede'

// The spotlight card's ground (§3.2-B as built): a step above the night, so
// the card reads as the one lit thing while the room is hushed. CHIP is the
// raised ground of the card's default choice.
export const CARD = '#0c1526'
export const CHIP = '#1a2540'

// The spotlight card's role ink (§3.2-B as built): the card's ASCII role
// markers each carry their own light. A gap is the one thing on the card that
// isn't fine — it takes the ember, so it can never be mistaken for one more
// quiet hint sitting beside the options.
export const CARD_INK = {
  main: INK.text,
  note: INK.notice,
  ready: INK.user,
  gap: EMBER,
  option: INK.notice,
} as const

// The spotlight dim (§3.2-B as built): while a question is on the card, the
// whole room steps down one notch — same hue, less light. One function so the
// palette stays the single point of color truth.
export function hush(color: string): string {
  return mix(color, INK.bg, 0.55)
}

const DEFAULT_ACCENT: Accent = { dim: '#6e665a', bright: '#c9bda8' }

// Scene keys are spec 04's (`morning` | `afternoon` | `evening` | `late-night`),
// but this is the far side of a wire: an unknown scene from a newer engine gets
// the default rather than a missing color.
//
// The §6.1 discipline: each scene is ONE near-monochrome family on the shared
// night ground — the hour changes the warmth of the light, never the room.
const ACCENTS: Record<string, Accent> = {
  morning: { dim: '#776e60', bright: '#ddd0c0' },
  afternoon: { dim: '#6e6a5e', bright: '#d5ccb8' },
  evening: { dim: '#7c624e', bright: '#e0b088' },
  'late-night': { dim: '#4e5878', bright: '#a8b6dd' },
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
