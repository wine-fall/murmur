// Application wiring (spec 01 §3.1 + 03-02 §2.4): construct the components,
// run the startup checks, wire the seams, run the loop as a single foreground
// process, shut down cleanly. The engine is the sole audio authority — the
// interim subprocess player is gone.

import { AudioContext } from 'node-web-audio-api'

import { CachedBedSource, DEFAULT_MANIFEST, defaultBedCacheDir, pullBed, ytdlpDownload } from './bed.ts'
import { ClaudeBrain, StubBrain } from './brain.ts'
import { buildCadence } from './cadence.ts'
import type { Config } from './config.ts'
import type { Harness, VoiceProvider } from './contracts.ts'
import { Director, type MusicWiring } from './director.ts'
import { AudioEngine } from './engine.ts'
import { ffmpegDecode, MIX_RATE, probeStream } from './ffmpeg.ts'
import { CliHost } from './host.ts'
import { HostedVoice } from './hosted-voice.ts'
import { InProcessMemoryStore } from './memory.ts'
import { MusicProgrammer } from './music-programmer.ts'
import { YtDlpMusicProvider } from './music.ts'
import { loadPersona } from './persona.ts'
import { musicCheck, runStartupChecks } from './startup.ts'
import { StubVoice } from './voice.ts'

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

export async function runApp(config: Config, maxSegments?: number): Promise<void> {
  const persona = loadPersona(config.personaPath)
  const host = new CliHost()
  const voice = buildVoice(config)
  // The harnessed brain drives music discovery; the stub has no harness, so a
  // stub session is talk-only by construction.
  const claude = config.brain === 'claude' ? new ClaudeBrain(config.model) : null
  const brain = claude ?? new StubBrain()
  const memory = new InProcessMemoryStore()

  const context = new AudioContext({ sampleRate: MIX_RATE, latencyHint: 'playback' })
  const engine = new AudioEngine({
    context,
    decode: (source, signal) => ffmpegDecode(source, { ffmpegCmd: config.ffmpegCmd, signal }),
    log: (m) => host.info(m),
  })

  // Startup checks (spec 03-02 §2.4): a failed/declined music check degrades
  // the session to talk-only; --no-music skips it entirely.
  let musicOk = false
  if (config.musicEnabled && claude !== null) {
    const results = await runStartupChecks(
      [musicCheck({ ytdlpCmd: config.ytdlpCmd, ffmpegCmd: config.ffmpegCmd })],
      host,
    )
    musicOk = results.music === true
  }

  // The bed (spec 03-04): first-run pull at loading time, then local-only. Any
  // failure degrades to no bed; the radio still starts.
  if (config.bedEnabled && musicOk) {
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
    host.info('stopped cleanly.')
  }
}
