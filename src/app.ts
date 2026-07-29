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
import { CliHost } from './host.ts'
import { HostedVoice } from './hosted-voice.ts'
import { InProcessMemoryStore, PersistentMemoryStore } from './memory.ts'
import { MusicProgrammer } from './music-programmer.ts'
import { YtDlpMusicProvider } from './music.ts'
import { loadPersona } from './persona.ts'
import { musicSetupCheck, runMusicSetup } from './guide.ts'
import { LedgerScheduler } from './scheduler.ts'
import { runStartupChecks } from './startup.ts'
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

export function buildVoice(config: Config): VoiceProvider {
  switch (config.voice) {
    case 'stub':
      return new StubVoice()
    case 'hosted':
      // Fail here rather than on the first beat: an unconfigured endpoint is a
      // setup mistake, and the message has to name the knob to fix.
      if (config.ttsUrl === '') {
        throw new Error('the hosted voice needs an endpoint: set MURMUR_TTS_URL or pass --tts-url')
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
function buildMusic(config: Config, harness: Harness, engine: AudioEngine): MusicWiring {
  const provider = new YtDlpMusicProvider({ binary: config.ytdlpCmd })
  const source = new MusicProgrammer({
    brain: harness,
    provider,
    model: config.musicModel,
    probe: (s) => probeStream(s, config.ffmpegCmd),
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

// The explicit setup entry (spec 03-03): `murmur --setup-music` runs the
// preflight + guide directly, no broadcast. Returns whether music is usable.
export async function runMusicSetupCli(config: Config): Promise<boolean> {
  const host = new CliHost()
  if (config.brain !== 'claude') {
    host.info('the setup guide needs the real brain: run again without --brain stub.')
    return false
  }
  const ok = await runMusicSetup(host, new ClaudeBrain(config.model), {
    ytdlp: config.ytdlpCmd,
    ffmpeg: config.ffmpegCmd,
  })
  host.info(ok ? 'music is ready.' : 'music is not available yet.')
  return ok
}

export async function runApp(config: Config, maxSegments?: number): Promise<void> {
  const host = new CliHost()
  // A real (claude) run persists memory + homes the persona in the memory dir;
  // a stub run stays fully in-process (spec 05 §3.2/§3.7).
  const persistent = config.brain === 'claude'
  const voice = buildVoice(config)
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

  // Startup checks (spec 03-02 §2.4): a failed preflight OFFERS the repair
  // guide (spec 03-03's auto-trigger); a failed/declined check degrades the
  // session to talk-only; --no-music skips it entirely.
  let musicOk = false
  if (config.musicEnabled && claude !== null) {
    const results = await runStartupChecks(
      [musicSetupCheck(claude, { ytdlp: config.ytdlpCmd, ffmpeg: config.ffmpegCmd })],
      host,
    )
    musicOk = results.music === true
  }

  // First run (spec 06 §2.1): after the startup checks, before the banner and
  // the first segment — the radio must not talk over the questions. Total: it
  // always returns a loadable persona path, so the radio always boots.
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

  const music = musicOk && claude !== null ? buildMusic(config, claude, engine) : undefined
  const pacing = buildPacing(config, memory)

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
  host.banner(persona.split('\n')[0] ?? '(empty)', { brain: config.brain, voice: config.voice })
  try {
    await director.run(maxSegments)
  } finally {
    process.off('SIGINT', onSigint)
    await engine.aclose()
    await voice.close()
    // Final compaction flush (spec 05 §3.6): fold any remaining backlog so a
    // long session's tail lands in the profile. Best-effort; never blocks exit.
    try {
      await compactor?.flush()
    } catch {
      // an fs failure on apply must not mask the shutdown
    }
    host.info('stopped cleanly.')
  }
}
