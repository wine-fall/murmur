import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import { StubVoice } from '../src/voice/voice.ts'

describe('StubVoice', () => {
  it('produces a playable talk clip and cleans its dir on close', async () => {
    const voice = new StubVoice()
    await voice.start()
    const clip = await voice.synthesize('hello')
    expect(clip.kind).toBe('talk')
    expect(existsSync(clip.source)).toBe(true)
    expect(readFileSync(clip.source).toString('ascii', 0, 4)).toBe('RIFF')
    await voice.close()
    expect(existsSync(dirname(clip.source))).toBe(false)
  })
})
