// The ffmpeg decode boundary (spec 03-02 §3.1): ffmpeg owns network + decode +
// resample; the engine owns only graph scheduling. One binary, one format —
// everything (stream URLs, cached bed files, local fixtures) arrives as
// interleaved float32 PCM at the mix rate.

import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'

export const MIX_RATE = 48_000
export const MIX_CHANNELS = 2

// ~1s of stereo PCM per scheduled buffer segment: coarse enough that an hour of
// audio is a few thousand nodes, fine enough that the scheduling lead stays
// responsive.
export const CHUNK_FRAMES = 48_000

// The headers a resolved stream needs to be opened at all (spec 03-01 §2.2): a
// Bilibili CDN answers 403 to a request with no browser User-Agent, and yt-dlp
// prints the set it used. Every ffmpeg that opens that url sends the same ones.
export type StreamHeaders = Readonly<Record<string, string>>

// ffmpeg owns the transport: the host it dials, whether it keeps the socket,
// and what encodings it can actually decode. Passing these through would
// describe yt-dlp's request, not ffmpeg's.
const TRANSPORT_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])

// Enough for a real extractor's set (a few hundred bytes) with room for a
// cookie; past it the request is not something ffmpeg should be asked to send.
const MAX_HEADER_BYTES = 4096

// ffmpeg's contract: the User-Agent has its own option, and every other header
// rides ONE `-headers` string whose lines are CRLF-TERMINATED — a lone
// 'Key: Value' with no trailing CRLF is silently ignored. Returns [] for no
// headers, so a local talk clip keeps today's argument list byte for byte.
export function headerArgs(headers?: StreamHeaders): string[] {
  if (headers === undefined) return []
  const args: string[] = []
  let joined = ''
  for (const [name, value] of Object.entries(headers)) {
    // A value carrying its own CRLF would smuggle extra headers into the
    // request; the field comes from a subprocess, so it is checked, not trusted.
    if (/[\r\n]/.test(value) || /[^\w-]/.test(name)) continue
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) continue
    if (name.toLowerCase() === 'user-agent') {
      args.push('-user_agent', value)
      continue
    }
    const line = `${name}: ${value}\r\n`
    if (joined.length + line.length > MAX_HEADER_BYTES) continue
    joined += line
  }
  if (joined !== '') args.push('-headers', joined)
  return args
}

// Reframe a raw f32le byte stream into fixed-frame Float32Array chunks. Byte
// chunks can tear anywhere (mid-float, mid-frame); EOF flushes whole frames and
// drops a torn partial frame.
export async function* framedChunks(
  bytes: AsyncIterable<Buffer>,
  chunkFrames: number = CHUNK_FRAMES,
  channels: number = MIX_CHANNELS,
): AsyncGenerator<Float32Array> {
  const chunkBytes = chunkFrames * channels * 4
  let pending: Buffer = Buffer.alloc(0)
  for await (const piece of bytes) {
    pending = pending.length === 0 ? piece : Buffer.concat([pending, piece])
    while (pending.length >= chunkBytes) {
      yield new Float32Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + chunkBytes))
      pending = pending.subarray(chunkBytes)
    }
  }
  const wholeFrames = Math.floor(pending.length / (channels * 4))
  if (wholeFrames > 0) {
    const tail = wholeFrames * channels * 4
    yield new Float32Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + tail))
  }
}

export type DecodeOptions = {
  ffmpegCmd?: string
  chunkFrames?: number
  // Abort kills the decoder promptly (the engine's stop path) — treated as a
  // deliberate end, not a decode failure.
  signal?: AbortSignal
  // Start decoding this many seconds in (the bed resume, spec 03-04). Seeking
  // past the end yields an empty stream, which callers treat as a track miss.
  startS?: number
  // The sample rate the PCM must arrive at — the playing context's own.
  rate?: number
  // The headers the source needs to answer at all (a CDN that 403s a
  // header-less request). Absent for a local file.
  headers?: StreamHeaders
}

