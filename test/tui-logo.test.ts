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

  it('takes the title down with the band when the floor yields', () => {
    // The band steps off for a foreground conversation (§3.3), which hands the
    // log the whole frame — and by the plain row ladder that would promote the
    // wordmark to its full six rows, planting the biggest thing on screen on
    // top of the walkthrough the listener is trying to read. A yielding floor
    // yields the title too.
    expect(identSize(true, 40, true)).toBe('line')
    expect(identSize(true, 12, true)).toBe('line')
  })

  it('still keeps ONE line under a yielding floor — nothing else is naming the station', () => {
    // The strip and the identity line are both wearing the guide's face while
    // it holds the floor, so the 'none' step's premise ("the status strip is
    // already carrying the name") is false exactly here.
    expect(identSize(true, 7, true)).not.toBe('none')
  })

  it('has no pinned ident to yield in the narrow band', () => {
    expect(identSize(false, 40, true)).toBe('none')
  })

  it('keeps the one-line form inside a narrow column', () => {
    expect(IDENT_LINE.length).toBeLessThanOrEqual(WORDMARK[0]!.length)
  })
})
