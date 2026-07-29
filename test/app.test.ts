import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { IdleSensor } from '../src/activity.ts'
import {
  buildHost,
  buildMemory,
  buildPacing,
  buildVoice,
  resolvePersonaPath,
  runBootstrapProfileCli,
  runMusicSetupCli,
} from '../src/app.ts'
import { parseCli } from '../src/config.ts'
import { isFirstRun } from '../src/first-run.ts'
import { CliHost } from '../src/host.ts'
import { HostedVoice } from '../src/hosted-voice.ts'
import { IpcHost } from '../src/ipc-host.ts'
import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory.ts'
import { LedgerScheduler } from '../src/scheduler.ts'
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

  it('--setup-music needs the real brain: a stub run refuses instead of hanging', async () => {
    // The guide IS the real Claude Code agent; there is no stub of it.
    expect(await runMusicSetupCli(config(['--brain', 'stub']))).toBe(false)
  })
})

// spec 07 §3.7/§5.15: the three switches, and what "all off" has to mean.
describe('pacing wiring', () => {
  const memory = new InProcessMemoryStore()

  it('wires the sensor and both features by default, anchors over the ledger', () => {
    const pacing = buildPacing(config([]), memory)!
    expect(pacing.sensor).toBeInstanceOf(IdleSensor)
    expect(pacing.scheduler).toBeInstanceOf(LedgerScheduler)
    expect(pacing).toMatchObject({ invites: true, gating: true })
  })

  it('drops each feature on its flag while keeping the sensor', () => {
    expect(buildPacing(config(['--no-anchors']), memory)!.scheduler).toBeUndefined()
    expect(buildPacing(config(['--no-invites']), memory)!.invites).toBe(false)
    expect(buildPacing(config(['--no-gating']), memory)!.gating).toBe(false)
  })

  it('all three off drops the block entirely — pre-spec-07 prompts AND timing', () => {
    // Not merely "no anchors": with the block gone the Director adds no
    // activity cue to the pack and never stretches the gap.
    expect(buildPacing(config(['--no-anchors', '--no-invites', '--no-gating']), memory)).toBeUndefined()
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

  it('homes the persona in memoryDir, and is pure: first run is what fills it', () => {
    // spec 06 §2.1: the resolver no longer copies the bundled seed — the
    // first-run flow decides what lands at the home (onboarding or the seed).
    const dir = tmp()
    const seed = join(dir, 'seed.md')
    writeFileSync(seed, 'seed persona')
    const c = { ...config([]), personaPath: seed, memoryDir: join(dir, 'memory') }

    const homed = resolvePersonaPath(c, true)
    expect(homed).toBe(join(dir, 'memory', 'persona.md'))
    expect(existsSync(homed)).toBe(false)
    expect(existsSync(join(dir, 'memory'))).toBe(false)
    expect(isFirstRun(c.memoryDir)).toBe(true)

    // A stub run loads the seed directly — no memory-dir writes (criterion 11).
    expect(resolvePersonaPath(c, false)).toBe(seed)
  })

  it('never rewrites an existing persona: a later run only reads it (criterion 5)', () => {
    const dir = tmp()
    const memoryDir = join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const home = join(memoryDir, 'persona.md')
    writeFileSync(home, 'the persona I hand-edited')
    const before = statSync(home).mtimeMs
    const c = { ...config([]), personaPath: join(dir, 'seed.md'), memoryDir }

    // The two seams runApp gates the whole first-run flow on.
    expect(isFirstRun(memoryDir)).toBe(false)
    expect(resolvePersonaPath(c, true)).toBe(home)

    expect(readFileSync(home, 'utf-8')).toBe('the persona I hand-edited')
    expect(statSync(home).mtimeMs).toBe(before)
  })
})

describe('--bootstrap-profile (spec 06 §3.4 re-entry)', () => {
  it('needs the real brain: a stub run refuses instead of pretending', async () => {
    expect(await runBootstrapProfileCli(config(['--brain', 'stub']))).toBe(false)
  })
})

// spec 10 §2.2/§3.5/§5.10: the core never constructs a concrete host; the
// factory returns the seam, and a missing Bun degrades instead of half-starting.
describe('front-end wiring (spec 10)', () => {
  // A stand-in bun: answers --version for the preflight, then plays the part
  // of a client that sits there until it is torn down.
  const stubBun = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-bun-'))
    const path = join(dir, 'bun')
    writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.14; else sleep 30; fi\n', {
      mode: 0o755,
    })
    return path
  }

  it('defaults to the plain host, with nothing to tear down', async () => {
    const bundle = await buildHost(config([]))
    expect(bundle.host).toBeInstanceOf(CliHost)
    await bundle.close()
  })

  it('binds the socket and hands back the IPC host when the TUI is asked for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-front-'))
    const socket = join(dir, 'tui.sock')
    const bundle = await buildHost({
      ...config(['--tui']),
      tuiSocket: socket,
      bunCmd: stubBun(),
    })
    expect(bundle.host).toBeInstanceOf(IpcHost)
    expect(existsSync(socket)).toBe(true)
    // Quitting leaves no socket file and no orphan client (criterion 8).
    await bundle.close()
    expect(existsSync(socket)).toBe(false)
  })

  it('a client that dies before attaching ends input instead of wedging the Q&A', async () => {
    // Peer review (codex): with no socket ever opened, nothing would resolve
    // eof, and a first-run question would wait on peekLine forever.
    const dir = mkdtempSync(join(tmpdir(), 'murmur-front-'))
    const dead = join(dir, 'bun')
    writeFileSync(dead, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.14; else exit 1; fi\n', {
      mode: 0o755,
    })
    const bundle = await buildHost({
      ...config(['--tui']),
      tuiSocket: join(dir, 'tui.sock'),
      bunCmd: dead,
    })
    await expect(bundle.host.eof!()).resolves.toBeUndefined()
    await bundle.close()
  })

  it('degrades to the plain host, saying so, when Bun is absent', async () => {
    const bundle = await buildHost({
      ...config(['--tui']),
      tuiSocket: join(mkdtempSync(join(tmpdir(), 'murmur-front-')), 'tui.sock'),
      bunCmd: '/nope/bun',
    })
    expect(bundle.host).toBeInstanceOf(CliHost)
    await bundle.close()
  })
})
