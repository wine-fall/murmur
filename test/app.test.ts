import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { IdleSensor } from '../src/activity.ts'
import {
  buildHost,
  buildMemory,
  buildPacing,
  buildSettingsStore,
  buildVoice,
  musicWiringWanted,
  resolvePersonaPath,
  runBootstrapProfileCli,
  runSetupCli,
  setupTargets,
  voiceAfterSetup,
} from '../src/app.ts'
import { parseCli } from '../src/config.ts'
import { isFirstRun } from '../src/first-run.ts'
import { CliHost } from '../src/host.ts'
import { HostedVoice } from '../src/hosted-voice.ts'
import { IpcHost } from '../src/ipc-host.ts'
import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory.ts'
import { LedgerScheduler } from '../src/scheduler.ts'
import { readSettingsFile } from '../src/settings.ts'
import { StubVoice } from '../src/voice.ts'

const config = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseCli(argv, env).config

// A murmur home with nothing in it — so a stray real ~/.murmur/voice.json on
// the developer's machine can never decide what these tests see.
const emptyHome = (): string => mkdtempSync(join(tmpdir(), 'murmur-home-'))

describe('app wiring', () => {
  it('builds the configured voice provider', () => {
    expect(buildVoice(config([]))).toBeInstanceOf(StubVoice)
    expect(
      buildVoice(config(['--voice', 'hosted'], { MURMUR_TTS_URL: 'https://tts.example' })),
    ).toBeInstanceOf(HostedVoice)
  })

  // spec 03-03 §7.1 point 4: the radio ALWAYS launches. An unconfigured
  // endpoint costs the sound, not the session — the lines still land visibly,
  // which is what keeps "talk to murmur to fix it" possible at all.
  it('degrades an unconfigured hosted voice to silence, saying so, instead of throwing', () => {
    const said: string[] = []
    const voice = buildVoice(config(['--voice', 'hosted'], { MURMUR_HOME: emptyHome() }), (m) =>
      said.push(m),
    )
    expect(voice).toBeInstanceOf(StubVoice)
    expect(said.join('\n')).toContain('see the lines')
  })

  it('--setup / --setup-music need the real brain: a stub run refuses instead of hanging', async () => {
    // The guide IS the real Claude Code agent; there is no stub of it.
    expect(await runSetupCli(config(['--brain', 'stub']))).toBe(false)
    expect(await runSetupCli(config(['--brain', 'stub']), { musicOnly: true })).toBe(false)
  })
})

// spec 03-03 §7.3 criterion 5: the conversation ends with a validated config
// AND an audible line. An endpoint saved mid-boot has to be HEARD this boot.
describe('voiceAfterSetup (issue #93)', () => {
  const home = () => ({ MURMUR_HOME: emptyHome() })

  it('speaks with an endpoint the conversation just wrote', () => {
    const before = config([], home())
    expect(before.voice).toBe('stub')
    const after = voiceAfterSetup(before, { ttsUrl: 'https://written.example' })
    expect(after.voice).toBe('hosted')
    expect(after.ttsUrl).toBe('https://written.example')
    expect(buildVoice(after)).toBeInstanceOf(HostedVoice)
  })

  it('leaves a run that already had an endpoint exactly as configured', () => {
    // An explicit `--voice stub` on a machine that HAS an endpoint is a
    // deliberate request for silence, not a gap the conversation just closed.
    const silent = config(['--voice', 'stub'], { MURMUR_TTS_URL: 'https://env.example' })
    expect(voiceAfterSetup(silent, { ttsUrl: 'https://env.example' })).toEqual(silent)
    expect(buildVoice(voiceAfterSetup(silent, { ttsUrl: 'https://env.example' }))).toBeInstanceOf(StubVoice)
  })

  it('a declined or failed voice setup stays silent, not half-configured', () => {
    const before = config([], home())
    expect(voiceAfterSetup(before, null)).toEqual(before)
  })

  // Peer review (codex): the promotion could not tell a DERIVED stub (no
  // endpoint, so the default resolved to stub) from an EXPLICIT `--voice stub`,
  // so it overrode a deliberate request for silence. The flag wins for this
  // run; the endpoint is still saved, so the next boot speaks.
  it('never overrides an explicit --voice stub, even right after configuring one', () => {
    const silent = config(['--voice', 'stub'], home())
    expect(silent.ttsUrl).toBe('')
    const after = voiceAfterSetup(silent, { ttsUrl: 'https://written.example' })
    expect(after.voice).toBe('stub')
    expect(buildVoice(after)).toBeInstanceOf(StubVoice)
  })

  it('an explicit --voice hosted is honoured once an endpoint arrives', () => {
    const wanted = config(['--voice', 'hosted'], home())
    const after = voiceAfterSetup(wanted, { ttsUrl: 'https://written.example' })
    expect(after.voice).toBe('hosted')
    expect(after.ttsUrl).toBe('https://written.example')
  })

  // Issue #96: a hosted endpoint is more than a URL. Carrying only the URL out
  // of the conversation meant the key and the `model` header the guide had just
  // captured were dropped for the rest of THIS boot — so §7.3 criterion 5's
  // "an audible line" was false for exactly the backend new users are sent to.
  it('carries the whole config out of the conversation, not just the URL', () => {
    const after = voiceAfterSetup(config([], home()), {
      ttsUrl: 'https://api.fish.audio',
      model: 's2.1-pro-free',
      referenceId: 'abc123',
      apiKey: 'sk-not-a-real-key',
    })
    expect(after).toMatchObject({
      voice: 'hosted',
      ttsUrl: 'https://api.fish.audio',
      ttsModel: 's2.1-pro-free',
      ttsReferenceId: 'abc123',
      ttsApiKey: 'sk-not-a-real-key',
    })
  })

  it('still lets env and flags win per knob over what the file just said', () => {
    const env = config([], { ...home(), MURMUR_TTS_MODEL: 'env-model' })
    const after = voiceAfterSetup(env, {
      ttsUrl: 'https://api.fish.audio',
      model: 'file-model',
      apiKey: 'sk-not-a-real-key',
    })
    expect(after.ttsModel).toBe('env-model')
    expect(after.ttsApiKey).toBe('sk-not-a-real-key')
  })

  // Peer review (codex): the banner read config.voice while audio was built
  // from the promoted config, so the first post-setup run advertised 'stub'
  // while speaking. One resolved config now feeds both.
  it('is the single source for what plays AND what the banner reports', () => {
    const after = voiceAfterSetup(config([], home()), { ttsUrl: 'https://written.example' })
    expect(after.voice).toBe('hosted')
    expect(buildVoice(after)).toBeInstanceOf(HostedVoice)
  })
})

