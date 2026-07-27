import { describe, expect, it } from 'vitest'

import { parseCli } from '../src/config.ts'
import { DEFAULT_PERSONA_PATH } from '../src/prompts.ts'

describe('parseCli', () => {
  it('applies defaults with no flags', () => {
    const { config, maxSegments } = parseCli([])
    expect(config.brain).toBe('claude')
    expect(config.voice).toBe('stub')
    expect(config.gapSeconds).toBe(2)
    expect(config.recentWindow).toBe(12)
    expect(config.talkBatch).toBe(2)
    expect(config.personaPath).toBe(DEFAULT_PERSONA_PATH)
    expect(maxSegments).toBeUndefined()
  })

  it('layers flags over defaults and coerces numbers', () => {
    const { config, maxSegments } = parseCli([
      '--brain', 'stub',
      '--gap', '0.5',
      '--max-segments', '3',
      '--player', 'ffplay',
    ])
    expect(config.brain).toBe('stub')
    expect(config.gapSeconds).toBe(0.5)
    expect(config.playerCmd).toBe('ffplay')
    expect(maxSegments).toBe(3)
  })

  it('rejects invalid values at the boundary', () => {
    expect(() => parseCli(['--brain', 'gpt'])).toThrow()
    expect(() => parseCli(['--gap', '-1'])).toThrow()
    expect(() => parseCli(['--gap', 'soon'])).toThrow()
    expect(() => parseCli(['--max-segments', '0'])).toThrow()
  })
})
