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
  // Stop after this many seconds of audio (spec 14 §2.9): a chapter clip is
  // one slice of a long upload, and `startS` alone would run on to its end.
  lengthS?: number
}

// The decoder invocation, exposed for tests: `-ss` sits BEFORE `-i` (input-side
// seek — near-instant on local files) so resume never stalls the audio path.
// `rate` is the context's REAL sample rate: the output device sets it (a
// 44.1 kHz Bluetooth headset ignores the 48 kHz request) and the engine
// schedules PCM frames on that clock unresampled, so decoding at any other
// rate plays every song stretched.
// `lengthS` is the STOP: an output-side `-t` after `-i`, so the pair says
// "from here, this long" — a chapter played out of a two-hour playlist.
export function decodeArgs(
  source: string,
  startS?: number,
  rate: number = MIX_RATE,
  headers?: StreamHeaders,
  lengthS?: number,
): string[] {
  // prettier-ignore
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    ...headerArgs(headers),
    ...(startS ? ['-ss', String(startS)] : []),
    '-i', source,
    ...(lengthS ? ['-t', String(lengthS)] : []),
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
  { ffmpegCmd = 'ffmpeg', chunkFrames = CHUNK_FRAMES, signal, startS, rate, headers, lengthS }: DecodeOptions = {},
): AsyncGenerator<Float32Array> {
  if (signal?.aborted) return
  const proc = spawn(ffmpegCmd, decodeArgs(source, startS, rate, headers, lengthS), { stdio: ['ignore', 'pipe', 'pipe'] })
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

// `startS` makes the answer the length still AHEAD of the offset — what a
// segment clip will really play. ffprobe reports the container's duration
// whatever seek it is given, so the offset is subtracted here rather than
// handed to the binary; an offset at or past the end is null (no audio left),
// never a negative length the caller would read as "unknown".
export function probeDurationS(
  source: string,
  ffprobeCmd = 'ffprobe',
  timeoutMs = 15_000,
  headers?: StreamHeaders,
  startS?: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobeCmd,
      probeDurationArgs(source, headers),
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve(null)
        const seconds = Number.parseFloat(stdout.trim()) - (startS ?? 0)
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
// `startS` probes the part that will actually play: for a chapter clip the
// head of the upload proves nothing about the slice half an hour in.
export function probeArgs(source: string, headers?: StreamHeaders, startS?: number): string[] {
  // prettier-ignore
  return ['-nostdin', ...headerArgs(headers), ...(startS ? ['-ss', String(startS)] : []), '-i', source, '-t', '0.5', '-f', 'null', '-']
}

// What ffmpeg says about every input it opens, before it decodes a frame:
// `  Duration: 02:05:06.50, start: ...`. `N/A` (a live stream) is no duration.
const FFMPEG_DURATION = /^\s*Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/m

export function parseFfmpegDuration(stderr: string): number | null {
  const m = FFMPEG_DURATION.exec(stderr)
  if (m === null) return null
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

// The preview trap's length and the playability proof from ONE open of the
// stream (spec 14 §2.6, issue #164). Two opens of a slow NetEase CDN cost
// 13-15 s each and the second one lands on the probe's own ceiling often
// enough to call a live stream dead; and a container read alone is not the
// proof — metadata survives frames that will not decode. So: decode the half
// second probeStream decodes, and take the length off the same run.
// Null = no length to compare, for any reason including a stream that did not
// play. The caller reads it as "unproven" and probes properly.
export function probePlayableDurationS(
  source: string,
  ffmpegCmd = 'ffmpeg',
  timeoutMs = 15_000,
  headers?: StreamHeaders,
  startS?: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegCmd, probeArgs(source, headers, startS), { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (chunk: string) => (stderr += chunk))
    const deadline = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    deadline.unref()
    proc.on('exit', (code) => {
      clearTimeout(deadline)
      if (code !== 0) return resolve(null)
      const total = parseFfmpegDuration(stderr)
      if (total === null) return resolve(null)
      const remaining = total - (startS ?? 0)
      resolve(remaining > 0 ? remaining : null)
    })
    proc.on('error', () => {
      clearTimeout(deadline)
      resolve(null)
    })
  })
}

export function probeStream(
  source: string,
  ffmpegCmd = 'ffmpeg',
  timeoutMs = 15_000,
  headers?: StreamHeaders,
  startS?: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegCmd, probeArgs(source, headers, startS), {
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
