// The boot wordmark (spec 10 §3.3 as built): shown while the log is still
// empty. Art is data; the one thing a test can hold is the grid discipline —
// ragged rows would shear the mark.

import { describe, expect, it } from 'vitest'

import { IDENT_ROWS, identSize, IDENT_LINE, LOG_FLOOR, TAGLINE, WORDMARK } from '../tui/src/logo.ts'

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

describe('identSize (the ident yields rows, the figure never does)', () => {
  it('stands full — wordmark and tagline — when the log can spare the rows', () => {
    expect(identSize(true, 20)).toBe('full')
    expect(identSize(true, 12)).toBe('full')
  })

  it('steps down to one small line rather than starve the transcript', () => {
    expect(identSize(true, 11)).toBe('line')
    expect(identSize(true, 8)).toBe('line')
  })

  it('steps off entirely in a cramped log — the status strip still names the station', () => {
    expect(identSize(true, 7)).toBe('none')
    expect(identSize(true, 6)).toBe('none')
  })

  it('never stands in the narrow band — the classic in-log ident holds there', () => {
    expect(identSize(false, 40)).toBe('none')
  })

  it('never eats into the log floor sceneSplit defends', () => {
    // Whatever the ident spends, the transcript keeps its six readable rows —
    // the floor `sceneSplit` exists to hold.
    for (let logRows = 6; logRows <= 40; logRows++) {
      expect(logRows - IDENT_ROWS[identSize(true, logRows)]).toBeGreaterThanOrEqual(LOG_FLOOR)
    }
  })

  it('keeps the one-line form inside a narrow column', () => {
    expect(IDENT_LINE.length).toBeLessThanOrEqual(WORDMARK[0]!.length)
  })
})
