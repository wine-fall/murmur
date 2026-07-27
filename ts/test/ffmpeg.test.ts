import { describe, expect, it } from 'vitest'

import { framedChunks, ffmpegDecode } from '../src/ffmpeg.ts'

async function* bytes(...chunks: Buffer[]): AsyncGenerator<Buffer> {
  for (const c of chunks) yield c
}

function f32(...values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer)
}

async function collect(stream: AsyncIterable<Float32Array>): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('framedChunks', () => {
  it('reframes arbitrary byte chunks into fixed-frame PCM chunks', async () => {
    // 2 channels x 3 frames = 6 floats = 24 bytes, delivered awkwardly split.
    const raw = f32(1, 2, 3, 4, 5, 6)
    const chunks = await collect(
      framedChunks(bytes(raw.subarray(0, 5), raw.subarray(5, 11), raw.subarray(11)), 2, 2),
    )
    expect(chunks.map((c) => Array.from(c))).toEqual([
      [1, 2, 3, 4], // one full 2-frame chunk
      [5, 6], // EOF flushes the 1-frame remainder
    ])
  })

  it('drops a trailing partial frame (a torn write at EOF)', async () => {
    const raw = f32(1, 2, 3) // 1.5 stereo frames
    const chunks = await collect(framedChunks(bytes(raw), 4, 2))
    expect(chunks.map((c) => Array.from(c))).toEqual([[1, 2]])
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(framedChunks(bytes(), 4, 2))).toEqual([])
  })
})

describe('ffmpegDecode', () => {
  it('raises when the decoder cannot be spawned', async () => {
    const stream = ffmpegDecode('anything', { ffmpegCmd: '/nonexistent/ffmpeg-binary' })
    await expect(collect(stream)).rejects.toThrow()
  })
})
