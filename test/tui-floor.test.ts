// Who has the floor, as the client paints it (spec 10 §3.4/§3.2-C). The
// mapping is pure and lives outside app.tsx precisely so it can be asserted:
// the frame a terminal paints cannot be (§3.9), but "which ink and which words
// for this floor" can.

import { describe, expect, it } from 'vitest'

import { floorFace, SLATE } from '../tui/src/floor.ts'
import { INK, PERIWINKLE, WARM } from '../tui/src/palette.ts'

function channels(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

// Rough perceptual weight — enough to say "this ink sits back from that one".
function light(hex: string): number {
  const { r, g, b } = channels(hex)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

describe('the report floor ink', () => {
  it('is cold, where the guide is warm', () => {
    expect(channels(SLATE).b).toBeGreaterThan(channels(SLATE).r)
    expect(channels(WARM).r).toBeGreaterThan(channels(WARM).b)
  })

  it('sits back from the program and from the listener', () => {
    // A report is a transactional side-errand; it must not out-shout the
    // thing it is a report ABOUT.
    expect(light(SLATE)).toBeLessThan(light(PERIWINKLE))
    // ...but it is still ink, not room.
    expect(light(SLATE)).toBeGreaterThan(light(INK.dim))
  })

  it('is nobody else\'s color', () => {
    expect([WARM, PERIWINKLE, INK.dim, INK.text, INK.user, INK.notice]).not.toContain(SLATE)
  })
})

describe('floorFace', () => {
  it('leaves the radio to the program: no ink of its own, no words of its own', () => {
    const face = floorFace('radio')
    expect(face).toBeNull()
  })

  it('gives the guide the workshop it already had', () => {
    const face = floorFace('guide')!
    expect(face.ink).toBe(WARM)
    expect(face.strip).toBe('in the workshop')
    expect(face.sub).toBe('the setup guide has the floor')
    expect(face.identity).toBe('setup guide')
    expect(face.placeholder).toContain('/done')
  })

  it('gives the report its own cold face, and says how to drop it', () => {
    const face = floorFace('report')!
    expect(face.ink).toBe(SLATE)
    expect(face.strip).not.toBe(floorFace('guide')!.strip)
    expect(face.identity).not.toBe(floorFace('guide')!.identity)
    // Esc is the way out of this floor, and the placeholder is where the
    // listener finds that out.
    expect(face.placeholder).toContain('esc')
  })

  it('never says the radio stopped — because it has not', () => {
    const face = floorFace('report')!
    for (const words of [face.strip, face.sub, face.identity, face.placeholder]) {
      expect(words.toLowerCase()).not.toContain('paused')
      expect(words.toLowerCase()).not.toContain('stopped')
    }
  })
})
