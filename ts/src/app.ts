// Application wiring (spec 01 §3.1): construct the components, wire the seams,
// run the loop as a single foreground process, shut down cleanly.

import { buildBrain } from './brain.ts'
import type { Config } from './config.ts'
import type { VoiceProvider } from './contracts.ts'
import { Director } from './director.ts'
import { CliHost } from './host.ts'
import { InProcessMemoryStore } from './memory.ts'
import { loadPersona } from './persona.ts'
import { SubprocessPlayer } from './player.ts'
import { StubVoice } from './voice.ts'

export function buildVoice(name: Config['voice']): VoiceProvider {
  // Phase 1 knows only the stub; Phase 2 adds the hosted provider here.
  switch (name) {
    case 'stub':
      return new StubVoice()
  }
}

export async function runApp(config: Config, maxSegments?: number): Promise<void> {
  const persona = loadPersona(config.personaPath)
  const host = new CliHost()
  const voice = buildVoice(config.voice)
  const player = new SubprocessPlayer(config.playerCmd)
  const brain = buildBrain(config.brain, config.model)
  const memory = new InProcessMemoryStore()

  const director = new Director({
    persona,
    brain,
    voice,
    player,
    memory,
    host,
    gapSeconds: config.gapSeconds,
    recentWindow: config.recentWindow,
    talkBatch: config.talkBatch,
  })

  // Orderly shutdown on Ctrl-C (spec 01 §3.6): first signal asks the loop to
  // stop (it cuts playback on the way out); a second forces exit.
  let interrupted = false
  const onSigint = () => {
    if (interrupted) process.exit(1)
    interrupted = true
    host.info('stopping...')
    director.requestQuit()
    void player.stop()
  }
  process.on('SIGINT', onSigint)

  await voice.start()
  host.banner(persona.split('\n')[0] ?? '(empty)', { brain: config.brain, voice: config.voice })
  try {
    await director.run(maxSegments)
  } finally {
    process.off('SIGINT', onSigint)
    await player.stop()
    await voice.close()
    host.info('stopped cleanly.')
  }
}
