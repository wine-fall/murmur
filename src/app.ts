// Application wiring (spec 01 §3.1 + 03-02 §2.4): construct the components,
// run the startup checks, wire the seams, run the loop as a single foreground
// process, shut down cleanly. The engine is the sole audio authority — the
// interim subprocess player is gone.

import { join } from 'node:path'

import { AudioContext } from 'node-web-audio-api'

import { IdleSensor, osIdleProbe } from './activity.ts'
import { CachedBedSource, DEFAULT_MANIFEST, defaultBedCacheDir, pullBed, ytdlpDownload } from './bed.ts'
import { ClaudeBrain, StubBrain } from './brain.ts'
import { buildCadence, PacingCadence } from './cadence.ts'
import { Compactor } from './compaction.ts'
import type { Config } from './config.ts'
import type { Harness, MemoryStore, VoiceProvider } from './contracts.ts'
import { Director, type MusicWiring, type PacingWiring } from './director.ts'
import { AudioEngine } from './engine.ts'
import { ffmpegDecode, MIX_RATE, probeStream } from './ffmpeg.ts'
import { isFirstRun, runFirstRun, runProfileBootstrap } from './first-run.ts'
import { CliHost, type Host } from './host.ts'
import { HostedVoice } from './hosted-voice.ts'
import { IpcHost, spawnTuiClient } from './ipc-host.ts'
import { InProcessMemoryStore, PersistentMemoryStore } from './memory.ts'
import { MusicProgrammer } from './music-programmer.ts'
import { SteerResponder } from './steer-responder.ts'
import { YtDlpMusicProvider } from './music.ts'
import { loadPersona, personaLine } from './persona.ts'
import { runSetup, type SetupTargets } from './guide.ts'
import { LedgerScheduler } from './scheduler.ts'
import { preflightBun } from './startup.ts'
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

// Where the TUI client lives, resolved from the engine's own location so the
// repo can sit anywhere. It is a sibling of src/, never imported by it.
const TUI_ENTRY = join(import.meta.dirname, '..', 'tui', 'src', 'main.tsx')