// spec 03-03 §7.1: what the setup conversation is allowed to look at is derived
// from the session's own config — it never probes for something unwanted.
describe('setup targets', () => {
  it('wants exactly what this session is configured to use', () => {
    const full = setupTargets(config(['--voice', 'hosted'], { MURMUR_TTS_URL: 'https://x' }))
    expect(full).toMatchObject({ wantsMusic: true, wantsBun: true, wantsVoice: true })
    expect(full.voiceUrl()).toBe('https://x')

    const lean = setupTargets(config(['--no-music', '--plain'], { MURMUR_HOME: emptyHome() }))
    expect(lean).toMatchObject({ wantsMusic: false, wantsBun: false })
  })

  // issue #93: the boot offer never named the voice gap, because wantsVoice was
  // read off config.voice — which defaults to 'stub'. A brand-new user was
  // therefore never told at boot that the radio has no real voice.
  it('considers the voice endpoint even on a stub-voice run', () => {
    const home = emptyHome()
    expect(setupTargets(config([], { MURMUR_HOME: home })).wantsVoice).toBe(true)
    // Even when the listener explicitly asked for silence: it is offered once,
    // and declining is what records the standing answer.
    expect(setupTargets(config(['--voice', 'stub'], { MURMUR_HOME: home })).wantsVoice).toBe(true)
  })

  it('scopes --setup-music to the binaries alone', () => {
    const targets = setupTargets(config([], { MURMUR_HOME: emptyHome() }), {
      wantsBun: false,
      wantsVoice: false,
    })
    expect(targets).toMatchObject({ wantsMusic: true, wantsBun: false, wantsVoice: false })
  })

  it('re-reads the endpoint each call, so a mid-conversation write is picked up', () => {
    const home = emptyHome()
    const targets = setupTargets(config(['--voice', 'hosted'], { MURMUR_HOME: home }))
    expect(targets.voiceUrl()).toBe('')
    writeFileSync(join(home, 'voice.json'), JSON.stringify({ ttsUrl: 'https://written.example' }))
    expect(targets.voiceUrl()).toBe('https://written.example')
  })

  it('hands back the whole written config, so a captured key is live this boot', () => {
    const home = emptyHome()
    const targets = setupTargets(config([], { MURMUR_HOME: home }))
    expect(targets.voiceConfig()).toBeNull()
    writeFileSync(
      join(home, 'voice.json'),
      JSON.stringify({
        ttsUrl: 'https://api.fish.audio',
        model: 's2.1-pro-free',
        apiKey: 'sk-not-a-real-key',
      }),
    )
    expect(targets.voiceConfig()).toMatchObject({
      model: 's2.1-pro-free',
      apiKey: 'sk-not-a-real-key',
    })
  })
})

