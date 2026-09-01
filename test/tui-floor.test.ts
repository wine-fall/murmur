// Who has the floor, as the client paints it (spec 10 §3.4/§3.2-C). The
// mapping is pure and lives outside app.tsx precisely so it can be asserted:
// the frame a terminal paints cannot be (§3.9), but "which ink and which words
// for this floor" can.

import { describe, expect, it } from 'vitest'

import { BUSY_FRAMES, busyLine, floorFace, SLATE } from '../tui/src/floor.ts'
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

  it('gives the guide the band\'s rows, and never takes them from the radio or a report', () => {
    // A conversation the listener opened is their own full attention — the
    // same trade the settings pane already makes (spec 10 §3.3). Under the
    // guide the radio is WAITING, so the sky has nothing to report and the
    // scene band's two thirds are the setup walkthrough's to read in. A
    // report only borrowed the keyboard — the radio plays on behind it, so
    // the band stays.
    expect(floorFace('guide')!.yieldsBand).toBe(true)
    expect(floorFace('report')!.yieldsBand).toBe(false)
    expect(floorFace('radio')).toBeNull()
  })

  it('never says the radio stopped — because it has not', () => {
    const face = floorFace('report')!
    for (const words of [face.strip, face.sub, face.identity, face.placeholder]) {
      expect(words.toLowerCase()).not.toContain('paused')
      expect(words.toLowerCase()).not.toContain('stopped')
    }
  })
})

describe('the busy sign', () => {
  it('names the partner the listener is actually waiting on', () => {
    // "murmur is thinking" while the setup guide holds the floor would name
    // the wrong partner (spec 10 §3.4: the input line has exactly one).
    expect(busyLine('guide', 0)).toContain('setup guide')
    expect(busyLine('radio', 0)).toContain('murmur')
    expect(busyLine('report', 0)).toContain('report')
  })

  it('animates: consecutive phases differ, and it cycles', () => {
    // The whole point is motion — a still frame is what already reads as a
    // hang. Frames must also be the same WIDTH, or the line jitters.
    const frames = BUSY_FRAMES.map((_, phase) => busyLine('guide', phase))
    expect(new Set(frames).size).toBe(BUSY_FRAMES.length)
    expect(new Set(BUSY_FRAMES.map((f) => [...f].length)).size).toBe(1)
    expect(busyLine('guide', BUSY_FRAMES.length)).toBe(busyLine('guide', 0))
  })

  it('survives a phase counter that only ever grows', () => {
    // The client ticks a monotonic counter; the sign must not go undefined
    // when it wraps past the frame count for the hundredth time.
    expect(busyLine('guide', 9_999)).toBe(busyLine('guide', 9_999 % BUSY_FRAMES.length))
  })
})
