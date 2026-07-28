// Application wiring (spec 01 §3.1 + 03-02 §2.4): construct the components,
// run the startup checks, wire the seams, run the loop as a single foreground
// process, shut down cleanly. The engine is the sole audio authority — the
// interim subprocess player is gone.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { AudioContext } from 'node-web-audio-api'

import { CachedBedSource, DEFAULT_MANIFEST, defaultBedCacheDir, pullBed, ytdlpDownload } from './bed.ts'
import { ClaudeBrain, StubBrain } from './brain.ts'
import { buildCadence } from './cadence.ts'
import { Compactor } from './compaction.ts'
import type { Config } from './config.ts'
import type { Harness, MemoryStore, VoiceProvider } from './contracts.ts'
import { Director, type MusicWiring } from './director.ts'
import { AudioEngine } from './engine.ts'
import { ffmpegDecode, MIX_RATE, probeStream } from './ffmpeg.ts'
import { CliHost } from './host.ts'
import { HostedVoice } from './hosted-voice.ts'
import { InProcessMemoryStore, PersistentMemoryStore } from './memory.ts'
import { MusicProgrammer } from './music-programmer.ts'
import { YtDlpMusicProvider } from './music.ts'
import { loadPersona } from './persona.ts'
import { musicSetupCheck, runMusicSetup } from './guide.ts'
import { runStartupChecks } from './startup.ts'
import { StubVoice } from './voice.ts'

// The memory store for a run (spec 05 §3.7): a real (claude) run persists to
// memoryDir; a stub run stays in-process so canned chatter never touches the
// real memory dir (stub isolation).
export function buildMemory(config: Config, log: (message: string) => void = () => {}): MemoryStore {
  if (config.brain === 'claude') return new PersistentMemoryStore({ dir: config.memoryDir, log })
  return new InProcessMemoryStore()
}

// Where to load the persona from (spec 05 §3.2). On a persistent run the
// persona is homed in the memory dir (the living asset's writable home for
// spec 06): the seed is copied there once on first run, and loaded from there
// thereafter. A stub run loads the seed directly (no memory-dir writes).
export function resolvePersonaPath(config: Config, persistent: boolean): string {
  if (!persistent) return config.personaPath
  const home = join(config.memoryDir, 'persona.md')
  if (!existsSync(home)) {
    mkdirSync(config.memoryDir, { recursive: true })
    copyFileSync(config.personaPath, home)
  }
  return home
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
  const cadence = buildCadence(config.cadenceMode, {
    everyN: config.musicEveryN,
    brain: harness,
    model: config.musicModel,
  })
  return { source, cadence, engine }
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
  const persona = loadPersona(resolvePersonaPath(config, persistent))
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

  const director = new Director({
    persona,
    brain,
    voice,
    player: engine,
    memory,
    host,
    gapSeconds: config.gapSeconds,
    recentWindow: config.recentWindow,
    talkBatch: config.talkBatch,
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
