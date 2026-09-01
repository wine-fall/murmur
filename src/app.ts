// Application wiring (spec 01 §3.1 + 03-02 §2.4): construct the components,
// run the startup checks, wire the seams, run the loop as a single foreground
// process, shut down cleanly. The engine is the sole audio authority — the
// interim subprocess player is gone.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

import { AudioContext } from 'node-web-audio-api'

import { IdleSensor, osIdleProbe } from './activity.ts'
import {
  CachedBedSource,
  DEFAULT_MANIFEST,
  defaultBedCacheDir,
  initialBedPosition,
  pullBed,
  readBedPosition,
  writeBedPosition,
  ytdlpDownload,
} from './bed.ts'
import { ClaudeBrain, StubBrain } from './brain.ts'
import { LiveCadence, PacingCadence } from './cadence.ts'
import { Compactor } from './compaction.ts'
import { packageVersion, type Config } from './config.ts'
import type { Harness, MemoryStore, VoiceProvider } from './contracts.ts'
import {
  canOpenBrowser,
  copyToClipboard,
  createIssueWithGh,
  ghReady,
  runGh,
  spawnClipboard,
} from './deliver.ts'
import { Director, openInBrowser, type MusicWiring, type PacingWiring } from './director.ts'
import { AudioEngine } from './engine.ts'
import { ffmpegDecode, MIX_RATE, probeDurationS, probeStream } from './ffmpeg.ts'
import { isFirstRun, runFirstRun, runProfileBootstrap } from './first-run.ts'
import { prepareDevLog } from './dev-log.ts'
import { CliHost, type Host } from './host.ts'
import { HostedVoice } from './hosted-voice.ts'
import { IpcHost, spawnTuiClient } from './ipc-host.ts'
import { HostedListening } from './listening-data.ts'
import { InProcessMemoryStore, PersistentMemoryStore } from './memory.ts'
import { sentinelRoot } from './paths.ts'
import { readMusicPolicy, seedMusicPolicy } from './music-policy.ts'
import { MusicProgrammer } from './music-programmer.ts'
import { startReport, type ReportDeps, type ReportSession } from './report.ts'
import { SteerResponder } from './steer-responder.ts'
import { YtDlpMusicProvider } from './music.ts'
import { detectLanguage } from './locale.ts'
import { loadPersona, personaLine } from './persona.ts'
import { lineReader, quitLatch, runSetup, setupComplete, type SetupTargets } from './guide.ts'
import { buildFindMusicInstruction } from './prompts.ts'
import { LedgerScheduler } from './scheduler.ts'
import { readSettingsFile, SETTINGS_FILE, SettingsStore } from './settings.ts'
import {
  armSentinel,
  collectCrashed,
  crashDescription,
  offerCrashReport,
  readCrashWindow,
  uncleanExitNotice,
} from './sentinel.ts'
import { preflightBun, preflightFfmpeg, preflightYtdlp } from './startup.ts'
import { VizFeed } from './viz.ts'
import { readVoiceConfig, type VoiceConfig, VOICE_CONFIG_FILE } from './voice-config.ts'
import { StubVoice } from './voice.ts'

// The memory store for a run (spec 05 §3.7): a real (claude) run persists to
// memoryDir; a stub run stays in-process so canned chatter never touches the
// real memory dir (stub isolation).
export function buildMemory(config: Config, log: (message: string) => void = () => {}): MemoryStore {
  if (config.brain === 'claude') return new PersistentMemoryStore({ dir: config.memoryDir, log })
  return new InProcessMemoryStore()
}

// Where the persona lives for this run (spec 05 §3.2): homed in the memory dir
// on a persistent run, the bundled seed directly on a stub run (no memory-dir
// writes). Pure — what actually LANDS at that home is the first-run flow's call
// (spec 06 §2.1: the onboarding seed, or the bundled seed when it is declined),
// and after that murmur never writes the file again.
export function resolvePersonaPath(config: Config, persistent: boolean): string {
  return persistent ? join(config.memoryDir, 'persona.md') : config.personaPath
}

// The front-end seam (spec 10 §2.1): the core never constructs a concrete host.
// `close` tears down whatever the choice brought with it — nothing at all for
// the plain host, the socket and the client process for the TUI.
export type HostBundle = { host: Host; close: () => Promise<void> }

