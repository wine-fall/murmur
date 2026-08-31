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
}

const FACES: Record<Exclude<Floor, 'radio'>, FloorFace> = {
  guide: {
    ink: WARM,
    strip: 'in the workshop',
    sub: 'the setup guide has the floor',
    identity: 'setup guide',
    placeholder: 'talking to the setup guide · esc interrupts · /done hands back',
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
  },
}

export function floorFace(floor: Floor): FloorFace | null {
  return floor === 'radio' ? null : FACES[floor]
}
