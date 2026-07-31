// The visualizer's client half (spec 10 §3.6): the engine sends 0..1 magnitudes,
// this turns them into cava's look — eighth-block glyphs, per-bin attack/decay
// smoothing, and a grid the caller paints with a vertical gradient.
//
// No OpenTUI and no React in here on purpose: what a terminal frame looks like
// cannot be unit-asserted (§3.9), but "which glyph for this level" can, and it
// is where every visualizer bug actually lives.

// Bottom-up eighths. Index 0 is blank, 8 is a full cell.
const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// Smoothing per frame, asymmetric on purpose: bars must jump onto a transient
// and slide back off it — the shape that reads as music rather than as a
// flickering table. By-ear knobs (§6: visualizer styling).
const ATTACK = 0.45
const DECAY = 0.12

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}

// One `height`-cell column for a bar, top cell first: full blocks under the
// level, one eighth-block at the boundary, blanks above. The eighths are what
// keep a quiet bed visible — without them anything below 1/height is nothing.
function column(level: number, height: number): string[] {
  const eighths = Math.round(clamp01(level) * height * 8)
  const cells: string[] = []
  // Walk the stack from its top cell down, which IS top-first order.
  for (let cell = height - 1; cell >= 0; cell--) {
    const under = eighths - cell * 8
    cells.push(EIGHTHS[Math.min(Math.max(under, 0), 8)]!)
  }
  return cells
}

// The strip as `height` rows of glyphs, top row first — one character per bar.
export function render(levels: readonly number[], height: number): string[] {
  const columns = levels.map((level) => column(level, height))
  return Array.from({ length: height }, (_, row) => columns.map((cells) => cells[row]!).join(''))
}

// Per-bin attack/decay state. Holds the whole strip so a frame that changes
// width (a re-negotiated bin count) resizes instead of rendering a stale strip.
export class Bars {
  private smoothed: number[] = []

  push(bins: readonly number[]): void {
    const next = bins.map((bin, i) => {
      const target = clamp01(bin)
      const current = this.smoothed[i] ?? 0
      const rate = target > current ? ATTACK : DECAY
      return current + (target - current) * rate
    })
    this.smoothed = next
  }

  levels(): number[] {
    // Snap the tail to zero: an exponential decay never quite arrives, and a
    // strip that keeps a sliver of every bar lit forever does not read as quiet.
    return this.smoothed.map((level) => (level < 0.005 ? 0 : level))
  }
}
