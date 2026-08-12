// The quiet-constellation scene (spec 10 §6.1): one big implied circle — the
// FFT bins as columns of small square blocks whose bases ride the circle's
// lower arc, and the whisper figure floating at the circle's center. The night
// behind them stays empty: at character resolution a scattered starfield reads
// as noise, so the scene spends its texture budget on the wave alone.
//
// Everything is drawn on ONE canvas of square sub-pixels — two per character
// width, four per character height — and folded to glyphs by the chosen pen:
// octant mosaics (Unicode 16) where the terminal can draw them, half-blocks
// (2x coarser, universal) where it cannot. The canvas, the geometry, and the
// colors never change; only the fold does.
//
// No OpenTUI and no React in here, same reasoning as bars.ts: the painted
// frame cannot be unit-asserted (§3.9), the arithmetic can. Everything random
// is hashed — the sky must survive a re-render without reshuffling.

import { EMBER, INK, mix, QUIET, WARM, type Accent } from './palette.ts'
import type { Sprite } from './pet.ts'

export type Run = { text: string; fg: string; bg?: string | undefined }

export type Pen = 'octant' | 'half'

// Mask-indexed glyphs for every 2x4 sub-pixel pattern, bit r*2+c (top-left
// first). 230 Unicode-16 octants plus the 26 legacy exceptions, generated
// from wezterm's verified table and name-checked against unicodedata 16.
export const OCTANTS: readonly string[] = Array.from(
  ' 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█',
)

// Which pen this terminal can hold. Ghostty/Kitty/WezTerm synthesize octant
// mosaics regardless of font; everyone else gets the universal half-block.
// MURMUR_TUI_PIXEL=octant|half is the explicit override, either way.
export function penFor(env: NodeJS.ProcessEnv): Pen {
  const forced = (env.MURMUR_TUI_PIXEL ?? '').trim().toLowerCase()
  if (forced === 'octant' || forced === 'half') return forced
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  if (['ghostty', 'wezterm'].includes(program)) return 'octant'
  if ((env.TERM ?? '').includes('kitty')) return 'octant'
  return 'half'
}

// Below this many columns the stacked composition has no room to breathe and
// the client keeps the classic bottom band (§6.1's single breakpoint).
export const WIDE_MIN = 96

// The stacked composition's vertical split (§3.3): the scene band takes about
// two thirds of the usable rows, the program log the rest — with a floor so a
// short terminal never starves the log below readability.
export function sceneSplit(rows: number): { scene: number; log: number } {
  const log = Math.max(Math.round(rows / 3), 6)
  return { scene: Math.max(rows - log, 0), log }
}

// Where the circle sits and how far it reaches. By-eye knobs, all of them.
const CENTER_Y = 0.44
const RADIUS = 0.92

// The wave: climb toward the center at full level, the dash rhythm of its
// blocks (one on, one off), and the fraying tip.
const CLIMB = 0.8
const TIP_FRAY = 0.35

// Heat thresholds: ember peaks, cream mids, cool quiet.
const HOT_LEVEL = 0.6
const WARM_LEVEL = 0.3

// Ghost echoes drifting past a column's tip.
const GHOST_ROWS = 4
const GHOST_DENSITY = 0.25

// The wave shimmers slower than the 24fps feed, or it reads as static noise.
const SHIMMER_DIVISOR = 4

// The one implied circle everything hangs off — the wave's arc, the figure's
// seat, and the star rings all share it.
export function circleOf(
  subCols: number,
  subRows: number,
): { cx: number; cy: number; radius: number } {
  const cx = subCols / 2
  const cy = subRows * CENTER_Y
  return { cx, cy, radius: Math.min(cx, subRows - cy) * RADIUS }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}

// The spectrum mirrored from the center out: bin 0 (bass, almost always
// breathing) rises at the arc's middle and the treble frays toward both arms —
// the wave blooms outward instead of marching left-to-right.
export function waveBinAt(span: number, count: number): number {
  return Math.min(Math.floor(Math.abs(span) * count), count - 1)
}

