// The question dock's pure logic (spec 10 §3.2-B): when the engine marks a
// question (`ask` on the wire), the client pins it beside the input instead of
// letting it scroll away with the log. This module shapes the pinned text; the
// component in app.tsx renders it.

import type { EngineMessage } from '../../src/ipc.ts'

export type Ask = Extract<EngineMessage, { type: 'ask' }>
export type AskKind = Ask['kind']

// The border title, padded so the frame breathes around it. 'consent' wants a
// y/N; 'question' wants a free line — the title is how the dock says which.
export function dockTitle(kind: AskKind): string {
  return kind === 'consent' ? ' murmur needs a yes ' : ' murmur is asking '
}

// Greedy word wrap to the dock's inner width. Engine asks arrive with their
// own newlines (a consent carries the command on one line, the y/N on the
// next); those breaks are kept, and an unbroken run longer than the width is
// hard-split rather than overflowing the frame.
export function dockLines(text: string, width: number): string[] {
  const max = Math.max(width, 1)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      for (const piece of hardSplit(word, max)) {
        if (line === '') line = piece
        else if (line.length + 1 + piece.length <= max) line += ` ${piece}`
        else {
          lines.push(line)
          line = piece
        }
      }
    }
    lines.push(line)
  }
  return lines
}

// What a submitted line becomes on the wire. While a question is docked,
// EVERY line — the empty skip included (spec 06 §2.1: Enter skips a seed
// question) — is its answer; idle empty lines stay local noise, as before.
export function outbound(text: string, askActive: boolean): string | null {
  return askActive || text.trim() !== '' ? text : null
}

function hardSplit(word: string, max: number): string[] {
  if (word.length <= max) return [word]
  const pieces: string[] = []
  for (let at = 0; at < word.length; at += max) pieces.push(word.slice(at, at + max))
  return pieces
}
