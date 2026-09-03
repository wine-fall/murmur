import { describe, expect, it } from 'vitest'

import { decodeArgs, framedChunks, ffmpegDecode, MIX_RATE, probeDurationS, probeStream } from '../src/ffmpeg.ts'

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

describe('decodeArgs', () => {
  it('seeks before the input when startS is set (input-side -ss, the fast path)', () => {
    const args = decodeArgs('song.m4a', 42.5)
    const ss = args.indexOf('-ss')
    expect(ss).toBeGreaterThanOrEqual(0)
    expect(args[ss + 1]).toBe('42.5')
    expect(ss).toBeLessThan(args.indexOf('-i'))
  })

  it('omits the seek when unset or zero', () => {
    expect(decodeArgs('song.m4a')).not.toContain('-ss')
    expect(decodeArgs('song.m4a', 0)).not.toContain('-ss')
  })

  // The output device sets the context's real rate (a 44.1 kHz Bluetooth
  // headset ignores the 48 kHz request): PCM decoded at any other rate plays
  // stretched — 48k frames on a 44.1k clock ran 8.8% slow and a semitone flat.
  it('decodes at the rate the caller names, defaulting to the mix rate', () => {
    const args = decodeArgs('song.m4a', undefined, 44_100)
    expect(args[args.indexOf('-ar') + 1]).toBe('44100')
    const dflt = decodeArgs('song.m4a')
    expect(dflt[dflt.indexOf('-ar') + 1]).toBe(String(MIX_RATE))
  })
})

describe('ffmpegDecode', () => {
  it('raises when the decoder cannot be spawned', async () => {
    const stream = ffmpegDecode('anything', { ffmpegCmd: '/nonexistent/ffmpeg-binary' })
    await expect(collect(stream)).rejects.toThrow()
  })
})

describe('probeStream', () => {
  it('kills a hung probe at the deadline and reports unplayable', async () => {
    // `yes` ignores the ffmpeg args and never exits — the stand-in for a
    // stalled stream open. Without the bound this would wedge the pick task.
    expect(await probeStream('src', 'yes', 300)).toBe(false)
  })

  it('reports false for a probe binary that cannot spawn', async () => {
    expect(await probeStream('src', '/nonexistent/ffmpeg-binary')).toBe(false)
  })
})

describe('probeDurationS', () => {
  it('is null for a probe binary that cannot spawn', async () => {
    expect(await probeDurationS('src', '/nonexistent/ffprobe-binary')).toBeNull()
  })

  it('kills a hung probe at the deadline and reports null', async () => {
    expect(await probeDurationS('src', 'yes', 300)).toBeNull()
  })

  it('is null for output that is not a positive duration', async () => {
    // `echo` prints the args, not a number — the parse must fail closed.
    expect(await probeDurationS('src', 'echo')).toBeNull()
  })
})