export async function buildHost(config: Config): Promise<HostBundle> {
  const plain = (): HostBundle => ({ host: new CliHost(), close: () => Promise.resolve() })
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

  const host = new IpcHost({
    socketPath: config.tuiSocket,
    identity: { brain: config.brain, voice: config.voice },
  })
  await host.listen()
  const client = spawnTuiClient({
    bunCmd: config.bunCmd,
    entry: TUI_ENTRY,
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

// Music wiring (find+pull -> cadence -> engine), or undefined when the session
// is talk-only: --no-music, a failed preflight, or the stub brain (the harness
// behind the pick task is the real SDK).
function buildMusic(config: Config, harness: Harness, engine: AudioEngine, host: Host): MusicWiring {
  const provider = new YtDlpMusicProvider({ binary: config.ytdlpCmd })
  const source = new MusicProgrammer({
    brain: harness,
    provider,
    model: config.musicModel,
    probe: (s) => probeStream(s, config.ffmpegCmd),
    // Discovery stage timings land in the dev log (issue #76).
    ...(host.debug !== undefined && { debug: host.debug.bind(host) }),
  })
  const configured = buildCadence(config.cadenceMode, {
    everyN: config.musicEveryN,
    brain: harness,
    model: config.musicModel,
  })
  // Gating composes with the chosen cadence rather than replacing it (spec 07
  // §2.5): an empty room gets music/bed, everything else is the user's policy.
  const cadence = config.gatingEnabled ? new PacingCadence(configured) : configured
  return { source, cadence, engine }
}

// Presence wiring (spec 07). The sensor is what puts the activity cue in the
// pack and stretches the away gap, so it rides along whenever ANY of the three
// features is on — but with all three off, the block is dropped entirely and
// the Director is exactly its pre-spec-07 self (§5.15: not merely no anchors,
// but unchanged prompts and unchanged timing).
export function buildPacing(config: Config, memory: MemoryStore): PacingWiring | undefined {
  if (!config.anchorsEnabled && !config.invitesEnabled && !config.gatingEnabled) return undefined
  const probe = osIdleProbe()
  return {
    sensor: new IdleSensor({ ...(probe !== undefined && { probe }) }),
    ...(config.anchorsEnabled && { scheduler: new LedgerScheduler(memory) }),
    invites: config.invitesEnabled,
    gating: config.gatingEnabled,
  }
}

// The explicit re-entry for a listener who declined the bootstrap on their
// first run (spec 06 §3.4): `murmur --bootstrap-profile` runs the same one-shot
// task standalone, no broadcast. Returns whether a profile was written.
export async function runBootstrapProfileCli(config: Config): Promise<boolean> {
  const host = new CliHost()
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

// The explicit setup entries (spec 03-03 §7.1): `murmur --setup` walks the whole
// onboarding surface and `murmur --setup-music` just the music binaries — each a
// separate serial conversation, never woven into a first run. No broadcast.
export async function runSetupCli(config: Config, { musicOnly = false } = {}): Promise<boolean> {
  const host = new CliHost()
  if (config.brain !== 'claude') {
    host.info('the setup guide needs the real brain: run again without --brain stub.')
    return false
  }
  const targets = setupTargets(
    config,
    musicOnly ? { wantsMusic: true, wantsBun: false, wantsVoice: false } : {},
  )
  const outcome = await runSetup({
    host,
    guide: new ClaudeBrain(config.model),
    targets,
    explicit: true,
  })
  // Complete means every piece this entry actually covered, bun included: with
  // the TUI the default front-end, an unrepaired bun is a real gap, not a note.
  const ok =
    (!targets.wantsMusic || outcome.musicOk) &&
    (!targets.wantsBun || outcome.bunOk) &&
    (!targets.wantsVoice || outcome.voiceOk)
  host.info(ok ? 'setup is complete.' : 'some pieces are still not set up.')
  return ok
}

export async function runApp(config: Config, maxSegments?: number): Promise<void> {
  // The front-end is chosen (and, for the TUI, spawned) FIRST: everything the
  // startup checks and the first run ask has to reach whoever is watching.
  const { host, close: closeFrontEnd } = await buildHost(config)
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
    decode: (source, signal) => ffmpegDecode(source, { ffmpegCmd: config.ffmpegCmd, signal }),
    log: (m) => host.info(m),
  })

  // Only the front-end that can draw a spectrum gets one wired up at all.
  const viz = host instanceof IpcHost ? attachVizFeed(host, engine) : undefined

  // First run (spec 06 §2.1): before the banner and the first segment — the
  // radio must not talk over the questions. Total: it always returns a loadable
  // persona path, so the radio always boots.
  let personaPath = resolvePersonaPath(config, persistent)
  if (memory instanceof PersistentMemoryStore && isFirstRun(config.memoryDir)) {
    personaPath = await runFirstRun({
      host,
      brain,
      memory,
      memoryDir: config.memoryDir,
      fallbackSeedPath: config.personaPath,
      model: config.model,
      // No harness (a stub run) = slice B is never offered.
      ...(claude !== null && { harness: claude }),
    })
  }
  const persona = loadPersona(personaPath)

  // Conversational onboarding (spec 03-03 §7.1): AFTER the first run, and a
  // separate serial conversation from it. The deterministic probes name what is
  // missing and murmur offers — once per boot — to fix it by talking. A decline
  // is remembered on the tier-3 ledger so later boots stay quiet. The radio
  // launches either way; the gaps only decide how degraded it starts.
  const targets = setupTargets(config)
  let musicOk = config.musicEnabled && claude !== null
  if (claude !== null) {
    const outcome = await runSetup({
      host,
      guide: claude,
      targets,
      ...(memory instanceof PersistentMemoryStore && { ledger: memory }),
    })
    musicOk = outcome.musicOk
  }
  // Resolved after the conversation, so an endpoint saved during it is heard
  // THIS boot rather than the next one — and so the banner reports the voice
  // that is actually playing, not the one the flags asked for.
  const resolved = voiceAfterSetup(config, targets.voiceConfig())
  const voice = buildVoice(resolved, (m) => host.info(m))

  // The bed (spec 03-04): first-run pull at loading time, then local-only. Any
  // failure degrades to no bed; the radio still starts. Independent of the
  // music check — a warm cache needs no yt-dlp, so talk-only sessions keep it.
  if (config.bedEnabled) {
    const cacheDir = defaultBedCacheDir()
    await pullBed({
      manifest: DEFAULT_MANIFEST,
      cacheDir,
      download: (ref, destBase) => ytdlpDownload(ref, destBase, config.ytdlpCmd),
      log: (m) => host.info(m),
    })
    await engine.startBed(new CachedBedSource(cacheDir))
  }

  const music = musicOk && claude !== null ? buildMusic(config, claude, engine, host) : undefined
  const pacing = buildPacing(config, memory)
  // The agentic reply turn (spec 11): rides the same harness as the pick task,
  // on the main tier — the reply is the soul. A stub run has no harness, so the
  // Director keeps its tool-less respond path there by construction.
  const steer = claude !== null ? new SteerResponder({ brain: claude, model: config.model }) : undefined

  const director = new Director({
    persona,
    brain,
    voice,
    player: engine,
    memory,
    host,
    gapSeconds: config.gapSeconds,
    recentWindow: config.recentWindow,
    ...(pacing !== undefined && { pacing }),
    ...(music !== undefined && { music }),
    ...(steer !== undefined && { steer }),
    ...(compactor !== undefined && { compactor }),
  })

  // Orderly shutdown on Ctrl-C (spec 01 §3.6): first signal asks the loop to
  // stop (it cuts playback on the way out); a second forces exit.
  let interrupted = false
  const onSigint = () => {
    if (interrupted) process.exit(1)
    interrupted = true
    host.info('stopping...')
    director.requestQuit()
    void engine.stop()
  }
  process.on('SIGINT', onSigint)

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
    await director.run(maxSegments)
  } finally {
    process.off('SIGINT', onSigint)
    // Frames stop before the graph they read does.
    viz?.stop()
    await engine.aclose()
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