// A packaged install (`npm i -g murmur-radio`) ships tui/ sources with no
// node_modules — and the global node_modules ancestor disables bun's
// auto-install, so the client would die resolving @opentui. Fill the gap once,
// here, right before the first TUI launch; a dev checkout (`make dev` ran
// `bun install`) is a no-op. A failure (offline, read-only global dir) reports
// false so buildHost can fall back to plain — and clears whatever the aborted
// install half-wrote, so the next boot retries instead of trusting the stub.
export function ensureTuiDeps(bunCmd: string, tuiDir: string): boolean {
  if (existsSync(join(tuiDir, 'node_modules'))) return true
  const run = spawnSync(bunCmd, ['install', '--silent'], { cwd: tuiDir, stdio: 'ignore' })
  if (run.status === 0) return true
  rmSync(join(tuiDir, 'node_modules'), { recursive: true, force: true })
  return false
}

// The dev log's one assembly point: config decided the path (src/dev-log.ts),
// here the directory is made and the aged-out days swept, and a host is only
// ever handed the path. Idempotent, so every entry point can open it.
function openDevLog(config: Config): string {
  prepareDevLog(config.devLog)
  return config.devLog
}

export async function buildHost(config: Config): Promise<HostBundle> {
  const plain = (): HostBundle => ({
    host: new CliHost(process.stdin, { devLog: openDevLog(config) }),
    close: () => Promise.resolve(),
  })
  if (config.frontEnd === 'plain') return plain()

  // Bun absent = the TUI is not offered at all (spec 10 §5.10): a half-started
  // front-end is worse than the plain one, and the radio still has to run. ONE
  // notice, not a wall of shell instructions — the setup conversation that
  // follows is where bun actually gets installed (spec 03-03 §7.1).
  const bun = await preflightBun(config.bunCmd)
  if (!bun.ok) {
    const bundle = plain()
    bundle.host.info('the terminal interface needs bun; using the plain one for now.')
    return bundle
  }

  if (!ensureTuiDeps(config.bunCmd, config.tuiDir)) {
    const bundle = plain()
    bundle.host.info('could not fetch the terminal interface packages; using the plain one for now.')
    return bundle
  }

  const host = new IpcHost({
    socketPath: config.tuiSocket,
    identity: { brain: config.brain, voice: config.voice },
    devLog: openDevLog(config),
  })
  await host.listen()
  const client = spawnTuiClient({
    bunCmd: config.bunCmd,
    entry: join(config.tuiDir, 'src', 'main.tsx'),
    socketPath: config.tuiSocket,
    onGone: (reason) => host.frontEndGone(reason),
  })
  return {
    host,
    close: async () => {
      await host.close()
      // The client exits on `bye`; this is the backstop against an orphan.
      client.kill()
    },
  }
}

// The visualizer feed (spec 10 §3.6): frames flow only while a front-end is
// attached AND subscribed, and the analyser tap is opened by that first
// subscription rather than here — a plain or unwatched run pays nothing
// (§5.5/§5.9). A vanished front-end unsubscribes itself (src/ipc-host.ts).
function attachVizFeed(host: IpcHost, engine: AudioEngine): VizFeed {
  const feed = new VizFeed({ tap: () => engine.spectrum(), send: (bins) => host.sendViz(bins) })
  host.setVizSubscriber((on, fps) => feed.set(on, fps))
  return feed
}

export function buildVoice(config: Config, notify: (message: string) => void = () => {}): VoiceProvider {
  switch (config.voice) {
    case 'stub':
      return new StubVoice()
    case 'hosted':
      // An unconfigured endpoint degrades the session, it does not end it
      // (spec 03-03 §7.1 point 4): the lines still land through the Host, the
      // voice is simply silent, and the setup conversation is what fixes it.
      if (config.ttsUrl === '') {
        notify('no voice endpoint yet — you will see the lines instead of hearing them.')
        return new StubVoice()
      }
      return new HostedVoice({
        baseUrl: config.ttsUrl,
        sentencePadS: config.ttsSentencePadS,
        ...(config.ttsReferenceId !== '' && { referenceId: config.ttsReferenceId }),
        ...(config.ttsApiKey !== '' && { apiKey: config.ttsApiKey }),
        ...(config.ttsModel !== '' && { model: config.ttsModel }),
        ...(config.ttsSeed !== undefined && { seed: config.ttsSeed }),
      })
  }
}

// The one run-wide settings authority (spec 12 §2.4): seeded from the merged
// config so flags and env are respected at boot, persisting around whatever
// keys the user's own file already holds.
export function buildSettingsStore(
  resolved: Config,
  log: (message: string) => void = () => {},
): SettingsStore {
  const path = join(resolved.home, SETTINGS_FILE)
  const stored = readSettingsFile(path, log)
  return new SettingsStore({
    path,
    initial: {
      // `language` is the one knob with no flag or env surface (spec 12 §3.9),
      // so the FILE is its only source — Config cannot carry it, and seeding it
      // from `touched` alone would leave the override dead after a restart.
      ...(stored.language !== undefined && { language: stored.language }),
      anchorsEnabled: resolved.anchorsEnabled,
      musicEnabled: resolved.musicEnabled,
      cadenceMode: resolved.cadenceMode,
      musicEveryN: resolved.musicEveryN,
      gapSeconds: resolved.gapSeconds,
      recentWindow: resolved.recentWindow,
      muted: resolved.muted,
      tuiPet: resolved.tuiPet,
    },
    touched: stored,
    log,
  })
}

