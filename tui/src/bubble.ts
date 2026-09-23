// The startup notify bubble (spec 10 §3.7.5): the one notice the engine picked
// at launch, said by the pet. Pure shape and placement, kept out of app.tsx so
// it can be asserted.

import type { EngineMessage, ProgramState } from '../../src/host/ipc.ts'
import { circleOf } from './constellation.ts'
import { poseFor, type PoseName } from './pet.ts'
import { cells, fit } from './progress.ts'

export type Bubble = Omit<Extract<EngineMessage, { type: 'bubble' }>, 'v' | 'type'>

export const BUBBLE_MAX_COLS = 36
const BUBBLE_MIN_COLS = 22
export const BUBBLE_HIDE_MS = 20_000
// Under every card (dock.ts Z_NOTICE / Z_MENU): the bubble is the least urgent
// thing on screen.
export const Z_BUBBLE = 90
const BODY_LINES = 2
const DISMISS = 'esc dismiss'

// Half the figure's widest footprint in cells, halo included: the text sprite
// is ~24 cells wide as drawn, the kitty raster ~16. The bubble starts a cell
// past it, so the raster placement can never land on the bubble's cells.
export const FIGURE_HALF_COLS = 13

// Word-wrapped to `inner` cells, at most two lines; a cut second line ends in
// an ellipsis. The whole text is in the program log either way.
export function bubbleLines(text: string, inner: number): string[] {
  const lines: string[] = []
  let line = ''
  const words = text.split(/\s+/).filter((word) => word !== '')
  for (let at = 0; at < words.length; at++) {
    const next = line === '' ? words[at]! : `${line} ${words[at]}`
    if (cells(next) <= inner) {
      line = next
      continue
    }
    if (line !== '') lines.push(line)
    line = words[at]!
    if (lines.length === BODY_LINES - 1) {
      const rest = words.slice(at).join(' ')
      if (cells(rest) <= inner) return [...lines, rest]
      // Cut on a word where one fits, so the ellipsis never splits a word.
      let kept = ''
      for (const word of words.slice(at)) {
        const more = kept === '' ? word : `${kept} ${word}`
        if (cells(more) > inner - 1) break
        kept = more
      }
      return [...lines, kept === '' ? fit(rest, inner) : `${kept}…`]
    }
  }
  if (line !== '') lines.push(fit(line, inner))
  return lines
}

export function bubbleHint(hint: string | undefined, inner: number): string {
  return hint === undefined ? DISMISS : `${fit(hint, inner - cells(DISMISS) - 3)} · ${DISMISS}`
}

// Where the bubble floats in the wide sky (absolute cells, the root's own
// coordinates): right of the figure, its bottom at the figure's head, the
// tail one cell under its lower-left corner pointing back at the figure.
// null = the scene has no room beside the figure; the strip carries it then.
export function bubbleBox(at: {
  gutter: number
  sceneWidth: number
  sceneRows: number
  lines: number
}): { left: number; top: number; width: number; height: number; tailCol: number; tailRow: number } | null {
  const sceneLeft = at.gutter + 1
  const centreCol = sceneLeft + at.sceneWidth / 2
  const tailCol = Math.ceil(centreCol + FIGURE_HALF_COLS)
  const left = tailCol + 1
  const width = Math.min(BUBBLE_MAX_COLS, sceneLeft + at.sceneWidth - left)
  if (width < BUBBLE_MIN_COLS) return null
  // Scene rows start under the strip and its rule (row 2).
  const centreRow = 2 + circleOf(at.sceneWidth * 2, at.sceneRows * 4).cy / 4
  const height = at.lines + 3
  const top = Math.max(2, Math.floor(centreRow) - 2 - height)
  return { left, top, width, height, tailCol, tailRow: top + height }
}

// The strip's lead words (§3.3): who holds the floor outranks everything, then
// the bubble, then the away greeting, then the DJ's microcopy.
export function stripLead(parts: {
  floor?: string | undefined
  bubble?: string | undefined
  greeting?: string | null
  microcopy?: string | null
}): string | undefined {
  return parts.floor ?? parts.bubble ?? parts.greeting ?? parts.microcopy ?? undefined
}

// The pet wakes to say the bubble, the same way it wakes for a returning
// listener (§3.7.3).
export function restPose(state: ProgramState | null, greeting: string | null, bubble: Bubble | null): PoseName {
  return greeting !== null || bubble !== null ? 'wake' : poseFor(state)
}
