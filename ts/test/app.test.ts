import { describe, expect, it } from 'vitest'

import { buildVoice } from '../src/app.ts'
import { StubVoice } from '../src/voice.ts'

describe('app wiring', () => {
  it('builds the configured voice provider', () => {
    expect(buildVoice('stub')).toBeInstanceOf(StubVoice)
  })
})
