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

// The width of the ident's own column in the wide composition, where the
// lower half stands as two columns: the log on the left, the wordmark and its
// tagline on the right (spec 10 §3.3). The log takes about two thirds of the
// frame — unless that would shear the mark, which is fixed-width art and wins.
const IDENT_AIR = 4
const LOG_SHARE = 0.65
export function identColumn(cols: number): number {
  return Math.max(WORDMARK[0]!.length + IDENT_AIR, cols - Math.round(cols * LOG_SHARE))
}
