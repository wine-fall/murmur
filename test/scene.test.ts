import { describe, expect, it, vi } from 'vitest'

import { currentScene, sceneFor } from '../src/scene.ts'

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
