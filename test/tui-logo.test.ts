// The boot wordmark (spec 10 §3.3 as built): shown while the log is still
// empty. Art is data; the one thing a test can hold is the grid discipline —
// ragged rows would shear the mark.

import { describe, expect, it } from 'vitest'

import { TAGLINE, WORDMARK } from '../tui/src/logo.ts'

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
