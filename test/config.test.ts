import { describe, expect, it, vi } from 'vitest'

import { parseCli } from '../src/config.ts'
import { DEFAULT_PERSONA_PATH } from '../src/prompts.ts'

// No MURMUR_TTS_* in the ambient env: every test states the env it means.
const NO_ENV = {}

describe('parseCli', () => {
  it('parses the explicit --setup-music entry (spec 03-03)', () => {
    expect(parseCli([], NO_ENV).setupMusic).toBe(false)
    expect(parseCli(['--setup-music'], NO_ENV).setupMusic).toBe(true)
  })

  it('applies defaults with no flags', () => {
    const { config, maxSegments } = parseCli([], NO_ENV)
    expect(config.brain).toBe('claude')
    expect(config.voice).toBe('stub')
    expect(config.gapSeconds).toBe(2)
    expect(config.recentWindow).toBe(12)
    expect(config.personaPath).toBe(DEFAULT_PERSONA_PATH)
    expect(maxSegments).toBeUndefined()
  })

  it('applies the music + cadence defaults (spec 03-02 §2.3)', () => {
    const { config } = parseCli([], NO_ENV)
    expect(config.musicEnabled).toBe(true)
    expect(config.cadenceMode).toBe('every_n')
    expect(config.musicEveryN).toBe(2)
    expect(config.ytdlpCmd).toBe('yt-dlp')
    expect(config.musicModel).toBe('claude-haiku-4-5-20251001')
  })

  it('layers flags over defaults and coerces numbers', () => {
    const { config, maxSegments } = parseCli(
      ['--brain', 'stub', '--gap', '0.5', '--max-segments', '3', '--no-bed'],
      NO_ENV,
    )
    expect(config.brain).toBe('stub')
    expect(config.gapSeconds).toBe(0.5)
    expect(config.bedEnabled).toBe(false)
    expect(maxSegments).toBe(3)
  })

  it('rejects invalid values at the boundary', () => {
    expect(() => parseCli(['--brain', 'gpt'], NO_ENV)).toThrow()
    expect(() => parseCli(['--gap', '-1'], NO_ENV)).toThrow()
    expect(() => parseCli(['--gap', 'soon'], NO_ENV)).toThrow()
    expect(() => parseCli(['--max-segments', '0'], NO_ENV)).toThrow()
    expect(() => parseCli(['--voice', 'spark'], NO_ENV)).toThrow() // local voices are dropped
    expect(() => parseCli(['--cadence', 'vibes'], NO_ENV)).toThrow()
  })
})

// spec 02 §3.6: the endpoint config comes from env so a URL/key is never
// hardcoded; the CLI can override everything except the API key (a secret does
// not belong in the process list).
describe('hosted-voice config', () => {
  const env = {
    MURMUR_TTS_URL: ' https://tts.example/ \r\n',
    MURMUR_TTS_REFERENCE_ID: 'ref-1',
    MURMUR_TTS_API_KEY: 'secret',
    MURMUR_TTS_MODEL: 's2.1-pro-free',
    MURMUR_TTS_SEED: '4242',
    MURMUR_TTS_SENTENCE_PAD_S: '0.5',
  }

  it('reads the endpoint knobs from env', () => {
    const { config } = parseCli(['--voice', 'hosted'], env)
    expect(config.voice).toBe('hosted')
    expect(config.ttsUrl).toBe('https://tts.example/')
    expect(config.ttsReferenceId).toBe('ref-1')
    expect(config.ttsApiKey).toBe('secret')
    expect(config.ttsModel).toBe('s2.1-pro-free')
    expect(config.ttsSeed).toBe(4242)
    expect(config.ttsSentencePadS).toBe(0.5)
  })

  it('lets CLI flags win over env', () => {
    const { config } = parseCli(
      ['--tts-url', 'http://box.local', '--tts-model', 'other', '--tts-reference', 'ref-2'],
      env,
    )
    expect(config.ttsUrl).toBe('http://box.local')
    expect(config.ttsModel).toBe('other')
    expect(config.ttsReferenceId).toBe('ref-2')
    expect(config.ttsApiKey).toBe('secret') // env-only, no flag
  })

  it('keeps the API key off the command line', () => {
    expect(() => parseCli(['--tts-key', 'secret'], env)).toThrow()
  })

  it('defaults the unset knobs (unpinned voice, 0.8s sentence pad)', () => {
    const { config } = parseCli([], NO_ENV)
    expect(config.ttsUrl).toBe('')
    expect(config.ttsSeed).toBeUndefined()
    expect(config.ttsSentencePadS).toBe(0.8)
  })

  // A bad value in a .env must not abort Config construction (and with it every
  // voice) — it warns and degrades to the documented default.
  it('warns and degrades on an unusable seed or pad instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = parseCli([], {
      MURMUR_TTS_SEED: 'lucky',
      MURMUR_TTS_SENTENCE_PAD_S: '-2',
    })
    expect(config.ttsSeed).toBeUndefined()
    expect(config.ttsSentencePadS).toBe(0.8)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  // A numeric-but-unusable seed (fractional) must degrade like any other bad
  // value — not throw out of parseCli and take every voice down with it.
  it('degrades on a fractional seed instead of aborting startup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = parseCli([], { MURMUR_TTS_SEED: '1.5' })
    expect(config.ttsSeed).toBeUndefined()
    expect(config.voice).toBe('stub')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('treats an empty env value as unset, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = parseCli([], { MURMUR_TTS_SEED: '  ', MURMUR_TTS_SENTENCE_PAD_S: '' })
    expect(config.ttsSeed).toBeUndefined()
    expect(config.ttsSentencePadS).toBe(0.8)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('music flags', () => {
  it('--no-music turns music off and --cadence selects the mode', () => {
    const { config } = parseCli(['--no-music', '--cadence', 'random'], NO_ENV)
    expect(config.musicEnabled).toBe(false)
    expect(config.cadenceMode).toBe('random')
  })
})

// spec 05 §2.3: memory lives under dataRoot()/memory, relocatable with
// MURMUR_HOME; compaction runs on the cheap tier.
describe('memory config', () => {
  it('defaults memoryDir under the (relocatable) data root', () => {
    const { config } = parseCli([], { MURMUR_HOME: '/tmp/mh' })
    expect(config.memoryDir).toBe('/tmp/mh/data/memory')
    expect(parseCli([], NO_ENV).config.memoryDir.endsWith('/.murmur/data/memory')).toBe(true)
  })

  it('defaults compactModel to the cheap tier', () => {
    const { config } = parseCli([], NO_ENV)
    expect(config.compactModel).toBe('claude-haiku-4-5-20251001')
  })
})