// The decoder invocation, exposed for tests: `-ss` sits BEFORE `-i` (input-side
// seek — near-instant on local files) so resume never stalls the audio path.
// `rate` is the context's REAL sample rate: the output device sets it (a
// 44.1 kHz Bluetooth headset ignores the 48 kHz request) and the engine
// schedules PCM frames on that clock unresampled, so decoding at any other
// rate plays every song stretched.
export function decodeArgs(
  source: string,
  startS?: number,
  rate: number = MIX_RATE,
  headers?: StreamHeaders,
): string[] {
  // prettier-ignore
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    ...headerArgs(headers),
    ...(startS ? ['-ss', String(startS)] : []),
    '-i', source,
    '-f', 'f32le', '-ar', String(rate), '-ac', String(MIX_CHANNELS),
    'pipe:1',
  ]
}

// Decode any source ffmpeg reads (stream URL, local file) into mix-format PCM
// chunks. An abnormal ffmpeg exit RAISES (with its stderr) rather than
// masquerading as a clean end — a dead stream must be visible, not silent
// (spec 03-02 robustness; the Python engine learned this from a live 403).
// Ending the iteration early (break / return) kills the decoder; no orphans.
export async function* ffmpegDecode(
  source: string,
  { ffmpegCmd = 'ffmpeg', chunkFrames = CHUNK_FRAMES, signal, startS, rate, headers }: DecodeOptions = {},
): AsyncGenerator<Float32Array> {
  if (signal?.aborted) return
  const proc = spawn(ffmpegCmd, decodeArgs(source, startS, rate, headers), { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)))
  const onAbort = () => proc.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })
  const spawnFailure = new Promise<never>((_, reject) => {
    proc.on('error', (err) => reject(new Error(`could not spawn ${ffmpegCmd}: ${err.message}`)))
  })
  spawnFailure.catch(() => {}) // surfaced via the race below; never unhandled
  let finished = false
  try {
    const stream = framedChunks(proc.stdout, chunkFrames)
    while (true) {
      const next = await Promise.race([stream.next(), spawnFailure])
      if (next.done) break
      yield next.value
    }
    finished = true
    const [code, sig] = proc.exitCode !== null ? [proc.exitCode, null] : await once(proc, 'exit')
    if (code !== 0 && signal?.aborted !== true) {
      throw new Error(`ffmpeg exited ${code ?? `on ${sig}`} for ${source}: ${stderr.trim()}`)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!finished && proc.exitCode === null) proc.kill('SIGKILL')
  }
}

// A local file's duration in seconds (the bed resume's bound check): the seek
// offset must never point past the real end. Fails closed — a missing ffprobe,
// a hung probe (killed at the deadline), or unparseable output is null, and the
// caller starts from the top instead.
// ponytail: ffprobe ships beside every ffmpeg install; a config knob for its
// path can arrive with the first user whose ffprobe lives elsewhere.
export function probeDurationArgs(source: string, headers?: StreamHeaders): string[] {
  // prettier-ignore
  return [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    ...headerArgs(headers),
    source,
  ]
}

export function probeDurationS(
  source: string,
  ffprobeCmd = 'ffprobe',
  timeoutMs = 15_000,
  headers?: StreamHeaders,
): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobeCmd,
      probeDurationArgs(source, headers),
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve(null)
        const seconds = Number.parseFloat(stdout.trim())
        resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null)
      },
    )
  })
}

// Pull-time playability probe (spec 03-01 §2.3 seam, owned here with the rest of
// the ffmpeg boundary): does the source actually decode audio? Used by
// submit_pick so a resolved-but-dead stream (an intermittent 403) is rejected
// while the model can still pick another candidate. Bounded: a probe that hangs
// (a stalled stream open) is killed and reported unplayable — it must never
// wedge the pick task that awaits it.
export function probeArgs(source: string, headers?: StreamHeaders): string[] {
  // prettier-ignore
  return ['-nostdin', ...headerArgs(headers), '-i', source, '-t', '0.5', '-f', 'null', '-']
}

export function probeStream(
  source: string,
  ffmpegCmd = 'ffmpeg',
  timeoutMs = 15_000,
  headers?: StreamHeaders,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegCmd, probeArgs(source, headers), {
      stdio: 'ignore',
    })
    const deadline = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    deadline.unref()
    proc.on('exit', (code) => {
      clearTimeout(deadline)
      resolve(code === 0)
    })
    proc.on('error', () => {
      clearTimeout(deadline)
      resolve(false)
    })
  })
}
