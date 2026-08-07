// The pixel pet's substrate (spec 10 §3.7.1), built on krabby's technique:
// sprites are committed TEXT assets, not images — no image machinery, renders in
// every terminal, and a later art pass replaces the .pix files and nothing else
// (§6.1 owns what the creature actually looks like).
//
// An asset is a grid of PIXELS, one character per pixel, each character a key
// into a palette this module colors at render time ('.' = transparent). Two
// pixel rows fold into one terminal cell drawn as an upper-half block: the upper
// pixel is the foreground, the lower is the background. That is what makes cell
// art read as pixel art, and it costs one glyph per two pixels.
//
// Keeping the palette in code rather than baking ANSI into the assets is what
// lets the pet tint with the hour (§3.7.2) and fade when it dozes.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProgramState } from '../../src/ipc.ts'
import { INK, mix, type Accent } from './palette.ts'

// A frame is its pixel rows, top first. All rows the same width.
export type Sprite = string[]

export type Cell = { fg: string; bg: string }

export const POSE_NAMES = ['idle', 'talk', 'music', 'doze', 'wake'] as const

export type PoseName = (typeof POSE_NAMES)[number]

// Frames per second per pose, inside the 2-8fps the spec calls for: a pet that
// animates faster than you can read it stops being a companion and starts being
// a progress bar. Poses that carry no animation still name a rate — the loop is
// uniform, the frame count is what differs.
export const POSE_FPS: Record<PoseName, number> = {
  idle: 3,
  talk: 6,
  music: 4,
  doze: 2,
  wake: 2,
}

const ASSET_DIR = join(import.meta.dirname, '..', 'assets', 'pet')

// Split an asset into frames on blank lines, padding every row out to the widest
// one: trailing transparent pixels are trailing whitespace, and every editor and
// formatter in the chain wants to eat them.
export function parseFrames(text: string): Sprite[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((row) => row.trim() !== ''))
    .filter((rows) => rows.length > 0)
    .map((rows) => {
      const width = Math.max(...rows.map((row) => row.length))
      return rows.map((row) => row.padEnd(width, '.'))
    })
}

export function loadPoses(dir = ASSET_DIR): Record<PoseName, Sprite[]> {
  const found = new Set(readdirSync(dir))
  const poses = {} as Record<PoseName, Sprite[]>
  for (const pose of POSE_NAMES) {
    const file = `${pose}.pix`
    // A missing pose is a missing asset, not a runtime shrug: the pet is the
    // face of the thing, and a silently blank one is worse than a loud failure.
    if (!found.has(file)) throw new Error(`pet sprite missing: ${file}`)
    poses[pose] = parseFrames(readFileSync(join(dir, file), 'utf-8'))
  }
  return poses
}

// The palette the .pix keys resolve through. The body borrows the hour's accent
// (§3.7.2), so the pet warms and cools with the program; `fade` toward the room
// is how a dozing pet dims without a second set of assets.
export function petPalette(accent: Accent, fade: number): Record<string, string> {
  const dim = (color: string): string => (fade === 0 ? color : mix(color, INK.bg, fade))
  return {
    o: dim('#2a221c'), // outline
    b: dim(accent.dim), // body
    e: dim(INK.text), // eye
    m: dim(accent.bright), // muzzle / belly
  }
}

// Fold pixel rows into cell rows. An odd trailing pixel row would be dropped, so
// the assets are held to an even count by test rather than padded silently here.
export function cells(sprite: Sprite, palette: Record<string, string>): Cell[][] {
  const rows: Cell[][] = []
  for (let top = 0; top + 1 < sprite.length; top += 2) {
    const upper = sprite[top]!
    const lower = sprite[top + 1]!
    const row: Cell[] = []
    for (let x = 0; x < upper.length; x++) {
      row.push({
        fg: palette[upper[x]!] ?? INK.bg,
        bg: palette[lower[x]!] ?? INK.bg,
      })
    }
    rows.push(row)
  }
  return rows
}

// Which pose the program is in (§3.2-D). Precedence is the order of what the
// listener needs to notice: an empty room first, then whatever is on air.
export function poseFor(state: ProgramState | null): PoseName {
  if (state === null) return 'idle'
  if (state.activity === 'away') return 'doze'
  switch (state.kind) {
    case 'talk':
      return 'talk'
    case 'music':
      return 'music'
    case 'gap':
      return 'idle'
  }
}

// The alive band's composition (§3.3): the pet on the left, the spectrum filling
// the rest. `MURMUR_TUI_PET=0` drops the pet — the listening pass (§5.11) liked
// the radio and not the creature, and until §6.1 gives it an identity the
// listener may want the band to be spectrum only. Default is ON: the pass judged
// the pet's current form, not its existence. Hiding it takes the gutter with it,
// so the bars start at the band's edge and there is no dead hole.
const OFF = new Set(['0', 'false', 'off', 'no'])

export function bandLayout(env: NodeJS.ProcessEnv = process.env): {
  pet: boolean
  vizPadLeft: number
} {
  const pet = !OFF.has((env.MURMUR_TUI_PET ?? '').trim().toLowerCase())
  return { pet, vizPadLeft: pet ? 1 : 0 }
}

const HOUR = 3600
const DAY = 86_400

// Acknowledge the gap the listener came back across (§3.7.3) — a welcome, never
// a reproach: no decay mechanics, because murmur is a companion, not a chore.
// null = nothing worth naming, and the strip stays about the program.
export function awayGreeting(seconds: number | undefined): string | null {
  if (seconds === undefined || seconds < HOUR) return null
  if (seconds < 2 * HOUR) return 'back after an hour'
  if (seconds < DAY) return `back after ${Math.floor(seconds / HOUR)} hours`
  if (seconds < 2 * DAY) return 'back after a day'
  if (seconds < 14 * DAY) return `back after ${Math.floor(seconds / DAY)} days`
  return 'back after a while — good to hear you'
}