// Deterministic per-block jitter: same block, same tick bucket, same verdict.
// Exported for its regression test: the final XOR must be forced back to
// unsigned, or half of all hashes come out negative and pass any threshold.
export function hash01(x: number, y: number, tick: number): number {
  let mixed = (Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263) + Math.imul(tick, 2_246_822_519)) >>> 0
  mixed = Math.imul(mixed ^ (mixed >>> 13), 1_274_126_177) >>> 0
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4_294_967_296
}

export class Constellation {
  private readonly width: number
  private readonly subCols: number
  private readonly subRows: number
  private readonly pen: Pen
  private tick = 0

  constructor(width: number, height: number, pen: Pen = 'octant') {
    this.width = width
    this.subCols = width * 2
    this.subRows = height * 4
    this.pen = pen
  }

  // One painted frame: levels are the engine's 0..1 bins (empty = silence),
  // figure is the pixel sprite (pet.ts, one sprite pixel = one sub-pixel) or
  // null for a hidden pet; figureFade dims a dozing figure toward the room.
  frame(
    levels: readonly number[],
    accent: Accent,
    figure: Sprite | null,
    figureFade = 0,
  ): Run[][] {
    const tick = this.tick++
    const bucket = Math.floor(tick / SHIMMER_DIVISOR)
    const canvas: (string | null)[][] = Array.from({ length: this.subRows }, () =>
      Array.from({ length: this.subCols }, () => null),
    )
    const paint = (x: number, y: number, ink: string): void => {
      if (x >= 0 && x < this.subCols && y >= 0 && y < this.subRows) canvas[y]![x] = ink
    }

    // The wave: dashed columns of square blocks riding the circle's lower arc,
    // every other sub-column dark so the columns keep air between them.
    const { cx, cy, radius } = circleOf(this.subCols, this.subRows)
    for (let x = 0; x < this.subCols; x += 2) {
      const span = (x - cx) / radius
      if (Math.abs(span) > 0.98 || levels.length === 0) continue
      const level = clamp01(levels[waveBinAt(span, levels.length)]!)
      if (level === 0) continue
      const base = cy + Math.sqrt(Math.max(radius * radius - (x - cx) * (x - cx), 0))
      const climb = level * (base - cy) * CLIMB
      const heat = level > HOT_LEVEL ? EMBER : level > WARM_LEVEL ? accent.bright : QUIET
      for (let up = 0; up < climb; up += 2) {
        const edge = up / Math.max(climb, 1)
        if (edge > 1 - TIP_FRAY && hash01(x, up, bucket) < (edge - (1 - TIP_FRAY)) / TIP_FRAY)
          continue
        const ink = edge > 0.72 ? mix(heat, QUIET, 0.55) : mix(heat, INK.bg, edge * 0.35)
        paint(x, Math.round(base - up), ink)
      }
      for (let g = 1; g <= GHOST_ROWS; g++) {
        if (hash01(x, -g, bucket) < GHOST_DENSITY * level) {
          paint(x, Math.round(base - climb - g * 3), mix(INK.bg, QUIET, 0.7))
        }
      }
    }

    // The figure at the circle's center, cream ink with its ember sparkle —
    // cleared halo first, so it floats in the hollow rather than on the wave.
    if (figure !== null && figure.length > 0) {
      const fh = figure.length
      const fw = figure[0]!.length
      if (fw <= this.subCols && fh <= this.subRows) {
        const fx = Math.round(cx - fw / 2)
        const fy = Math.round(cy - fh / 2)
        for (let y = fy - 2; y < fy + fh + 2; y++) {
          for (let x = fx - 2; x < fx + fw + 2; x++) {
            if (x >= 0 && x < this.subCols && y >= 0 && y < this.subRows) canvas[y]![x] = null
          }
        }
        const cream = mix(INK.text, INK.bg, figureFade)
        const warm = mix(WARM, INK.bg, figureFade)
        const ember = mix(EMBER, INK.bg, figureFade)
        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const key = figure[y]![x]
            if (key === 'x') paint(fx + x, fy + y, cream)
            else if (key === 'w') paint(fx + x, fy + y, warm)
            else if (key === 's') paint(fx + x, fy + y, ember)
          }
        }
      }
    }

    return this.pen === 'octant' ? this.foldOctants(canvas) : this.foldHalves(canvas)
  }

  // Fold 2x4 sub-pixels per cell into an octant glyph. One foreground per
  // cell: the most frequent ink among its lit sub-pixels wins the cell.
  private foldOctants(canvas: (string | null)[][]): Run[][] {
    const rows: Run[][] = []
    for (let top = 0; top + 3 < this.subRows; top += 4) {
      const runs: Run[] = []
      const put = (text: string, fg: string, bg?: string): void => {
        const last = runs.at(-1)
        if (last !== undefined && last.fg === fg && last.bg === bg) last.text += text
        else runs.push({ text, fg, bg })
      }
      for (let cell = 0; cell < this.width; cell++) {
        let mask = 0
        const votes = new Map<string, number>()
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 2; c++) {
            const ink = canvas[top + r]![cell * 2 + c] ?? null
            if (ink !== null) {
              mask |= 1 << (r * 2 + c)
              votes.set(ink, (votes.get(ink) ?? 0) + 1)
            }
          }
        }
        if (mask === 0) {
          put(' ', INK.dim)
          continue
        }
        // A cell owns one foreground AND one background: a near-covered cell
        // holding exactly two inks keeps both — the majority ink rides the
        // glyph, the other paints behind it (first-seen wins a tie, which is
        // the cell's top-left ink). The bled background on up to two empty
        // sub-pixels reads as a soft edge, not a hole. Anything else takes
        // the majority alone.
        let fg = INK.dim
        let best = 0
        let lit = 0
        for (const [ink, n] of votes) {
          lit += n
          if (n > best) {
            best = n
            fg = ink
          }
        }
        if (lit >= 6 && votes.size === 2) {
          const other = [...votes.keys()].find((ink) => ink !== fg)!
          let fgMask = 0
          for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 2; c++) {
              if (canvas[top + r]![cell * 2 + c] === fg) fgMask |= 1 << (r * 2 + c)
            }
          }
          put(OCTANTS[fgMask]!, fg, other)
          continue
        }
        put(OCTANTS[mask]!, fg, INK.bg)
      }
      rows.push(runs)
    }
    return rows
  }

  // The universal fallback: downsample 2x2 sub-pixels per half-block pixel.
  private foldHalves(canvas: (string | null)[][]): Run[][] {
    const sample = (top: number, cell: number): string | null => {
      const votes = new Map<string, number>()
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          const ink = canvas[top + r]![cell * 2 + c] ?? null
          if (ink !== null) votes.set(ink, (votes.get(ink) ?? 0) + 1)
        }
      }
      let fg: string | null = null
      let best = 0
      for (const [ink, n] of votes) {
        if (n > best) {
          best = n
          fg = ink
        }
      }
      return fg
    }
    const rows: Run[][] = []
    for (let top = 0; top + 3 < this.subRows; top += 4) {
      const runs: Run[] = []
      const put = (text: string, fg: string, bg?: string): void => {
        const last = runs.at(-1)
        if (last !== undefined && last.fg === fg && last.bg === bg) last.text += text
        else runs.push({ text, fg, bg })
      }
      for (let cell = 0; cell < this.width; cell++) {
        const upper = sample(top, cell)
        const lower = sample(top + 2, cell)
        if (upper === null && lower === null) put(' ', INK.dim)
        else put('▀', upper ?? INK.bg, lower ?? INK.bg)
      }
      rows.push(runs)
    }
    return rows
  }
}
