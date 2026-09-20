import { describe, expect, it, vi } from 'vitest'

import { currentScene, formatClock, lastOnAirPhrase, sceneFor } from '../src/director/scene.ts'

const at = (hour: number) => new Date(2026, 6, 28, hour, 30)

describe('sceneFor', () => {
  it('buckets local hours into the four scenes', () => {
    expect(sceneFor(at(5))).toBe('morning')
    expect(sceneFor(at(11))).toBe('morning')
    expect(sceneFor(at(12))).toBe('afternoon')
    expect(sceneFor(at(17))).toBe('afternoon')
    expect(sceneFor(at(18))).toBe('evening')
    expect(sceneFor(at(22))).toBe('evening')
    expect(sceneFor(at(23))).toBe('late-night')
    expect(sceneFor(at(4))).toBe('late-night')
  })
})

describe('currentScene', () => {
  it('derives from the clock when no override is set', () => {
    expect(currentScene(at(9), {})).toBe('morning')
    expect(currentScene(at(9), { MURMUR_SCENE: '  ' })).toBe('morning')
  })

  it('honors a valid MURMUR_SCENE override', () => {
    expect(currentScene(at(9), { MURMUR_SCENE: 'late-night' })).toBe('late-night')
  })

  it('warns and degrades to the clock on an invalid override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(currentScene(at(15), { MURMUR_SCENE: 'nope' })).toBe('afternoon')
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('formatClock', () => {
  // The weekday and date carry what the hour alone cannot: a Monday reads
  // differently from a Saturday, and the bucket spans six hours besides.
  it('names the weekday and date before the 12-hour local clock, ICU-free', () => {
    expect(formatClock(new Date(2026, 7, 31, 14, 28))).toBe('Monday 2026-08-31, 2:28 pm')
    expect(formatClock(new Date(2026, 7, 31, 0, 5))).toBe('Monday 2026-08-31, 12:05 am')
    expect(formatClock(new Date(2026, 7, 31, 12, 0))).toBe('Monday 2026-08-31, 12:00 pm')
    expect(formatClock(new Date(2026, 7, 31, 11, 59))).toBe('Monday 2026-08-31, 11:59 am')
  })

  it('zero-pads the month and day, and spans the week', () => {
    expect(formatClock(new Date(2027, 0, 1, 23, 0))).toBe('Friday 2027-01-01, 11:00 pm')
    expect(formatClock(new Date(2026, 11, 6, 9, 7))).toBe('Sunday 2026-12-06, 9:07 am')
  })
})

// spec 05 §3.4: how the program says when it was last on. Coarse and humane —
// a count of hours is bookkeeping, and a host does not read bookkeeping out.
describe('lastOnAirPhrase', () => {
  const on = (day: number, hour: number) => new Date(2026, 6, day, hour, 30)

  it('says earlier today while the calendar day has not turned', () => {
    expect(lastOnAirPhrase(on(28, 9), on(28, 21))).toBe('earlier today')
  })

  it('names yesterday by its part of the day', () => {
    expect(lastOnAirPhrase(on(27, 14), on(28, 9))).toBe('yesterday afternoon')
    expect(lastOnAirPhrase(on(27, 23), on(28, 9))).toBe('yesterday night')
  })

  it('names the weekday inside the past week', () => {
    expect(lastOnAirPhrase(on(25, 14), on(28, 9))).toBe('Saturday afternoon')
    expect(lastOnAirPhrase(on(22, 8), on(28, 9))).toBe('Wednesday morning')
  })

  it('goes coarser as the gap grows, and never says a number', () => {
    expect(lastOnAirPhrase(on(21, 8), on(28, 9))).toBe('last week')
    expect(lastOnAirPhrase(on(15, 8), on(28, 9))).toBe('last week')
    expect(lastOnAirPhrase(on(14, 8), on(28, 9))).toBe('a few weeks ago')
    expect(lastOnAirPhrase(new Date(2026, 3, 1, 8, 30), on(28, 9))).toBe('a while ago')
  })
})
