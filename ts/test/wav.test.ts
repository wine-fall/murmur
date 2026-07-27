import { describe, expect, it } from 'vitest'

import { concatWithSilence, encodeWav, readWav, silentWav, wavSeconds } from '../src/wav.ts'

const FMT = { channels: 1, sampleRate: 16_000, bitsPerSample: 16 } as const

// A wav whose data chunk is preceded by an unrelated chunk (real servers emit
// LIST/INFO), so the parser must walk chunks instead of assuming offset 44.
function wavWithListChunk(data: Buffer): Buffer {
  const plain = encodeWav(FMT, data)
  const head = plain.subarray(0, 36) // RIFF header + fmt chunk
  const list = Buffer.alloc(12)
  list.write('LIST', 0)
  list.writeUInt32LE(4, 4)
  list.write('INFO', 8)
  const out = Buffer.concat([head, list, plain.subarray(36)])
  out.writeUInt32LE(out.length - 8, 4)
  return out
}

describe('readWav', () => {
  it('parses the format and the PCM payload', () => {
    const { format, data } = readWav(silentWav(0.5, 24_000))
    expect(format).toEqual({ channels: 1, sampleRate: 24_000, bitsPerSample: 16 })
    expect(data.length).toBe(12_000 * 2)
  })

  it('trusts the bytes present over an oversized declared data size', () => {
    // A streaming TTS server cannot know the final length up front, so it
    // writes a placeholder/oversized data-chunk size; trusting the header
    // yields a bogus duration (a real fish.audio finding).
    const wav = silentWav(0.1, 16_000)
    wav.writeUInt32LE(0xffff_fff0, 40)
    expect(readWav(wav).data.length).toBe(1_600 * 2)
  })

  it('walks past non-data chunks to find the payload', () => {
    const data = Buffer.from([1, 0, 2, 0])
    expect(readWav(wavWithListChunk(data)).data).toEqual(data)
  })

  it('rejects a buffer that is not a PCM wav', () => {
    expect(() => readWav(Buffer.from('not a wav at all'))).toThrow(/wav/i)
  })
})

describe('concatWithSilence', () => {
  it('inserts the pad between parts only, never at the edges', () => {
    const one = encodeWav(FMT, Buffer.from([1, 0]))
    const two = encodeWav(FMT, Buffer.from([2, 0]))
    const joined = readWav(concatWithSilence([one, two], 0.001)) // 16 frames of pad
    expect(joined.format).toEqual(FMT)
    expect(joined.data).toEqual(Buffer.concat([Buffer.from([1, 0]), Buffer.alloc(32), Buffer.from([2, 0])]))
  })

  it('refuses to splice parts whose formats disagree', () => {
    const a = encodeWav(FMT, Buffer.from([1, 0]))
    const b = encodeWav({ ...FMT, sampleRate: 24_000 }, Buffer.from([1, 0]))
    expect(() => concatWithSilence([a, b], 0.1)).toThrow(/format/i)
  })
})

describe('wavSeconds', () => {
  it('measures duration from the PCM actually present', () => {
    expect(wavSeconds(silentWav(0.25, 16_000))).toBeCloseTo(0.25, 5)
  })
})

describe('silentWav', () => {
  it('writes a valid 16-bit mono PCM header with zeroed samples', () => {
    const wav = silentWav(0.5, 24_000)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(24_000)
    expect(wav.length).toBe(44 + 12_000 * 2)
    expect(wav.subarray(44).every((b) => b === 0)).toBe(true)
  })
})
