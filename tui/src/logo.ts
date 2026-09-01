// The boot wordmark (spec 10 §3.3 as built): murmur's name in half-block
// lowercase, shown in the log's place while it is still empty — the station
// ident before the first sound. Letters are 3 rows tall, joined on a shared
// baseline; the tagline sits under it in the room's quiet ink.

const M = ['█▀▄▀█', '█ █ █', '█ █ █']
const U = ['█   █', '█   █', '█▄▄▄█']
const R = ['█▀▀▄ ', '█▄▄▀ ', '█  ▀▄']

const LETTERS = [M, U, R, M, U, R]

export const WORDMARK = [0, 1, 2].map((row) =>
  LETTERS.map((letter) => letter[row]!).join('  '),
)

export const TAGLINE = 'a companion radio - always on the air'

// How much of the ident the wide composition can afford between the scene band
// and the log (spec 10 §3.3). The FIGURE never enters this trade — it keeps the
// scene band at every height; only the title yields, and it yields in steps:
// the full mark while the log can spare six rows and still hold a readable
// tail, one small line when it cannot, and nothing at all in a cramped log,
// where the status strip is already carrying the station's name.
export type IdentSize = 'full' | 'line' | 'none'

// The one-line form: the mark's words without its letterforms.
export const IDENT_LINE = 'murmur · a companion radio'

// What each step costs the region, margins included — the renderer spends
// exactly this, so the ladder can promise what it leaves behind.
export const IDENT_ROWS: Record<IdentSize, number> = { full: 6, line: 2, none: 0 }

// The readable tail `sceneSplit` floors the log at. The ident never spends it.
export const LOG_FLOOR = 6

export function identSize(wide: boolean, logRows: number, yielding = false): IdentSize {
  if (!wide) return 'none'
  // A floor that took the band takes the title with it: the rows the band gave
  // up went to a conversation the listener is reading, and spending six of
  // them back on the station's own name would be the largest thing on the
  // screen sitting on top of it. One line stays, because under that floor the
  // strip and the identity line are both wearing the guide's face and nothing
  // else on screen names the station.
  if (yielding) return 'line'
  if (logRows - IDENT_ROWS.full >= LOG_FLOOR) return 'full'
  if (logRows - IDENT_ROWS.line >= LOG_FLOOR) return 'line'
  return 'none'
}