// Whether the music pipeline is constructed (spec 12 §3.2): whenever its
// dependencies exist, so the live toggle has something to enable. Boot-enabled
// music trusts the preflight (broken binaries = no pipeline, and the pane greys
// the toggle); boot-disabled music was never probed — the probe is a network
// search --no-music deliberately skips — so it builds optimistically and a
// later toggle-on degrades honestly at use.
export function musicWiringWanted(config: Config, hasBrain: boolean, setupMusicOk: boolean): boolean {
  return hasBrain && (config.musicEnabled ? setupMusicOk : true)
}

// Music wiring (find+pull -> cadence -> engine), or undefined when the session
// can never play music: a failed preflight or the stub brain (the harness
// behind the pick task is the real SDK). The cadence reads the live settings,
// so the pane's mix gear lands at the next boundary.
function buildMusic(
  config: Config,
  settings: SettingsStore,
  harness: Harness,
  engine: AudioEngine,
  host: Host,
): MusicWiring {
  const provider = new YtDlpMusicProvider({ binary: config.ytdlpCmd })
  // The listener's policy file, seeded once so it is discoverable and read
  // fresh per pick so an edit lands on the next song (spec 03-01 §2.3).
  if (seedMusicPolicy(config.musicPolicyPath)) host.debug?.(`music.policy seeded ${config.musicPolicyPath}`)
  // Co-listening data widens the candidate pool past the model's own memory
  // (spec 03-01 §2.3). No key configured = no tool, and discovery is exactly
  // its pre-key self.
  const listening =
    config.listeningApiKey === ''
      ? undefined
      : new HostedListening({
          apiKey: config.listeningApiKey,
          ...(config.listeningUrl !== '' && { endpoint: config.listeningUrl }),
        })
  const source = new MusicProgrammer({
    brain: harness,
    provider,
    model: config.musicModel,
    probe: (s) => probeStream(s, config.ffmpegCmd),
    instruction: () => buildFindMusicInstruction(readMusicPolicy(config.musicPolicyPath)),
    ...(listening !== undefined && { listening }),
    // Discovery stage timings land in the dev log (issue #76).
    ...(host.debug !== undefined && { debug: host.debug.bind(host) }),
  })
  const configured = new LiveCadence({
    settings: () => settings.current(),
    brain: harness,
    model: config.musicModel,
  })
  // Gating composes with the chosen cadence rather than replacing it (spec 07
  // §2.5): an empty room gets music/bed, everything else is the user's policy.
  const cadence = config.gatingEnabled ? new PacingCadence(configured) : configured
  return { source, cadence, engine }
}

// Presence wiring (spec 07). The sensor is what puts the activity cue in the
// pack and stretches the away gap, so it rides along whenever EITHER feature
// is on — but with both off, the block is dropped entirely and the Director is
// exactly its pre-spec-07 self (§5.15: not merely no anchors, but unchanged
// prompts and unchanged timing).
export function buildPacing(config: Config, memory: MemoryStore): PacingWiring | undefined {
  if (!config.anchorsEnabled && !config.gatingEnabled) return undefined
  const probe = osIdleProbe()
  return {
    sensor: new IdleSensor({ ...(probe !== undefined && { probe }) }),
    // Always constructed (spec 12 §3.2): the Director's fire site consults the
    // live anchorsEnabled, so the pane's toggle works without a restart. The
    // both-flags-off boot above stays the pre-spec-07 escape hatch — a state
    // the pane itself cannot reach (gating is not a pane knob).
    scheduler: new LedgerScheduler(memory),
    gating: config.gatingEnabled,
  }
}

// The explicit re-entry for a listener who declined the bootstrap on their
// first run (spec 06 §3.4): `murmur --bootstrap-profile` runs the same one-shot
// task standalone, no broadcast. Returns whether a profile was written.
export async function runBootstrapProfileCli(config: Config): Promise<boolean> {
  const host = new CliHost(process.stdin, { devLog: openDevLog(config) })
  if (config.brain !== 'claude') {
    host.info('the profile bootstrap needs the real brain: run again without --brain stub.')
    return false
  }
  host.info('reading your Claude Code history to build a first listener profile...')
  const memory = new PersistentMemoryStore({ dir: config.memoryDir, log: (m) => host.info(m) })
  const ok = await runProfileBootstrap({
    harness: new ClaudeBrain(config.model),
    memory,
    host,
    model: config.model,
  })
  if (!ok) host.info('nothing was written (see the dev log for why).')
  return ok
}

