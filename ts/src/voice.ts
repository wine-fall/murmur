// Stub VoiceProvider (spec 01 acceptance §5): writes a short silent wav per
// utterance so the loop runs end-to-end with no TTS model or network. The
// hosted voice lands in Phase 2 (spec 02); Phase 3's engine replaces playback.

import { randomUUID } from 'node:crypto'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AudioClip, VoiceProvider } from './contracts.ts'

const SAMPLE_RATE = 24_000

// A minimal 16-bit mono PCM wav of silence. Kept tiny and dependency-free;
// real synthesis never goes through this path.
export function silentWav(seconds: number, sampleRate = SAMPLE_RATE): Buffer {
  const frames = Math.max(1, Math.round(seconds * sampleRate))
  const dataSize = frames * 2 // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize) // data bytes stay zero = silence
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

export class StubVoice implements VoiceProvider {
  private dir: string | null = null

  async start(): Promise<void> {
    this.dir ??= mkdtempSync(join(tmpdir(), 'murmur-stub-'))
  }

  async synthesize(_text: string): Promise<AudioClip> {
    await this.start()
    const path = join(this.dir!, `${randomUUID()}.wav`)
    await fs.writeFile(path, silentWav(0.3))
    return { source: path, kind: 'talk' }
  }

  // Temp clips are throwaway; remove the whole dir on shutdown (spec 02 §3.x
  // hygiene — no leaked clip dirs).
  async close(): Promise<void> {
    if (this.dir === null) return
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {})
    this.dir = null
  }
}
