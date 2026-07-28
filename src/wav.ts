// PCM wav bytes in one place: the no-model silent clip (spec 01) and the hosted
// voice's sentence splicing (spec 02 §3.6) both need to read, measure, and join
// wavs. Everything here is pure Buffer work — no filesystem, no dependency.

export type WavFormat = {
  readonly channels: number
  readonly sampleRate: number
  readonly bitsPerSample: number
}

export type Wav = { readonly format: WavFormat; readonly data: Buffer }

const HEADER_BYTES = 44

function blockAlign(format: WavFormat): number {
  return format.channels * (format.bitsPerSample / 8)
}

export function encodeWav(format: WavFormat, data: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  const align = blockAlign(format)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(format.channels, 22)
  header.writeUInt32LE(format.sampleRate, 24)
  header.writeUInt32LE(format.sampleRate * align, 28) // byte rate
  header.writeUInt16LE(align, 32)
  header.writeUInt16LE(format.bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// Parse a wav a TTS server handed us — an untrusted boundary, so the chunk walk
// validates rather than assuming the canonical 44-byte layout.
//
// The declared data-chunk size is deliberately NOT trusted as an upper bound: a
// streaming server cannot know the final length up front and writes a
// placeholder, so the real payload is what is actually present (a real
// fish.audio finding — the header claimed a constant, bogus duration).
export function readWav(buf: Buffer): Wav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE wav')
  }
  let format: WavFormat | null = null
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (format === null) throw new Error('wav data chunk precedes its fmt chunk')
      return { format, data: buf.subarray(body, Math.min(body + size, buf.length)) }
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }
  throw new Error('wav has no data chunk')
}

export function wavSeconds(buf: Buffer): number {
  const { format, data } = readWav(buf)
  const align = blockAlign(format)
  if (!format.sampleRate || !align) return 0
  return Math.floor(data.length / align) / format.sampleRate
}

// Join same-format wavs with `padSeconds` of silence BETWEEN each (never at the
// edges) — the inter-sentence breath the hosted voice splices in (spec 02 §3.6).
export function concatWithSilence(wavs: Buffer[], padSeconds: number): Buffer {
  const parts = wavs.map(readWav)
  const first = parts[0]
  if (first === undefined) throw new Error('nothing to concatenate')
  for (const part of parts.slice(1)) {
    // Same voice, same model, so a mismatch means something is wrong upstream —
    // splicing it anyway would garble the audio.
    if (
      part.format.channels !== first.format.channels ||
      part.format.sampleRate !== first.format.sampleRate ||
      part.format.bitsPerSample !== first.format.bitsPerSample
    ) {
      throw new Error('cannot splice wavs whose format differs')
    }
  }
  const padFrames = Math.max(0, Math.round(first.format.sampleRate * padSeconds))
  const pad = Buffer.alloc(padFrames * blockAlign(first.format)) // zeroes = silence
  const chunks: Buffer[] = []
  for (const [i, part] of parts.entries()) {
    if (i > 0) chunks.push(pad)
    chunks.push(part.data)
  }
  return encodeWav(first.format, Buffer.concat(chunks))
}

// A silent clip for the no-model voice path (spec 01 acceptance §5).
export function silentWav(seconds: number, sampleRate: number): Buffer {
  const format: WavFormat = { channels: 1, sampleRate, bitsPerSample: 16 }
  const frames = Math.max(1, Math.round(seconds * sampleRate))
  return encodeWav(format, Buffer.alloc(frames * blockAlign(format)))
}
