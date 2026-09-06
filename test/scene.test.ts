import { describe, expect, it, vi } from 'vitest'

import { currentScene, formatClock, sceneFor } from '../src/director/scene.ts'

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
