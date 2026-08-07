// The pixel pet's substrate (spec 10 §3.7.1): sprites are committed TEXT
// assets, not images — no image machinery, renders in every terminal, and a
// later art pass replaces the .pix files and nothing else (§6.1 owns what the
// figure actually looks like).
//
// An asset is a grid of square PIXELS, one character per pixel, derived from
// the murmur logo figure in the 04 concept art at its true pixel mesh. 'x' is
// cream fill, 'w' the warm outline ink, 's' the ember whisper-sparkle, '.'
// empty. Two pixel rows fold into one terminal cell drawn as half-blocks — a
// full-width half-height block is the terminal's square solid pixel.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProgramState } from '../../src/ipc.ts'

// A frame is its pixel rows, top first. All rows the same width.
export type Sprite = string[]

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

// Split an asset into frames on blank lines, padding every row out to the
// widest one: trailing empty sub-pixels are trailing whitespace, and every
// editor and formatter in the chain wants to eat them.
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

// The narrow band's pet is the same asset at half scale (the 42x44 grid would
// eat a 24-row terminal): 2x2 sprite pixels fold to one, any ink beating
// empty and the sparkle beating the body inks — sparks are one pixel and must
// survive the fold.
export function halve(sprite: Sprite): Sprite {
  const rows: string[] = []
  for (let y = 0; y + 1 < sprite.length; y += 2) {
    let row = ''
    for (let x = 0; x + 1 < sprite[y]!.length; x += 2) {
      const quad = [sprite[y]![x]!, sprite[y]![x + 1]!, sprite[y + 1]![x]!, sprite[y + 1]![x + 1]!]
      row +=
        quad.includes('s') ? 's'
        : quad.includes('x') || quad.includes('w')
          ? (quad.filter((key) => key === 'x').length >= quad.filter((key) => key === 'w').length &&
            quad.includes('x')
              ? 'x'
              : 'w')
          : '.'
    }
    rows.push(row)
  }
  return rows
}

// One split at the FIRST spaced dash: the head takes the accent, the rest —
// dashes and all — stays intact. Labels carry unsanitized track metadata, so
// a second dash inside the title must never truncate it.
export function splitNowPlaying(label: string): { head: string; rest: string } | null {
  const match = label.match(/\s+[—–-]+\s+/)
  if (match === null || match.index === undefined) return null
  return { head: label.slice(0, match.index), rest: label.slice(match.index + match[0].length) }
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
// the rest. The knob is the settings layer's `tuiPet` (spec 12 §3.7), with
// `MURMUR_TUI_PET` kept as the client-local final override: an explicitly set
// env wins both ways, an unset one defers to the live setting. Hiding the pet
// takes the gutter with it, so the bars start at the band's edge and there is
// no dead hole.
const OFF = new Set(['0', 'false', 'off', 'no'])

export function bandLayout(
  env: NodeJS.ProcessEnv = process.env,
  tuiPet?: boolean,
): {
  pet: boolean
  vizPadLeft: number
} {
  const raw = (env.MURMUR_TUI_PET ?? '').trim().toLowerCase()
  const pet = raw !== '' ? !OFF.has(raw) : (tuiPet ?? true)
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
