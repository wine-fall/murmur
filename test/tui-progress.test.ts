// The now-playing progress bar (spec 10 §3.3): the strip's own arithmetic over
// the length and the start the engine sends with a music state. What a frame
// LOOKS like cannot be unit-asserted (§3.9) — which glyph for this fraction of
// a track, and what happens at the edges, is exactly what can.

import { describe, expect, it } from 'vitest'

import { cells, clock, fit, progressBar } from '../tui/src/progress.ts'

// Wide glyphs are the SUBJECT of these cases, so they ride in as code points:
// the source-language gate (DESIGN 0) keeps CJK out of v1 sources, and a test
// is not the place to make an exception to it.
const QING_TIAN = '\u6674\u5929' // two Chinese characters: four cells
const JAY = '\u5468\u6770\u4f26' // three more: six
const UMBRELLA = '\u2614'
const NOTE = '\u{1F3B5}'
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}' // one ZWJ cluster
const WAVE = '\u{1F44B}\u{1F3FD}' // hand + skin-tone modifier

describe('clock', () => {
  it('reads as a track time, not as a number of seconds', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(9)).toBe('0:09')
    expect(clock(61)).toBe('1:01')
    expect(clock(183)).toBe('3:03')
    expect(clock(599)).toBe('9:59')
  })

  it('grows an hours field rather than counting to 187 minutes', () => {
    // The brain is told to reject them, but an hour-long ambience loop does get
    // picked, and "187:19" reads as a bug.
    expect(clock(3600)).toBe('1:00:00')
    expect(clock(11239)).toBe('3:07:19')
  })

  it('never renders a negative or fractional clock', () => {
    expect(clock(-5)).toBe('0:00')
    expect(clock(1.9)).toBe('0:01')
    expect(clock(Number.NaN)).toBe('0:00')
  })
})

describe('progressBar', () => {
  it('splits the rail into what has played and what has not', () => {
    const { played, rest } = progressBar(0, 100, 10)
    expect(played).toBe('')
    expect(rest).toHaveLength(10)
    const half = progressBar(50, 100, 10)
    expect(half.played + half.rest).toHaveLength(10)
    expect(half.played).toHaveLength(5)
    const done = progressBar(100, 100, 10)
    expect(done.played).toHaveLength(10)
    expect(done.rest).toBe('')
  })

  it('shows the leading edge at eighth-cell resolution', () => {
    // Without a partial cell a 3-minute track only moves every ~7 seconds at
    // this width, which reads as a frozen bar rather than a playing song.
    const { played } = progressBar(5, 100, 10) // 0.5 cells
    expect(played).toBe('▌')
    expect(progressBar(55, 100, 10).played).toBe('█████▌') // 5.5 cells
    expect(progressBar(51, 100, 10).played).toBe('█████▏') // 5.08 -> one eighth over
  })

  it('always fills the rail to exactly the width it was given', () => {
    for (const elapsed of [0, 1, 7, 33, 99, 100]) {
      const { played, rest } = progressBar(elapsed, 100, 23)
      expect([...played].length + [...rest].length).toBe(23)
    }
  })

  it('clamps a track that outruns or precedes its own length', () => {
    // The stream re-anchors after an underrun, so wall clock can outrun the
    // encoded length; a clock that steps back must not print a negative rail.
    expect(progressBar(500, 100, 10).played).toHaveLength(10)
    expect(progressBar(-20, 100, 10).played).toBe('')
    expect(progressBar(50, 0, 10)).toEqual({ played: '', rest: '──────────' })
    expect(progressBar(50, 100, 0)).toEqual({ played: '', rest: '' })
  })
})

describe('cells', () => {
  it('counts terminal cells, not code points — CJK is twice as wide', () => {
    expect(cells('Calgary')).toBe(7)
    expect(cells(QING_TIAN)).toBe(4)
    expect(cells(`${JAY} — Calgary`)).toBe(6 + 10)
    expect(cells('')).toBe(0)
  })

  it('counts emoji wide — a real track title is full of them', () => {
    // An umbrella in an ambience title is what yt-dlp actually hands back.
    expect(cells(UMBRELLA)).toBe(2)
    expect(cells(`${NOTE} Jazz`)).toBe(7)
  })

  it('counts a multi-code-point emoji once, as the one cluster it draws as', () => {
    // Counting code points here would call a ZWJ sequence five cells wide and
    // cut the title to nothing.
    expect(cells(FAMILY)).toBe(2)
    expect(cells(WAVE)).toBe(2)
  })
})

describe('fit', () => {
  it('leaves a label that already fits alone', () => {
    expect(fit('Calgary', 20)).toBe('Calgary')
    expect(fit('Calgary', 7)).toBe('Calgary')
  })

  it('truncates to the cell budget with an ellipsis, never past it', () => {
    // The now-playing row shares one line with the rail, and the scene band's
    // rows are fixed: a label that wraps takes a row the sky is standing on.
    expect(cells(fit('Rainy Night Jazz Piano for Sleep', 12))).toBeLessThanOrEqual(12)
    expect(fit('Rainy Night Jazz', 12)).toBe('Rainy Night…')
  })

  it('never splits a wide character across the budget', () => {
    // Half a CJK cell is a cell of garbage that still costs a column.
    expect(fit(QING_TIAN.repeat(3), 5)).toBe(`${QING_TIAN}…`)
    expect(cells(fit(QING_TIAN.repeat(3), 5))).toBeLessThanOrEqual(5)
    expect(cells(fit(QING_TIAN.repeat(3), 7))).toBeLessThanOrEqual(7)
  })

  it('cuts on a cluster, never inside one', () => {
    // Half a ZWJ sequence renders as its orphaned pieces — three glyphs where
    // the budget allowed one.
    const cut = fit(`${FAMILY} family`, 5)
    expect(cut.startsWith(FAMILY)).toBe(true) // the sequence survives whole
    expect(cells(cut)).toBeLessThanOrEqual(5)
    expect(cells(fit(WAVE.repeat(3), 5))).toBeLessThanOrEqual(5)
  })

  it('gives back nothing when there is no room at all', () => {
    expect(fit('Calgary', 0)).toBe('')
    expect(fit('Calgary', -3)).toBe('')
  })
})