// spec 07 §3.7/§5.15: the two switches, and what "both off" has to mean.
describe('pacing wiring', () => {
  const memory = new InProcessMemoryStore()

  it('wires the sensor and both features by default, anchors over the ledger', () => {
    const pacing = buildPacing(config([]), memory)!
    expect(pacing.sensor).toBeInstanceOf(IdleSensor)
    expect(pacing.scheduler).toBeInstanceOf(LedgerScheduler)
    expect(pacing).toMatchObject({ gating: true })
  })

  it('keeps the scheduler constructed under --no-anchors (the live flag gates firing)', () => {
    // spec 12 §3.2: anchors toggle hot, so the scheduler exists whenever the
    // pacing block does — the Director's fire site consults the live setting.
    expect(buildPacing(config(['--no-anchors']), memory)!.scheduler).toBeInstanceOf(LedgerScheduler)
    expect(buildPacing(config(['--no-gating']), memory)!.gating).toBe(false)
  })

  it('both off drops the block entirely — pre-spec-07 prompts AND timing', () => {
    // Not merely "no anchors": with the block gone the Director adds no
    // activity cue to the pack and never stretches the gap.
    expect(buildPacing(config(['--no-anchors', '--no-gating']), memory)).toBeUndefined()
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

// spec 12 §2.4: one store per run, seeded from the merged config (flags/env
// respected), persisting around the file's user-touched keys.
describe('settings store wiring (spec 12)', () => {
  it('starts from the merged config and persists around the touched keys', () => {
    const home = emptyHome()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ gapSeconds: 5 }))
    const store = buildSettingsStore(config(['--gap', '1'], { MURMUR_HOME: home }))
    expect(store.current().gapSeconds).toBe(1) // the flag won at boot
    store.set({ tuiPet: false })
    // ...but the file remembers the user's own 5 for the next flag-less boot.
    expect(readSettingsFile(join(home, 'settings.json'))).toEqual({ gapSeconds: 5, tuiPet: false })
  })

  it('unmuting derives the voice from the endpoint', () => {
    const home = emptyHome()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ voice: 'stub' }))
    const withEndpoint = config([], { MURMUR_HOME: home, MURMUR_TTS_URL: 'https://x' })
    expect(withEndpoint.voice).toBe('stub') // the file's mute won the boot
    const store = buildSettingsStore(withEndpoint)
    store.set({ voice: null })
    expect(store.current().voice).toBe('hosted')

    const bare = buildSettingsStore(config([], { MURMUR_HOME: emptyHome() }))
    bare.set({ voice: null })
    expect(bare.current().voice).toBe('stub') // no endpoint: silence stays honest
  })
})

// spec 12 §3.2: the music pipeline is built whenever its dependencies exist so
// the live toggle has something to enable — with the one preflight exception.
describe('music wiring decision (spec 12)', () => {
  it('follows the preflight when boot-enabled, builds optimistically when boot-disabled', () => {
    expect(musicWiringWanted(config([]), true, true)).toBe(true)
    // Boot-enabled but broken binaries: no pipeline — the pane greys the toggle.
    expect(musicWiringWanted(config([]), true, false)).toBe(false)
    // Boot-disabled: the binaries were never probed (the probe is a network
    // search); build, and let a later toggle-on degrade honestly at use.
    expect(musicWiringWanted(config(['--no-music']), true, false)).toBe(true)
    // No harness (stub brain): never.
    expect(musicWiringWanted(config(['--no-music']), false, false)).toBe(false)
    expect(musicWiringWanted(config([]), false, true)).toBe(false)
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

  it('--plain is the explicit escape, with nothing to tear down', async () => {
    const bundle = await buildHost(config(['--plain']))
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

  // spec 10 §6 (decided 2026-07-31): the TUI is the default, and a bun-less
  // machine falls back automatically — with ONE notice, not a shell lecture.
  // Installing bun is the setup conversation's job (spec 03-03 §7.1).
  it('degrades to the plain host with exactly ONE notice when Bun is absent', async () => {
    const said: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void said.push(String(m)))
    const bundle = await buildHost({
      ...config([]), // no flag at all: the default is the TUI
      tuiSocket: join(mkdtempSync(join(tmpdir(), 'murmur-front-')), 'tui.sock'),
      bunCmd: '/nope/bun',
    })
    log.mockRestore()
    expect(bundle.host).toBeInstanceOf(CliHost)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('bun')
    await bundle.close()
  })
})
