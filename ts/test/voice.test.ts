import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import { silentWav, StubVoice } from '../src/voice.ts'

describe('silentWav', () => {
  it('writes a valid 16-bit mono PCM header with zeroed samples', () => {
    const wav = silentWav(0.5, 24_000)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(24_000)
    const dataSize = wav.readUInt32LE(40)
    expect(dataSize).toBe(12_000 * 2)
    expect(wav.length).toBe(44 + dataSize)
    expect(wav.subarray(44).every((b) => b === 0)).toBe(true)
  })
})

describe('StubVoice', () => {
  it('produces a playable talk clip and cleans its dir on close', async () => {
    const voice = new StubVoice()
    await voice.start()
    const clip = await voice.synthesize('hello')
    expect(clip.kind).toBe('talk')
    expect(existsSync(clip.source)).toBe(true)
    expect(readFileSync(clip.source).toString('ascii', 0, 4)).toBe('RIFF')
    await voice.close()
    expect(existsSync(dirname(clip.source))).toBe(false)
  })
})
