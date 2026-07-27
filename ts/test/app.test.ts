import { describe, expect, it } from 'vitest'

import { buildVoice } from '../src/app.ts'
import { parseCli } from '../src/config.ts'
import { HostedVoice } from '../src/hosted-voice.ts'
import { StubVoice } from '../src/voice.ts'

const config = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseCli(argv, env).config

describe('app wiring', () => {
  it('builds the configured voice provider', () => {
    expect(buildVoice(config([]))).toBeInstanceOf(StubVoice)
    expect(
      buildVoice(config(['--voice', 'hosted'], { MURMUR_TTS_URL: 'https://tts.example' })),
    ).toBeInstanceOf(HostedVoice)
  })

  it('refuses the hosted voice with no endpoint configured, naming the knob', () => {
    expect(() => buildVoice(config(['--voice', 'hosted']))).toThrow(/MURMUR_TTS_URL/)
  })
})
