// HostedVoice — off-machine TTS over HTTP (spec 02 §3.6), the only voice backend
// murmur ships (issue #54: local MLX voices are dropped, not ported).
//
// It sits on the same VoiceProvider seam as the stub: no local model, no
// subprocess, so start() is a formality and close() only reaps the clip dir.
// Wire protocol is fish-speech's native POST /v1/tts with a JSON body, which
// covers both a self-hosted fish-speech server and hosted fish.audio (selected
// by the `model` header).
//
// Sentence pacing: fish runs one sentence straight into the next with too small
// a gap and reads as "AI"; its own [pause] hints proved inert on s2.1-pro-free.
// So a multi-sentence beat is synthesized per sentence and spliced with real
// silence between (spec 02 §3.6). A single sentence — or a zero pad — takes the
// plain one-shot path.

import { randomInt } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debuglog } from 'node:util'

import type { AudioClip, VoiceProvider } from './contracts.ts'
import { concatWithSilence, wavSeconds } from './wav.ts'

// Diagnostics, opt-in via NODE_DEBUG=murmur — the TS tree has no log file yet
// (that arrives with the Phase 5 toolchain), and synth timing is what makes
// "is TTS keeping up?" answerable (rtf > 1 = slower than real time).
const debug = debuglog('murmur')

// Sentence enders, as escapes to keep the source ASCII (DESIGN §0): U+3002
// ideographic full stop, U+FF01 fullwidth !, U+FF1F fullwidth ?, U+2026
// ellipsis, plus ASCII ! and ?. ASCII '.' is deliberately excluded — it
// collides with decimals (3.5) and abbreviations (U.S.), and the persona speaks
// Chinese, where the fullwidth marks are the real enders.
const ENDERS = '\u3002\uff01\uff1f\u2026!?'
const SENTENCE_RE = new RegExp(`[^${ENDERS}]*[${ENDERS}]+|[^${ENDERS}]+`, 'g')

const DEFAULT_SENTENCE_PAD_S = 0.8
const DEFAULT_TIMEOUT_MS = 120_000
// A named UA: a Cloudflare-fronted fish-speech deployment 403s the default
// library user-agents with a bot rule; any non-bot UA passes.
const USER_AGENT = 'murmur'

// Split at enders; each ender run stays with its sentence, trailing text without
// an ender is its own sentence, blanks are dropped. One item back means the
// caller does a single plain synth.
export function splitSentences(text: string): string[] {
  return (text.match(SENTENCE_RE) ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
}

// The fish-speech /v1/tts body: one complete, normalized wav. `referenceId`
// picks a server-side saved voice; `seed` pins the sampled timbre (fish-speech
// has no preset voices, so without either, every call is a new voice). The
// sampling values mirror fish-speech's own client. `speed` is the speaking
// rate (1.0 = as the reference reads); unset sends no prosody at all, so the
// provider's own pacing is untouched.
export function buildTtsPayload(
  text: string,
  {
    referenceId,
    seed,
    speed,
  }: { referenceId?: string | undefined; seed?: number | undefined; speed?: number | undefined },
): Record<string, unknown> {
  return {
    text,
    format: 'wav',
    streaming: false, // whole clip, not chunked (spec 02 §3.4)
    normalize: true,
    chunk_length: 200,
    max_new_tokens: 1024,
    top_p: 0.8,
    repetition_penalty: 1.1,
    temperature: 0.8,
    ...(referenceId !== undefined && { reference_id: referenceId }),
    ...(seed !== undefined && { seed }),
    ...(speed !== undefined && { prosody: { speed, volume: 0 } }),
  }
}

// The optional knobs accept an explicit `undefined` (exactOptionalPropertyTypes)
// so a caller can spread config fields straight in without pre-filtering.
export type HostedVoiceOptions = {
  baseUrl: string
  referenceId?: string | undefined
  apiKey?: string | undefined
  seed?: number | undefined
  speed?: number | undefined
  model?: string | undefined
  sentencePadS?: number | undefined
  timeoutMs?: number | undefined
  // Injected in tests so the unit layer never touches the network.
  fetch?: typeof fetch | undefined
}

export class HostedVoice implements VoiceProvider {
  private url: string
  private opts: HostedVoiceOptions
  private padS: number
  private fetch: typeof fetch
  private dir: string | null = null
  private counter = 0

  constructor(opts: HostedVoiceOptions) {
    // Trim first: a .env value with trailing whitespace/CRLF would otherwise
    // survive into the host and corrupt the URL.
    this.url = `${opts.baseUrl.trim().replace(/\/+$/, '')}/v1/tts`
    this.opts = opts
    this.padS = opts.sentencePadS ?? DEFAULT_SENTENCE_PAD_S
    this.fetch = opts.fetch ?? fetch
  }

  // The remote is already warm. No health probe is faked — the fish server has
  // no guaranteed one, and a bad URL surfaces clearly on the first synthesize.
  async start(): Promise<void> {
    debug('voice.hosted url=%s model=%s', this.url, this.opts.model ?? '(default)')
  }

  async synthesize(text: string): Promise<AudioClip> {
    const sentences = splitSentences(text)
    const started = performance.now()
    const audio =
      sentences.length <= 1 || this.padS <= 0
        ? await this.post(text, this.opts.seed)
        : concatWithSilence(await this.postAll(sentences), this.padS)
    const genS = (performance.now() - started) / 1000

    const dir = (this.dir ??= await mkdtemp(join(tmpdir(), 'murmur-hosted-')))
    const path = join(dir, `clip-${String(++this.counter).padStart(4, '0')}.wav`)
    await writeFile(path, audio)
    const audioS = wavSeconds(audio)
    debug(
      'synth chars=%d parts=%d gen_s=%s audio_s=%s rtf=%s',
      text.length,
      Math.max(1, sentences.length),
      genS.toFixed(2),
      audioS.toFixed(2),
      audioS > 0 ? (genS / audioS).toFixed(2) : 'n/a',
    )
    return { source: path, kind: 'talk' }
  }

  async close(): Promise<void> {
    if (this.dir === null) return
    await rm(this.dir, { recursive: true, force: true }).catch(() => {})
    this.dir = null
  }

  // One voice across a split beat: a reference_id (or a configured seed) already
  // pins the timbre across calls, so pass the seed through. ONLY when neither is
  // set does each raw call sample a fresh voice — then draw one fallback seed so
  // a split beat cannot change voice mid-beat (spec 02 §3.6 voice pinning).
  private async postAll(sentences: string[]): Promise<Buffer[]> {
    const seed =
      this.opts.seed ??
      (this.opts.referenceId === undefined ? randomInt(0, 2 ** 31 - 1) : undefined)
    const parts: Buffer[] = []
    for (const sentence of sentences) parts.push(await this.post(sentence, seed))
    return parts
  }

  private async post(text: string, seed?: number): Promise<Buffer> {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        ...(this.opts.apiKey !== undefined && { authorization: `Bearer ${this.opts.apiKey}` }),
        // e.g. fish.audio 's2.1-pro-free'; self-hosted fish-speech ignores it.
        ...(this.opts.model !== undefined && { model: this.opts.model }),
      },
      body: JSON.stringify(
        buildTtsPayload(text, { referenceId: this.opts.referenceId, seed, speed: this.opts.speed }),
      ),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`TTS request failed (${response.status}): ${detail}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }
}