// What the setup conversation is allowed to look at and repair this run
// (spec 03-03 §7.1). The voice readers are thunks: the guide may write
// voice.json mid-conversation, and the recheck has to read the world again.
export function setupTargets(config: Config, over: Partial<SetupTargets> = {}): SetupTargets {
  const saved = (): VoiceConfig | null => readVoiceConfig(join(config.home, VOICE_CONFIG_FILE))
  return {
    ytdlp: config.ytdlpCmd,
    ffmpeg: config.ffmpegCmd,
    bunCmd: config.bunCmd,
    home: config.home,
    wantsMusic: config.musicEnabled,
    wantsBun: config.frontEnd === 'tui',
    // Always considered, never read off the voice knob: with no endpoint the
    // knob says 'stub', the stub engine works, no probe fails — and a new
    // listener would never be told at boot that the radio has no real voice
    // (issue #93). A configured endpoint or a recorded decline is what removes
    // it from the offer; it is an offer item, never a blocker.
    wantsVoice: true,
    // Env/flags keep precedence over the file, exactly as parseCli layered it.
    voiceUrl: () => config.ttsUrl || (saved()?.ttsUrl ?? ''),
    // The file as written, for the run to wire itself from: a hosted endpoint
    // is a key and a model header too, not a URL alone (issue #96).
    voiceConfig: saved,
    ...over,
  }
}

// The voice a run speaks with once the setup conversation has had its turn.
// An endpoint that appeared DURING this boot is one the listener just set up
// through the guide (spec 03-03 §7.2), so it is heard now rather than next
// time — that is what makes §7.3 criterion 5's "audible line" true.
//
// Two things it must never do: override a voice the listener ASKED for (an
// explicit `--voice stub` is a request for silence this run, and the endpoint
// is still saved for the next one), or touch a run that already had an
// endpoint. The result is the single source for both what plays and what the
// banner reports.
// A hosted endpoint is the whole config, not the URL: fish.audio needs the key
// and the `model` header on every call (issue #96), so the knobs travel
// together or the freshly configured voice cannot speak.
export function voiceAfterSetup(config: Config, saved: VoiceConfig | null): Config {
  if (saved === null || config.ttsUrl !== '') return config
  // The endpoint is a fact about the world, so the fresh one is always taken —
  // per knob, still behind whatever env or a flag already stated.
  const next: Config = {
    ...config,
    ttsUrl: saved.ttsUrl,
    ...(config.ttsModel === '' && saved.model !== undefined && { ttsModel: saved.model }),
    ...(config.ttsReferenceId === '' &&
      saved.referenceId !== undefined && { ttsReferenceId: saved.referenceId }),
    ...(config.ttsApiKey === '' && saved.apiKey !== undefined && { ttsApiKey: saved.apiKey }),
    ...(config.ttsSeed === undefined && saved.seed !== undefined && { ttsSeed: saved.seed }),
  }
  // WHICH provider speaks is a preference, so only a stub nobody asked for is
  // promoted — `--voice hosted` still gets the new endpoint, `--voice stub`
  // still gets silence.
  return config.voiceExplicit ? next : { ...next, voice: 'hosted' }
}

// Whether the /setup recall's outcome needs a live provider swap (spec 10
// §3.4): exactly the knobs buildVoice reads.
export function voiceChanged(a: Config, b: Config): boolean {
  return (
    a.voice !== b.voice ||
    a.ttsUrl !== b.ttsUrl ||
    a.ttsApiKey !== b.ttsApiKey ||
    a.ttsReferenceId !== b.ttsReferenceId ||
    a.ttsModel !== b.ttsModel ||
    a.ttsSeed !== b.ttsSeed
  )
}

// The explicit setup entries (spec 03-03 §7.1): `murmur --setup` walks the whole
// onboarding surface and `murmur --setup-music` just the music binaries — each a
// separate serial conversation, never woven into a first run. No broadcast.
export async function runSetupCli(config: Config, { musicOnly = false } = {}): Promise<boolean> {
  const host = new CliHost(process.stdin, { devLog: openDevLog(config) })
  if (config.brain !== 'claude') {
    host.info('the setup guide needs the real brain: run again without --brain stub.')
    return false
  }
  const targets = setupTargets(
    config,
    musicOnly ? { wantsMusic: true, wantsBun: false, wantsVoice: false } : {},
  )
  // The explicit entries run the same conversation, so they get the same
  // civilized Ctrl-C: fire the latch, let the reads decline through.
  const quit = quitLatch()
  const offSigint = escalatingSigint(host, () => quit.fire())
  let outcome
  try {
    outcome = await runSetup({
      host,
      guide: new ClaudeBrain(config.model),
      targets,
      explicit: true,
      quit,
    })
  } finally {
    offSigint()
  }
  // Complete means every piece this entry actually covered, bun included: with
  // the TUI the default front-end, an unrepaired bun is a real gap, not a note.
  const ok = setupComplete(targets, outcome)
  host.info(ok ? 'setup is complete.' : 'some pieces are still not set up.')
  return ok
}

