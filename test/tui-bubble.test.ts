// The startup notify bubble as the client paints it (spec 10 §3.7.5). The
// frame itself cannot be asserted (§3.9); its shape, placement and the strip
// precedence can.

import { describe, expect, it } from 'vitest'

import {
  BUBBLE_MAX_COLS,
  bubbleBox,
  bubbleHint,
  bubbleLines,
  FIGURE_HALF_COLS,
  restPose,
  stripLead,
} from '../tui/src/bubble.ts'
import { cells } from '../tui/src/progress.ts'

describe('bubbleLines', () => {
  it('wraps on words to at most two lines, the second ellipsized when cut', () => {
    expect(bubbleLines('a short one', 30)).toEqual(['a short one'])
    expect(bubbleLines('one two three four five six', 12)).toEqual(['one two', 'three four…'])
    expect(bubbleLines('a newer murmur is out — the fixes are small but they matter, come get them', 29)).toEqual([
      'a newer murmur is out — the',
      'fixes are small but they…',
    ])
    const long = bubbleLines('x'.repeat(10) + ' ' + 'y'.repeat(40), 20)
    expect(long).toHaveLength(2)
    for (const line of long) expect(cells(line)).toBeLessThanOrEqual(20)
  })
})

describe('bubbleHint', () => {
  it('pairs the action with the way out, or says only the way out', () => {
    expect(bubbleHint('type /update', 40)).toBe('type /update · esc dismiss')
    expect(bubbleHint(undefined, 40)).toBe('esc dismiss')
    expect(cells(bubbleHint('https://example.test/a/very/long/path/indeed', 30))).toBeLessThanOrEqual(30)
  })
})

describe('bubbleBox', () => {
  it('sits upper-right of the figure, clear of its cell rectangle, at most 36 wide', () => {
    const box = bubbleBox({ gutter: 0, sceneWidth: 118, sceneRows: 30, lines: 2 })!
    const centre = 1 + 118 / 2
    expect(box.width).toBeLessThanOrEqual(BUBBLE_MAX_COLS)
    expect(box.tailCol).toBeGreaterThanOrEqual(centre + FIGURE_HALF_COLS)
    expect(box.left).toBe(box.tailCol + 1)
    expect(box.left + box.width).toBeLessThanOrEqual(1 + 118)
    // Above the circle's centre: the head, not the lap.
    expect(box.top + box.height).toBeLessThanOrEqual(2 + 30 * 0.44)
    expect(box.top).toBeGreaterThanOrEqual(2)
  })

  it('refuses a scene with no room beside the figure', () => {
    expect(bubbleBox({ gutter: 0, sceneWidth: 60, sceneRows: 30, lines: 1 })).toBeNull()
  })
})

describe('the strip and the pose while a bubble is up', () => {
  it('floor face > bubble > away greeting > microcopy', () => {
    expect(stripLead({ floor: 'setup', bubble: 'news', greeting: 'back', microcopy: 'on' })).toBe('setup')
    expect(stripLead({ bubble: 'news', greeting: 'back', microcopy: 'on' })).toBe('news')
    expect(stripLead({ greeting: 'back', microcopy: 'on' })).toBe('back')
    expect(stripLead({ microcopy: 'on' })).toBe('on')
    expect(stripLead({})).toBeUndefined()
  })

  it('wakes the pet for the bubble exactly as the away greeting does', () => {
    const playing = { kind: 'music' as const }
    expect(restPose(playing, null, null)).toBe('music')
    expect(restPose(playing, 'back', null)).toBe('wake')
    expect(restPose(playing, null, { id: 'a', text: 'news' })).toBe('wake')
  })
})
