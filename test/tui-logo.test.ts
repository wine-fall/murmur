// The boot wordmark (spec 10 §3.3 as built): shown while the log is still
// empty. Art is data; the one thing a test can hold is the grid discipline —
// ragged rows would shear the mark.

import { describe, expect, it } from 'vitest'

import { identPinned, TAGLINE, WORDMARK } from '../tui/src/logo.ts'

describe('WORDMARK', () => {
  it('is a rectangular block — every row the same width', () => {
    expect(WORDMARK.length).toBeGreaterThanOrEqual(3)
    const widths = new Set(WORDMARK.map((row) => row.length))
    expect(widths.size).toBe(1)
  })

  it('fits the narrow log column alongside its tagline', () => {
    expect(WORDMARK[0]!.length).toBeLessThanOrEqual(60)
    expect(TAGLINE.length).toBeLessThanOrEqual(WORDMARK[0]!.length + 10)
  })
})

describe('identPinned (the wordmark must not scroll away under a busy program)', () => {
  it('pins the ident above the log in the wide composition when the log has room', () => {
    expect(identPinned(true, 20)).toBe(true)
  })

  it('never pins in the narrow band — the classic in-log ident stands', () => {
    expect(identPinned(false, 40)).toBe(false)
  })

  it('yields to a cramped log rather than starve it of rows', () => {
    // sceneSplit floors the log at 6; a pinned ident there would leave a
    // one-row transcript.
    expect(identPinned(true, 6)).toBe(false)
    expect(identPinned(true, 11)).toBe(false)
    expect(identPinned(true, 12)).toBe(true)
  })
})
