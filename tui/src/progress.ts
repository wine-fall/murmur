// The now-playing progress bar (spec 10 §3.3). The engine sends a track's
// length and the epoch ms it went on air; everything the rail needs after that
// is arithmetic on the client's own clock, so a playing song costs no traffic.
//
// No OpenTUI and no React in here, for the same reason bars.ts has none: the
// frame cannot be unit-asserted, but "which glyph for this fraction" can.

// Left-to-right eighths. Index 0 is nothing, 8 is a full cell.
const EIGHTHS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

// The unplayed rail: a rule rather than blanks, so the bar's full length reads
// as the track's length even at the very start.
const RAIL = '─'

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}

// A track time as a listener says it: m:ss, with an hours field only when there
// is one. Anything unusable reads as the start of the track.
export function clock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

// The rail split in two so the caller can ink them differently: what has played
// (full cells plus the eighth-cell leading edge) and what has not. The two
// always add up to exactly `width` cells.
export function progressBar(
  elapsedS: number,
  durationS: number,
  width: number,
): { played: string; rest: string } {
  const cells = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0
  const ratio = durationS > 0 ? clamp01(elapsedS / durationS) : 0
  const eighths = Math.round(ratio * cells * 8)
  const full = Math.floor(eighths / 8)
  const edge = eighths % 8
  // The edge occupies a cell of its own; at a full rail there is none left.
  const partial = edge > 0 && full < cells ? EIGHTHS[edge]! : ''
  return {
    played: '█'.repeat(full) + partial,
    rest: RAIL.repeat(cells - full - (partial === '' ? 0 : 1)),
  }
}

// Two terminal cells for one glyph: East Asian Wide + Fullwidth, plus emoji —
// a yt-dlp title carries both, an umbrella glyph in an ambience title as
// readily as a Chinese one.
// The now-playing row shares one line with the rail and the band's rows are
// fixed (§3.3), so the label has to be measured in cells, not in length.
//
// Extended_Pictographic is deliberately coarse: it calls a handful of narrow
// text-presentation glyphs (copyright, registered, trademark) wide. That
// direction is the safe one — an
// over-count trims the title a cell early, where an under-count wraps the row
// and takes a line the sky is standing on.
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u

// Graphemes, not code points: a ZWJ sequence or a skin-tone modifier is several
// code points drawn in ONE pair of cells, and counting its pieces would cut a
// title to nothing.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function cells(text: string): number {
  let width = 0
  for (const { segment } of GRAPHEMES.segment(text)) width += WIDE.test(segment) ? 2 : 1
  return width
}

// The label cut to a cell budget, ellipsis included. Cuts on a grapheme, never
// through one: half a cluster renders as its orphaned pieces, wider than the
// glyph it stood for.
export function fit(text: string, max: number): string {
  if (max <= 0) return ''
  if (cells(text) <= max) return text
  let kept = ''
  let used = 0
  for (const { segment } of GRAPHEMES.segment(text)) {
    const width = WIDE.test(segment) ? 2 : 1
    if (used + width > max - 1) break
    kept += segment
    used += width
  }
  return `${kept}…`
}
