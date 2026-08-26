// The boot wordmark (spec 10 §3.3 as built): shown while the log is still
// empty. Art is data; the one thing a test can hold is the grid discipline —
// ragged rows would shear the mark.

import { describe, expect, it } from 'vitest'

import { identColumn, TAGLINE, WORDMARK } from '../tui/src/logo.ts'

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

describe('identColumn (the ident stands in its own column beside the log)', () => {
  it('never squeezes the wordmark — the column always holds the mark plus its air', () => {
    // The narrowest wide composition: two thirds of 96 columns would leave the
    // ident 34, shearing a 40-cell mark.
    expect(identColumn(96)).toBeGreaterThanOrEqual(WORDMARK[0]!.length + 4)
  })

  it('leaves the log about two thirds of the frame once there is room', () => {
    for (const cols of [120, 160, 184]) {
      const share = (cols - identColumn(cols)) / cols
      expect(share).toBeGreaterThanOrEqual(0.6)
      expect(share).toBeLessThanOrEqual(0.7)
    }
  })
})
