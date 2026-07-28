import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildMemory, buildVoice, resolvePersonaPath } from '../src/app.ts'
import { parseCli } from '../src/config.ts'
import { HostedVoice } from '../src/hosted-voice.ts'
import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory.ts'
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

// spec 05 §3.7 stub isolation + §3.2 persona homing.
describe('memory wiring', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'murmur-app-'))

  it('a claude run persists to memoryDir; a stub run stays in-process', () => {
    const dir = tmp()
    const claude = { ...config([]), memoryDir: join(dir, 'memory') }
    expect(buildMemory(claude)).toBeInstanceOf(PersistentMemoryStore)
    const stub = { ...config(['--brain', 'stub']), memoryDir: join(dir, 'memory-stub') }
    expect(buildMemory(stub)).toBeInstanceOf(InProcessMemoryStore)
    // Stub isolation: the stub wiring never creates or touches the memory dir.
    expect(existsSync(join(dir, 'memory-stub'))).toBe(false)
  })

  it('homes the persona in memoryDir on first persistent run, copy-once', () => {
    const dir = tmp()
    const seed = join(dir, 'seed.md')
    writeFileSync(seed, 'seed persona')
    const c = { ...config([]), personaPath: seed, memoryDir: join(dir, 'memory') }

    const homed = resolvePersonaPath(c, true)
    expect(homed).toBe(join(dir, 'memory', 'persona.md'))
    expect(readFileSync(homed, 'utf-8')).toBe('seed persona')

    // Copy-once: a later run loads the (possibly evolved) homed copy untouched.
    writeFileSync(homed, 'evolved persona')
    expect(readFileSync(resolvePersonaPath(c, true), 'utf-8')).toBe('evolved persona')

    // A stub run loads the seed directly — no memory-dir writes.
    expect(resolvePersonaPath(c, false)).toBe(seed)
  })
})
