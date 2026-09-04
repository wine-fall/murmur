import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { packageVersion, parseCli } from '../src/config.ts'
import { DEFAULT_PERSONA_PATH } from '../src/prompts.ts'

// Every test states the env it means, and its home is a directory with nothing
// in it — so a real ~/.murmur/{voice,settings}.json on the developer's machine
// can never decide what a test sees.
const isolated = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MURMUR_HOME: mkdtempSync(join(tmpdir(), 'murmur-cfg-')),
  ...extra,
})
const NO_ENV = isolated()

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
    MURMUR_TTS_SPEED: '0.85',
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
    expect(config.ttsSpeed).toBe(0.85)
  })

  // spec 02 §3.6: the speaking rate is one more knob on the same chain.
  it('--tts-speed wins over env, and an unset speed stays unset', () => {
    expect(parseCli(['--tts-speed', '0.9'], env).config.ttsSpeed).toBe(0.9)
    const empty = { MURMUR_HOME: mkdtempSync(join(tmpdir(), 'murmur-cfg-')) }
    expect(parseCli([], empty).config.ttsSpeed).toBeUndefined()
  })

  it('warns and degrades on an unusable speed instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['fast', '0', '9']) {
      expect(parseCli([], isolated({ MURMUR_TTS_SPEED: bad })).config.ttsSpeed).toBeUndefined()
    }
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
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
    const { config } = parseCli(
      [],
      isolated({ MURMUR_TTS_SEED: 'lucky', MURMUR_TTS_SENTENCE_PAD_S: '-2' }),
    )
    expect(config.ttsSeed).toBeUndefined()
    expect(config.ttsSentencePadS).toBe(0.8)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  // A numeric-but-unusable seed (fractional) must degrade like any other bad
  // value — not throw out of parseCli and take every voice down with it.
  it('degrades on a fractional seed instead of aborting startup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = parseCli([], isolated({ MURMUR_TTS_SEED: '1.5' }))
    expect(config.ttsSeed).toBeUndefined()
    expect(config.voice).toBe('stub')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('treats an empty env value as unset, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = parseCli([], isolated({ MURMUR_TTS_SEED: '  ', MURMUR_TTS_SENTENCE_PAD_S: '' }))
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

// spec 07 §3.7: everything proactive is switchable off, back to pre-spec-07.
describe('pacing flags', () => {
  it('defaults both on', () => {
    const { config } = parseCli([], NO_ENV)
    expect([config.anchorsEnabled, config.gatingEnabled]).toEqual([true, true])
  })

  it('--no-anchors / --no-gating turn them off independently', () => {
    expect(parseCli(['--no-anchors'], NO_ENV).config).toMatchObject({
      anchorsEnabled: false,
      gatingEnabled: true,
    })
    expect(parseCli(['--no-gating'], NO_ENV).config.gatingEnabled).toBe(false)
  })
})

// spec 13 §2.6: the knob is anchorsEnabled's shape (file < flag); the numbers
// are env-only, with the MURMUR_TTS_* warn-and-default posture.
describe('real-world topics config', () => {
  it('defaults on; --no-rwt turns it off', () => {
    expect(parseCli([], NO_ENV).config.rwtEnabled).toBe(true)
    expect(parseCli(['--no-rwt'], NO_ENV).config.rwtEnabled).toBe(false)
  })

  it('places the pool under cache/ and the policy at the home root', () => {
    const { config } = parseCli([], { MURMUR_HOME: '/tmp/mh' })
    expect(config.rwtPoolPath).toBe('/tmp/mh/cache/rwt.json')
    expect(config.rwtPolicyPath).toBe('/tmp/mh/rwt-policy.md')
  })

  it('reads the roll and freshness numbers from env, and ignores a bad one with a warning', () => {
    const { config } = parseCli(
      [],
      isolated({ MURMUR_RWT_P: '0.5', MURMUR_RWT_MIN_GAP: '2', MURMUR_RWT_MAX_GAP: '6', MURMUR_RWT_STALE_HOURS: '3', MURMUR_RWT_TTL_HOURS: '24' }),
    )
    expect([config.rwtP, config.rwtMinGap, config.rwtMaxGap, config.rwtStaleHours, config.rwtTtlHours]).toEqual([
      0.5, 2, 6, 3, 24,
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseCli([], isolated({ MURMUR_RWT_P: 'often' })).config.rwtP).toBe(0.35)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MURMUR_RWT_P'))
    warn.mockRestore()
  })
})

// spec 03-01 §2.3: the pick policy is a file the listener owns, at the home
// root; the listening-data key is a secret, so it only ever comes from env.
describe('music discovery config', () => {
  it('defaults musicPolicyPath under the (relocatable) home', () => {
    expect(parseCli([], { MURMUR_HOME: '/tmp/mh' }).config.musicPolicyPath).toBe('/tmp/mh/music-policy.md')
  })

  it('takes the listening key from env only, and treats a blank one as absent', () => {
    expect(parseCli([], { ...NO_ENV, MURMUR_LISTENING_API_KEY: ' abc ' }).config.listeningApiKey).toBe('abc')
    expect(parseCli([], { ...NO_ENV, MURMUR_LISTENING_API_KEY: '  ' }).config.listeningApiKey).toBe('')
    expect(parseCli([], NO_ENV).config.listeningApiKey).toBe('')
  })

  // The catalogue is a knob too: the protocol is public, so which host answers
  // is configuration, and an unset one means the shipped default.
  it('lets the listening endpoint be pointed elsewhere', () => {
    expect(parseCli([], { ...NO_ENV, MURMUR_LISTENING_URL: ' https://libre.fm/2.0/ ' }).config.listeningUrl).toBe(
      'https://libre.fm/2.0/',
    )
    expect(parseCli([], NO_ENV).config.listeningUrl).toBe('')
  })
})

// spec 05 §2.3: an installed murmur logs by default, under the one home; only
// an explicit MURMUR_DEV_LOG moves it (make dev) or silences it.
describe('dev log config', () => {
  it('defaults to a dated file under the (relocatable) home', () => {
    const { config } = parseCli([], { MURMUR_HOME: '/tmp/mh' })
    expect(config.devLog).toMatch(/^\/tmp\/mh\/log\/murmur-\d{4}-\d{2}-\d{2}\.log$/)
  })

  it('honours an explicit MURMUR_DEV_LOG, empty string included', () => {
    expect(parseCli([], { MURMUR_DEV_LOG: '.dev/dev.log' }).config.devLog).toBe('.dev/dev.log')
    expect(parseCli([], { MURMUR_DEV_LOG: '' }).config.devLog).toBe('')
  })
})

// spec 05 §2.3: memory lives under dataRoot()/memory, relocatable with
// MURMUR_HOME; compaction runs on the cheap tier.
// The report and the crash road both read log evidence; both must be told
// which SHAPE it takes, and the config boundary is where that is decided once.
describe('log evidence config', () => {
  it('is the dated set by default, under the resolved home', () => {
    const { config } = parseCli([], { MURMUR_HOME: '/tmp/mh' })
    expect(config.logEvidence).toEqual({ kind: 'daily', dir: '/tmp/mh/log' })
  })

  it('is the single file MURMUR_DEV_LOG names', () => {
    // What `make dev` sets: the run's diagnostics go to one undated file, and
    // a report of that run has to quote it.
    const { config } = parseCli([], { MURMUR_HOME: '/tmp/mh', MURMUR_DEV_LOG: '.dev/dev.log' })
    expect(config.logEvidence).toEqual({ kind: 'file', path: '.dev/dev.log' })
    expect(config.devLog).toBe('.dev/dev.log')
  })

  it('is nothing when the run is asked to keep no log', () => {
    const { config } = parseCli([], { MURMUR_DEV_LOG: '' })
    expect(config.logEvidence).toEqual({ kind: 'none' })
  })
})

describe('memory config', () => {
  it('defaults memoryDir under the (relocatable) data root', () => {
    const { config } = parseCli([], { MURMUR_HOME: '/tmp/mh' })
    expect(config.memoryDir).toBe('/tmp/mh/data/memory')
  })

  it('defaults compactModel to the cheap tier', () => {
    const { config } = parseCli([], NO_ENV)
    expect(config.compactModel).toBe('claude-haiku-4-5-20251001')
  })
})

describe('spec 06 CLI entry', () => {
  it('--bootstrap-profile is an explicit one-shot entry, off by default', () => {
    expect(parseCli([], NO_ENV).bootstrapProfile).toBe(false)
    expect(parseCli(['--bootstrap-profile'], NO_ENV).bootstrapProfile).toBe(true)
  })
})

// spec 03-03 §7.1: the explicit entries are separate serial conversations,
// never woven into a first run.
describe('setup CLI entries (spec 03-03 §7)', () => {
  it('--setup opens the full onboarding surface; --setup-music only the binaries', () => {
    expect(parseCli([], NO_ENV).setup).toBe(false)
    expect(parseCli(['--setup'], NO_ENV).setup).toBe(true)
    expect(parseCli(['--setup'], NO_ENV).setupMusic).toBe(false)
    expect(parseCli(['--setup-music'], NO_ENV).setup).toBe(false)
  })
})

// spec 03-03 §7.2: the guide writes $MURMUR_HOME/voice.json; env keeps
// precedence, so .env stays a dev-time override the app never writes.
describe('voice config file precedence', () => {
  const home = (config: object | null): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-cfg-'))
    if (config !== null) writeFileSync(join(dir, 'voice.json'), JSON.stringify(config))
    return { MURMUR_HOME: dir }
  }

  it('reads the endpoint from voice.json when the env says nothing', () => {
    const { config } = parseCli([], home({ ttsUrl: 'https://file.example', seed: 9 }))
    expect(config.ttsUrl).toBe('https://file.example')
    expect(config.ttsSeed).toBe(9)
  })

  it('env beats the file', () => {
    const env = { ...home({ ttsUrl: 'https://file.example', seed: 9, speed: 0.85 }) }
    env.MURMUR_TTS_URL = 'https://env.example'
    env.MURMUR_TTS_SEED = '1'
    env.MURMUR_TTS_SPEED = '1.1'
    const { config } = parseCli([], env)
    expect(config.ttsUrl).toBe('https://env.example')
    expect(config.ttsSeed).toBe(1)
    expect(config.ttsSpeed).toBe(1.1)
  })

  it('reads the speed the guide wrote when the env says nothing', () => {
    const { config } = parseCli([], home({ ttsUrl: 'https://file.example', speed: 0.85 }))
    expect(config.ttsSpeed).toBe(0.85)
  })

  // Issue #96: the file mirrors the MURMUR_TTS_* surface, so a conversation
  // that configured hosted fish.audio produces a session that can actually
  // reach it — key, model header and voice id included.
  it('reads every hosted knob the guide can write', () => {
    const { config } = parseCli(
      [],
      home({
        ttsUrl: 'https://api.fish.audio',
        model: 's2.1-pro-free',
        referenceId: 'abc123',
        apiKey: 'sk-not-a-real-key',
      }),
    )
    expect(config.ttsModel).toBe('s2.1-pro-free')
    expect(config.ttsReferenceId).toBe('abc123')
    expect(config.ttsApiKey).toBe('sk-not-a-real-key')
  })

  it('env beats the file per knob, and the file fills what env leaves unset', () => {
    const env = {
      ...home({
        ttsUrl: 'https://file.example',
        model: 'file-model',
        referenceId: 'file-ref',
        apiKey: 'file-key',
      }),
      MURMUR_TTS_MODEL: 'env-model',
    }
    const { config } = parseCli([], env)
    expect(config.ttsModel).toBe('env-model')
    expect(config.ttsReferenceId).toBe('file-ref')
    expect(config.ttsApiKey).toBe('file-key')
  })

  // Peer review (codex): per-knob precedence let a saved credential ride along
  // to somewhere else — `--tts-url http://box.local` on a machine whose
  // voice.json holds a fish.audio key sent that key to box.local. A stored key
  // belongs to the endpoint it was stored with.
  it('never sends a stored key to an endpoint it was not stored with', () => {
    const saved = { ttsUrl: 'https://api.fish.audio', apiKey: 'sk-not-a-real-key' }
    expect(parseCli([], { ...home(saved), MURMUR_TTS_URL: 'http://box.local' }).config.ttsApiKey).toBe('')
    expect(parseCli(['--tts-url', 'http://box.local'], home(saved)).config.ttsApiKey).toBe('')
    // The same endpoint re-stated from another layer is still that endpoint.
    expect(parseCli(['--tts-url', 'https://api.fish.audio'], home(saved)).config.ttsApiKey).toBe(
      'sk-not-a-real-key',
    )
    expect(parseCli([], home(saved)).config.ttsApiKey).toBe('sk-not-a-real-key')
    // An env key is the caller's own statement and always applies.
    const env = { ...home(saved), MURMUR_TTS_URL: 'http://box.local', MURMUR_TTS_API_KEY: 'sk-env' }
    expect(parseCli([], env).config.ttsApiKey).toBe('sk-env')
  })

  it('a CLI flag beats both', () => {
    const env = { ...home({ ttsUrl: 'https://file.example' }) }
    env.MURMUR_TTS_URL = 'https://env.example'
    expect(parseCli(['--tts-url', 'http://box.local'], env).config.ttsUrl).toBe('http://box.local')
  })

  it('no file and no env is simply an unconfigured endpoint', () => {
    expect(parseCli([], home(null)).config.ttsUrl).toBe('')
  })

  // issue #93: having an endpoint IS the reason to speak with it. Deriving the
  // default from the endpoint is what makes a voice configured through the
  // guide (spec 03-03 §7.2) audible on the next boot rather than silently
  // ignored because the knob still says 'stub'.
  it('defaults the voice to hosted when an endpoint is configured, from either layer', () => {
    expect(parseCli([], home({ ttsUrl: 'https://file.example' })).config.voice).toBe('hosted')
    const env = { ...home(null), MURMUR_TTS_URL: 'https://env.example' }
    expect(parseCli([], env).config.voice).toBe('hosted')
    expect(parseCli(['--tts-url', 'http://box.local'], home(null)).config.voice).toBe('hosted')
  })

  it('stays on the stub voice when there is no endpoint anywhere', () => {
    expect(parseCli([], home(null)).config.voice).toBe('stub')
  })

  it('an explicit --voice always wins over the derived default, both ways', () => {
    // Someone who asked for silence gets silence, endpoint or not...
    expect(
      parseCli(['--voice', 'stub'], home({ ttsUrl: 'https://file.example' })).config.voice,
    ).toBe('stub')
    // ...and asking for the hosted voice with nothing configured still degrades
    // at build time rather than being quietly rewritten here.
    expect(parseCli(['--voice', 'hosted'], home(null)).config.voice).toBe('hosted')
  })

  it('an unusable file degrades to unconfigured rather than aborting startup', () => {
    const env = home(null)
    writeFileSync(join(env.MURMUR_HOME!, 'voice.json'), 'not json at all')
    expect(parseCli([], env).config.ttsUrl).toBe('')
  })
})

// spec 12 §2.2: settings.json merges under env and flags, per knob; a voice key
// present in the file is an explicit choice (the pane's mute), so it carries
// the same provenance a typed --voice does.
describe('settings file layer (spec 12)', () => {
  const home = (settings: object | string | null): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-cfg-'))
    if (settings !== null) {
      const body = typeof settings === 'string' ? settings : JSON.stringify(settings)
      writeFileSync(join(dir, 'settings.json'), body)
    }
    return { MURMUR_HOME: dir }
  }

  it('a hand-written settings.json changes the running defaults', () => {
    const { config } = parseCli([], home({ gapSeconds: 5, musicEnabled: false, tuiPet: false }))
    expect(config.gapSeconds).toBe(5)
    expect(config.musicEnabled).toBe(false)
    expect(config.tuiPet).toBe(false)
    expect(config.recentWindow).toBe(12) // untouched knobs keep their defaults
  })

  it('flags beat the file per knob', () => {
    const { config } = parseCli(['--gap', '1'], home({ gapSeconds: 5, musicEveryN: 4 }))
    expect(config.gapSeconds).toBe(1)
    expect(config.musicEveryN).toBe(4) // the un-flagged sibling still applies
  })

  it('a file-set mute rides into the config without touching the voice knob', () => {
    // spec 12 §3.4: muted is the output gain; the voice PROVIDER still derives
    // from the endpoint exactly as before — a muted run keeps its warm voice.
    const env = home({ muted: true })
    env.MURMUR_TTS_URL = 'https://env.example'
    const { config } = parseCli([], env)
    expect(config.muted).toBe(true)
    expect(config.voice).toBe('hosted')
  })

  it('defaults to unmuted', () => {
    expect(parseCli([], NO_ENV).config.muted).toBe(false)
  })

  it('a broken key is dropped alone while its siblings apply', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { config } = parseCli([], home({ gapSeconds: -5, musicEveryN: 3 }))
    expect(config.gapSeconds).toBe(2) // the broken key falls back to default
    expect(config.musicEveryN).toBe(3)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('an unparseable file degrades to defaults rather than aborting startup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseCli([], home('{not json')).config.gapSeconds).toBe(2)
    warn.mockRestore()
  })

  it('defaults the pet on', () => {
    expect(parseCli([], NO_ENV).config.tuiPet).toBe(true)
  })
})

// spec 10 §6 (decided 2026-07-31): the default front-end is 'tui'; a bun-less
// machine falls back to plain at the app level, and --plain / TUI=0 are the
// explicit escape.
describe('front-end config', () => {
  it('defaults to the TUI, with bun as the named binary', () => {
    const { config } = parseCli([], NO_ENV)
    expect(config.frontEnd).toBe('tui')
    expect(config.bunCmd).toBe('bun')
  })

  it('--tui selects the TUI front-end', () => {
    expect(parseCli(['--tui'], NO_ENV).config.frontEnd).toBe('tui')
  })

  it('--plain is the escape back to the plain host, and beats --tui', () => {
    expect(parseCli(['--plain'], NO_ENV).config.frontEnd).toBe('plain')
    // An explicit opt-out is never overridden by a redundant opt-in.
    expect(parseCli(['--tui', '--plain'], NO_ENV).config.frontEnd).toBe('plain')
  })

  it('resolves the wire socket under the (relocatable) murmur home', () => {
    expect(parseCli([], { MURMUR_HOME: '/tmp/mh' }).config.tuiSocket).toBe('/tmp/mh/run/tui.sock')
  })
})

// The runtime must be able to answer "which murmur is this?" — the bug-report
// form asks for a version, and an npm-installed listener has no repo to read.
describe('packageVersion', () => {
  it('reads the version from the package root beside the code', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(packageVersion()).toBe(manifest.version)
  })

  it('falls back to "unknown" when no manifest sits beside the code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-version-'))
    expect(packageVersion(pathToFileURL(join(dir, 'dist', 'config.js')))).toBe('unknown')
  })

  it('falls back to "unknown" when the manifest is corrupt or versionless', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-version-'))
    writeFileSync(join(dir, 'package.json'), '{ not json at all')
    const from = pathToFileURL(join(dir, 'dist', 'config.js'))
    expect(packageVersion(from)).toBe('unknown')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'murmur-radio' }))
    expect(packageVersion(from)).toBe('unknown')
  })
})

describe('--version entry', () => {
  it('is off unless asked for', () => {
    expect(parseCli([], NO_ENV).version).toBe(false)
  })

  it('is requested by --version', () => {
    expect(parseCli(['--version'], NO_ENV).version).toBe(true)
  })
})