// The one two-press Ctrl-C escalation (spec 01 §3.6, extended to the Q&A
// flows): the first press announces and runs the phase's own quiesce action —
// fire the quit latch during onboarding, ask the Director to stop during the
// broadcast — and a second press forces exit. Returns the dispose that hands
// SIGINT to the next phase.
export function escalatingSigint(host: Host, onFirst: () => void, onForce: () => void = () => {}): () => void {
  let interrupted = false
  const handler = (): void => {
    if (interrupted) {
      // The forced exit is still the listener LEAVING, not a crash: whatever
      // the phase has to put down before the process dies goes here.
      onForce()
      process.exit(1)
    }
    interrupted = true
    host.info('stopping...')
    onFirst()
  }
  process.on('SIGINT', handler)
  return () => void process.off('SIGINT', handler)
}

export async function runApp(config: Config, maxSegments?: number): Promise<void> {
  // Read before anything of this run's own reaches the log: it is the upper
  // bound of a crashed run's log window below, and every line under it belongs
  // to the run that died, not to this one.
  const bootedAt = new Date()
  // The front-end is chosen (and, for the TUI, spawned) FIRST: everything the
  // startup checks and the first run ask has to reach whoever is watching.
  const { host, close: closeFrontEnd } = await buildHost(config)
  // The crash sentinel (spec 10 §3.2-C): only a real broadcast arms one — the
  // short-lived entry points below come and go too often to tell a crash from a
  // neighbour. Read BEFORE arming, so a reused pid cannot overwrite the record
  // its predecessor left behind.
  const sentinelDir = sentinelRoot(config.home)
  // Collected — and so cleared — here, before this run arms its own: whatever
  // happens next, a lost run is raised exactly once. The offer that follows it
  // waits until the report floor exists (below); a stub run has no brain to
  // write the description with and degrades to the notice alone, said now.
  const crashed = collectCrashed(sentinelDir)
  if (config.brain !== 'claude') {
    const uncleanExit = uncleanExitNotice(crashed)
    if (uncleanExit !== null) host.info(uncleanExit)
  }
  const disarm = armSentinel(sentinelDir, config.logEvidence)
  // Disarming is deliberate, never a `finally`: a run that throws its way out
  // is exactly the crash the next boot has to notice, so only the paths that
  // END the broadcast on purpose put the sentinel down. It is idempotent, so
  // several of them may fire.
  // A real (claude) run persists memory + homes the persona in the memory dir;
  // a stub run stays fully in-process (spec 05 §3.2/§3.7).
  const persistent = config.brain === 'claude'
  // The harnessed brain drives music discovery; the stub has no harness, so a
  // stub session is talk-only by construction.
  const claude = config.brain === 'claude' ? new ClaudeBrain(config.model) : null
  const brain = claude ?? new StubBrain()
  const memory = buildMemory(config, (m) => host.info(m))
  // Off-the-loop profile compaction (spec 05 §3.6), only when persisting: a
  // dedicated cheap-tier brain folds history into profile.md.
  const compactor =
    memory instanceof PersistentMemoryStore
      ? new Compactor(memory, new ClaudeBrain(config.compactModel), (m) => host.info(m))
      : undefined

  const context = new AudioContext({ sampleRate: MIX_RATE, latencyHint: 'playback' })
  const engine = new AudioEngine({
    context,
    decode: (source, signal, startS) =>
      ffmpegDecode(source, {
        ffmpegCmd: config.ffmpegCmd,
        signal,
        ...(startS !== undefined && { startS }),
      }),
    log: (m) => host.info(m),
  })

  // Only the front-end that can draw a spectrum gets one wired up at all.
  const viz = host instanceof IpcHost ? attachVizFeed(host, engine) : undefined

  // First run (spec 06 §2.1): before the banner and the first segment — the
  // radio must not talk over the questions. Total: it always returns a loadable
  // persona path, so the radio always boots.
  // The listener can leave DURING onboarding (spec 01 §3.6 extended): a typed
  // /quit — which is also what Ctrl-C in the TUI sends — fires this latch,
  // every pending Q&A read declines instantly, and the run shuts down instead
  // of going on the air.
  const quit = quitLatch()
  // Armed from here until the Director's handler takes over, so a plain-mode
  // Ctrl-C anywhere in the pre-broadcast stretch (first-run, the setup
  // conversation, the bed pull) is a civilized exit, not a bare death.
  const offOnboardingSigint = escalatingSigint(host, () => quit.fire(), disarm)
  // The default output language, read once from the machine (spec 06 §3.2).
  // Nothing re-reads it: from here the persona names the language it speaks.
  const language = detectLanguage()
  let personaPath = resolvePersonaPath(config, persistent)
  if (memory instanceof PersistentMemoryStore && isFirstRun(config.memoryDir)) {
    personaPath = await runFirstRun({
      host,
      brain,
      memory,
      memoryDir: config.memoryDir,
      fallbackSeedPath: config.personaPath,
      model: config.model,
      language,
      quit,
      // No harness (a stub run) = slice B is never offered.
      ...(claude !== null && { harness: claude }),
    })
  }
  const persona = loadPersona(personaPath, language)

  // Conversational onboarding (spec 03-03 §7.1): AFTER the first run, and a
  // separate serial conversation from it. The deterministic probes name what is
  // missing and murmur offers — once per boot — to fix it by talking. A decline
  // is remembered on the tier-3 ledger so later boots stay quiet. The radio
  // launches either way; the gaps only decide how degraded it starts.
  // A configured endpoint the Director watched fail auth (issue #97): the
  // flag turns the endpoint back into a gap for the /setup recall's probes,
  // and a successful swap clears it.
  const voiceAuthDown = { current: false }
  const targets = setupTargets(config, { voiceFailing: () => voiceAuthDown.current })
  let setupMusicOk = false
  if (claude !== null && !quit.requested) {
    const outcome = await runSetup({
      host,
      guide: claude,
      targets,
      quit,
      ...(memory instanceof PersistentMemoryStore && { ledger: memory }),
    })
    setupMusicOk = outcome.musicOk
  }
  if (quit.requested) {
    offOnboardingSigint()
    disarm()
    host.info('stopped before the broadcast.')
    viz?.stop()
    await engine.aclose()
    await closeFrontEnd()
    return
  }
  // Resolved after the conversation, so an endpoint saved during it is heard
  // THIS boot rather than the next one — and so the banner reports the voice
  // that is actually playing, not the one the flags asked for. `let`: the
  // /setup recall re-resolves the same way and swaps the live provider.
  let resolved = voiceAfterSetup(config, targets.voiceConfig())
  // The live settings authority (spec 12 §2.4), seeded from the fully resolved
  // config: everything below reads it instead of captured scalars.
  const settings = buildSettingsStore(resolved, (m) => host.info(m))
  // The delegate is what everything holds; the provider behind it can be
  // swapped by the /setup recall without anyone noticing (spec 10 §3.4).
  let liveVoice = buildVoice(resolved, (m) => host.info(m))
  const voice: VoiceProvider = {
    start: () => liveVoice.start(),
    synthesize: (text) => liveVoice.synthesize(text),
    close: () => liveVoice.close(),
  }
  // The listener's mute is the engine's master gain (spec 12 §3.4): applied
  // from the persisted state now and on every change — the program never
  // notices, only the speakers do.
  if (settings.current().muted) engine.setMuted(true)
  settings.onChange((next) => engine.setMuted(next.muted))

  // The bed (spec 03-04): first-run pull at loading time, then local-only. Any
  // failure degrades to no bed; the radio still starts. Independent of the
  // music check — a warm cache needs no yt-dlp, so talk-only sessions keep it.
  const bedCacheDir = defaultBedCacheDir()
  if (config.bedEnabled && !quit.requested) {
    await pullBed({
      manifest: DEFAULT_MANIFEST,
      cacheDir: bedCacheDir,
      download: (ref, destBase) => ytdlpDownload(ref, destBase, config.ytdlpCmd),
      log: (m) => host.info(m),
      // A Ctrl-C during the pull stops it at the next ref boundary (the
      // in-flight download still runs out — ytdlpDownload has no abort seam).
      shouldStop: () => quit.requested,
    })
    const bed = new CachedBedSource(bedCacheDir)
    // Pick up where the last run left off (spec 03-04 resume); nothing saved
    // (or a stale/vanished position) starts a random track at a random
    // in-bounds offset, so no two fresh boots open on the same bars.
    await engine.startBed(
      bed,
      await initialBedPosition(bed.tracks(), readBedPosition(bedCacheDir), (t) => probeDurationS(t)),
    )
  }

  const music =
    musicWiringWanted(config, claude !== null, setupMusicOk) && claude !== null
      ? buildMusic(config, settings, claude, engine, host)
      : undefined
  const pacing = buildPacing(config, memory)
  // The agentic reply turn (spec 11): rides the same harness as the pick task,
  // on the main tier — the reply is the soul. A stub run has no harness, so the
  // Director keeps its tool-less respond path there by construction.
  const steer = claude !== null ? new SteerResponder({ brain: claude, model: config.model }) : undefined

  // The mid-broadcast /setup recall (spec 10 §3.4, closes issue #97's reopen
  // gap): the same conversation as boot, explicit like `make setup` (no
  // standing decline), with the outcome applied live where it can be — the
  // voice provider swaps behind the delegate; a music repair waits for the
  // wiring the next boot builds, and says so.
  let onSetupQuit: () => void = () => {}
  let onVoiceSwap: () => void = () => {}
  const setupRecall =
    claude !== null
      ? async (): Promise<void> => {
          const outcome = await runSetup({ host, guide: claude, targets, quit, explicit: true })
          const next = voiceAfterSetup(config, targets.voiceConfig())
          if (voiceChanged(resolved, next)) {
            resolved = next
            const old = liveVoice
            liveVoice = buildVoice(resolved, (m) => host.info(m))
            await liveVoice.start()
            voiceAuthDown.current = false
            // The buffered look-ahead was synthesized by the old provider,
            // whose close removes its temp clips — drop it before closing.
            onVoiceSwap()
            // A grace before the close: the clip on air may still be
            // streaming from the old provider's directory.
            // ponytail: a timer, not a refcount — clips are seconds long and
            // the leak on early exit is one temp dir the OS reaps.
            setTimeout(() => void old.close().catch(() => {}), 60_000).unref()
            host.info('the voice change is live.', 'flow')
            if (host instanceof IpcHost) {
              host.refreshIdentity({ voice: resolved.voice })
              host.sendSettings()
            }
          } else if (voiceAuthDown.current && targets.wantsVoice && outcome.voiceOk) {
            // Repaired on disk but not in this process: the endpoint knobs
            // come from the environment, which outranks the saved file.
            host.info('the endpoint settings come from your environment — update .env and restart to apply the fix.')
          }
          if (targets.wantsMusic && outcome.musicOk && music === undefined) {
            host.info('music tools are ready — they wire up on the next boot.')
          }
          // A /quit typed INTO the setup conversation was consumed by its
          // reader; hand it to the Director so leaving still works.
          if (quit.requested) onSetupQuit()
        }
      : undefined

  // $EDITOR over the terminal the plain host is already sharing with the
  // listener: the radio keeps playing to it while they read.
  const spawnEditor = (path: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const child = spawn(process.env.EDITOR ?? process.env.VISUAL ?? 'vi', [path], {
        stdio: 'inherit',
      })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
    })

  // The report floor (spec 10 §3.2-C): a feedback command opens a short
  // conversation that leaves a draft on disk. Always wired — a stub run just
  // skips the question and renders the draft from the log alone.
  const reportDeps: ReportDeps = {
    host,
    home: resolved.home,
    logs: config.logEvidence,
    facts: {
      version: packageVersion(),
      platform: `${process.platform} ${process.arch}`,
      brain: { actual: claude !== null ? 'claude' : 'stub', requested: config.brain },
      voice: { actual: resolved.voice, requested: config.voice },
      frontEnd: { actual: host instanceof IpcHost ? 'tui' : 'plain', requested: config.frontEnd },
    },
    // The machine as it is right now, not as it was at boot: a listener files a
    // report because something changed under them.
    probes: async () => [
      { name: 'bun', ...(await preflightBun(config.bunCmd)) },
      { name: 'ffmpeg', ...(await preflightFfmpeg(config.ffmpegCmd)) },
      { name: 'yt-dlp', ...(await preflightYtdlp(config.ytdlpCmd)) },
    ],
    // Only the plain host leaves the terminal free. The TUI client holds it in
    // raw mode and keeps drawing, so an editor spawned into it would fight it
    // for the screen — there, the path is the affordance.
    openEditor:
      host instanceof IpcHost
        ? (path) => {
            host.info(`open it in your editor: ${path}`)
            return Promise.resolve()
          }
        : spawnEditor,
    // The only place the real clipboard, browser and gh are wired in. Every one
    // of them is required on ReportDeps with no default, so a test cannot write
    // a clipboard or file an issue by forgetting one.
    deliver: {
      hasBrowser: () => canOpenBrowser(process.env),
      copy: (text) => copyToClipboard(text, { spawn: spawnClipboard }),
      openUrl: openInBrowser,
      ghReady: () => ghReady(runGh),
      ghCreate: (draft) => createIssueWithGh(draft, runGh),
    },
    ...(claude !== null && { guide: claude }),
    model: config.model,
  }
  const reportRecall = (kind: 'bug' | 'feature'): ReportSession => startReport(reportDeps, kind)

  // The crash sentinel's follow-up (spec 10 §3.2-C): murmur raised the lost run
  // itself, so it writes the description too — a boot later, the listener has
  // no memory of it to draw on — and the evidence is THAT run's log window, not
  // this boot's first few lines. It goes out through the same deps as a typed
  // /bug, delivery included, so both roads reach GitHub the same way.
  //
  // Pre-broadcast on purpose: the radio has not gone on the air yet, so this is
  // the one stretch where the keyboard is free and the report floor's own
  // "never stop the program" rule has nothing to stop. The listener's answer is
  // read through the same reader the onboarding flows use, so a /quit leaves.
  if (crashed.length > 0 && claude !== null && !quit.requested) {
    const found = crashed[crashed.length - 1]!
    // The dead run's own source when it recorded one; this boot's only as the
    // fallback for a sentinel written before that field existed.
    const window = readCrashWindow(found.logs ?? config.logEvidence, found, bootedAt)
    // Idempotent, and the only thing that attaches the plain host's readline:
    // a boot whose onboarding had nothing to ask has never started it, and the
    // question below would wait on a keyboard nobody is reading.
    host.start()
    await offerCrashReport({
      host,
      crashed,
      read: lineReader(host, quit),
      quit,
      startSession: () =>
        startReport(reportDeps, 'bug', { said: crashDescription(found, window), tail: window }),
    })
  }

  const director = new Director({
    persona,
    brain,
    voice,
    player: engine,
    memory,
    host,
    settings: () => settings.current(),
    // The same store, handed to the reply turn so telling murmur and pressing a
    // key in /settings are one act (spec 12 §2.6).
    settingsStore: settings,
    ...(pacing !== undefined && { pacing }),
    ...(music !== undefined && { music }),
    ...(steer !== undefined && { steer }),
    ...(compactor !== undefined && { compactor }),
    ...(setupRecall !== undefined && { setupRecall }),
    // The one production wiring of the desktop opener: the Director has no
    // default, so this is the only place a real browser can be launched from.
    openUrl: openInBrowser,
    reportRecall,
    onVoiceAuthFailure: () => (voiceAuthDown.current = true),
  })
  onSetupQuit = () => director.requestQuit()
  onVoiceSwap = () => director.invalidateTalkAhead()

  // The settings bridge (spec 12 §2.5): the pane reads and writes through the
  // engine, and every accepted change is broadcast by the store's own event.
  if (host instanceof IpcHost) {
    host.setSettings({
      snapshot: () => ({
        values: settings.current(),
        home: resolved.home,
        voiceConfigured: resolved.ttsUrl !== '',
        musicAvailable: music !== undefined,
      }),
      apply: (patch) => settings.set(patch),
    })
    settings.onChange(() => host.sendSettings())
    // The client usually attached before the bridge existed: push it the state.
    host.sendSettings()
  }

  // SIGINT handover: the Director's quiesce replaces the onboarding latch on
  // adjacent lines, so no stretch of the boot is left with the bare default.
  offOnboardingSigint()
  const offSigint = escalatingSigint(
    host,
    () => {
      director.requestQuit()
      void engine.stop()
    },
    disarm,
  )

  await voice.start()
  // How long the room was empty (spec 10 §3.7.3), for a front-end that greets
  // the absence. A stub run keeps no history, so it has none to report.
  const away = memory instanceof PersistentMemoryStore ? memory.awaySeconds() : undefined
  host.banner(personaLine(persona), {
    brain: config.brain,
    voice: resolved.voice,
    ...(away !== undefined && { away }),
  })
  try {
    // A Ctrl-C during the bed pull or voice start fired the latch with nobody
    // left to read it: honor it here instead of going on the air.
    if (!quit.requested) await director.run(maxSegments)
    // The broadcast ended on its own terms — a thrown one never reaches here,
    // and leaves its sentinel for the next boot to find.
    disarm()
  } finally {
    offSigint()
    // Frames stop before the graph they read does.
    viz?.stop()
    await engine.aclose()
    // Remember where the bed was (spec 03-04 resume) — stopBed froze it inside
    // aclose. Best-effort: an fs failure costs only next boot's continuity.
    const bedPos = engine.bedPosition()
    if (bedPos !== null) {
      try {
        writeBedPosition(bedCacheDir, { track: basename(bedPos.track), offsetS: bedPos.offsetS })
      } catch {
        // never mask the shutdown
      }
    }
    await voice.close()
    // Final compaction flush (spec 05 §3.6): fold any remaining backlog so a
    // long session's tail lands in the profile. Best-effort and time-boxed by
    // the Compactor — a fold is a model call, and Ctrl-C must not wait on one.
    try {
      await compactor?.flush()
    } catch {
      // an fs failure on apply must not mask the shutdown
    }
    host.info('stopped cleanly.')
    await closeFrontEnd()
  }
}
