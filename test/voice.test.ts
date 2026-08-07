import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MutableVoice, StubVoice } from '../src/voice.ts'
import { FakeVoice } from './fakes.ts'

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

// spec 12 §3.2: the mute knob flips at the synthesis site, per utterance — the
// real provider is never torn down, so unmuting is as instant as muting.
describe('MutableVoice', () => {
  it('routes to the real voice unmuted and to silence muted, live', async () => {
    const real = new FakeVoice()
    let muted = false
    const voice = new MutableVoice({ real, muted: () => muted })
    await voice.start()
    await voice.synthesize('heard')
    expect(real.synthesized).toEqual(['heard'])
    muted = true
    const clip = await voice.synthesize('silenced')
    expect(real.synthesized).toEqual(['heard']) // the real voice never saw it
    expect(clip.kind).toBe('talk') // still a playable clip; the program rolls on
    muted = false
    await voice.synthesize('back')
    expect(real.synthesized).toEqual(['heard', 'back'])
    await voice.close()
  })

  it('closes both backends', async () => {
    let closed = 0
    const real = new FakeVoice()
    real.close = async () => void closed++
    const voice = new MutableVoice({ real, muted: () => true })
    await voice.synthesize('x') // materializes the silent backend
    await voice.close()
    expect(closed).toBe(1)
  })
})
