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

// Whether the ident stands pinned between the scene band and the log, so a
// busy program (the guide's tool narration) cannot scroll the wordmark away.
// Wide composition only, and only when the log can spare the ident's rows
// (wordmark + tagline + margins) and still hold a readable tail.
const IDENT_ROWS = 6
export function identPinned(wide: boolean, logRows: number): boolean {
  return wide && logRows >= IDENT_ROWS * 2
}
