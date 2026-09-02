// Who has the floor, and what the room looks like while they do (spec 10 §3.4
// and §3.2-C). One mapping instead of a three-way branch repeated at every
// place the client paints the switch — strip, identity line, input.
//
// `null` is the radio: the program's own face is the default the whole
// interface is already built around, so the floors are the exception and the
// radio is the absence of one.

import { WARM } from './palette.ts'

// The report floor's ink (§3.2-C). Cold, where the guide is warm — a report is
// not a conversation with murmur about murmur, it is paperwork — and dimmer
// than the listener's own periwinkle, because it is a side-errand that must
// not out-shout the program it is a report about.
export const SLATE = '#6f7f96'

export type Floor = 'radio' | 'guide' | 'report'

export interface FloorFace {
  // The ink the strip and the identity line are written in while this floor
  // holds.
  ink: string
  // The centred status line, in place of the program's microcopy.
  strip: string
  // The wide composition's second slot, where the scene usually sits.
  sub: string
  // The identity line, in place of the persona/brain/voice trio.
  identity: string
  placeholder: string
  // Whether the scene band hands its rows to the log while this floor holds
  // (§3.3). The settings pane already makes this trade — a mode the listener
  // opened is their own full attention — and a foreground conversation is the
  // same bargain: the guide's walkthrough is paragraphs of instructions to
  // read and act on, and a third of the frame is not enough to read them in
  // while two thirds paint a sky for a radio that is WAITING.
  yieldsBand: boolean
}

const FACES: Record<Exclude<Floor, 'radio'>, FloorFace> = {
  guide: {
    ink: WARM,
    strip: 'in the workshop',
    sub: 'the setup guide has the floor',
    identity: 'setup guide',
    placeholder: 'talking to the setup guide · esc interrupts · /done hands back',
    yieldsBand: true,
  },
  report: {
    // The words are careful about one thing: the radio is STILL PLAYING. The
    // guide's copy can talk about handing the floor back because the program
    // stopped for it; this floor only borrowed the keyboard.
    ink: SLATE,
    strip: 'writing it up',
    sub: 'the keyboard is the report — the radio plays on',
    identity: 'report',
    placeholder: 'this goes in the report · esc drops it',
    // The radio is still playing, so the sky still has something to say.
    yieldsBand: false,
  },
}

export function floorFace(floor: Floor): FloorFace | null {
  return floor === 'radio' ? null : FACES[floor]
}

// The busy sign's motion (§3.4). A breathing ellipsis rather than a spinner:
// the room is a night-time radio, and a machine-shop spinner would be the one
// loud thing on the screen. Fixed width, so the line never jitters.
export const BUSY_FRAMES = ['·  ', '·· ', '···'] as const

// Who the listener is waiting on, and the fact that the wait is a TURN. The
// partner is named because the input line has exactly one at a time.
export function busyLine(floor: Floor, phase: number): string {
  const who = floorFace(floor)?.identity ?? 'murmur'
  return `${who} is thinking ${BUSY_FRAMES[phase % BUSY_FRAMES.length]!}`
}

// The composer a floor gets in place of the radio's one-line field (§3.4). A
// conversation with an agent is typed in paragraphs — a pasted path, a
// question with its context — so the field wraps and grows with the draft,
// and the radio keeps its single row (the band composition's raster anchors
// are measured from it). Past the cap the rest scrolls inside the field.
export const COMPOSER_MAX_ROWS = 8

// `lines` is the widget's own wrapped-line count — the wrap is its math, not
// ours; `height` is the terminal's. A third of the frame at most, so the
// walkthrough being replied to stays readable above the reply.
export function composerRows(lines: number, height: number): number {
  return Math.max(1, Math.min(lines, COMPOSER_MAX_ROWS, Math.floor(height / 3)))
}

// Enter sends; shift+enter, opt+enter, and ctrl-J break the line. OpenTUI's
// textarea ships the reverse (enter breaks, meta+enter sends), which is an
// editor's bargain, not a chat composer's. Under the kitty keyboard protocol
// (on by default — spec 10 §5.1) ctrl-J arrives as the letter with ctrl held,
// not as the raw linefeed the default binding names; both are bound.
// Structurally @opentui/core's textarea KeyBinding — declared here, like
// figure-image.ts's PixelResolution, so the root suite's typecheck (which
// reaches this file through its test) never has to resolve tui/node_modules.
export type ComposerKey = {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  action: 'submit' | 'newline'
}

export const COMPOSER_KEYS: ComposerKey[] = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'return', shift: true, action: 'newline' },
  { name: 'return', meta: true, action: 'newline' },
  { name: 'j', ctrl: true, action: 'newline' },
]
