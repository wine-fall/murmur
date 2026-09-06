// Stub VoiceProvider (spec 01 acceptance §5): writes a short silent wav per
// utterance so the loop runs end-to-end with no TTS server or network. The real
// voice is HostedVoice (spec 02 §3.6); Phase 3's engine replaces playback.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AudioClip, VoiceProvider } from '../contracts.ts'
import { silentWav } from '../audio/wav.ts'

const SAMPLE_RATE = 24_000

export class StubVoice implements VoiceProvider {
  private dir: string | null = null
  private counter = 0

  async start(): Promise<void> {
    this.dir ??= await mkdtemp(join(tmpdir(), 'murmur-stub-'))
  }

  async synthesize(_text: string): Promise<AudioClip> {
    await this.start()
    const path = join(this.dir!, `clip-${String(++this.counter).padStart(4, '0')}.wav`)
    await writeFile(path, silentWav(0.3, SAMPLE_RATE))
    return { source: path, kind: 'talk' }
  }

  // Temp clips are throwaway; remove the whole dir on shutdown so no clip dir
  // outlives the provider.
  async close(): Promise<void> {
    if (this.dir === null) return
    await rm(this.dir, { recursive: true, force: true }).catch(() => {})
    this.dir = null
  }
}

