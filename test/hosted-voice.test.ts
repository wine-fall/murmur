import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildTtsPayload, HostedVoice, splitSentences } from '../src/voice/hosted-voice.ts'
import { readWav, silentWav, wavSeconds } from '../src/audio/wav.ts'

// Sentence enders written as escapes so the source stays ASCII (DESIGN §0): the
// persona speaks Chinese, where the fullwidth marks are the real enders.
const FULL_STOP = '\u3002'
const BANG = '\uff01'

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

// A fetch double that answers every TTS request with a real (silent) wav, so
// the splice/pad path runs on genuine PCM without any network.
function fakeFetch(clipSeconds = 0.05, status = 200) {
  const calls: Call[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    const wav = silentWav(clipSeconds, 16_000)
    return new Response(status === 200 ? new Uint8Array(wav) : 'upstream exploded', { status })
  }
  return { calls, impl: impl as unknown as typeof fetch }
}

describe('splitSentences', () => {
  it('splits at enders and keeps each ender run with its sentence', () => {
    expect(splitSentences(`one${FULL_STOP} two${BANG}${BANG} three`)).toEqual([
      `one${FULL_STOP}`,
      `two${BANG}${BANG}`,
      'three',
    ])
  })

  it('returns one item when there is no ender (single-sentence beats stay one-shot)', () => {
    expect(splitSentences('just a thought, nothing more')).toEqual(['just a thought, nothing more'])
  })

  it('does not split on an ASCII period (decimals and abbreviations)', () => {
    expect(splitSentences('it was 3.5 degrees in the U.S. today')).toHaveLength(1)
  })

  it('drops blank fragments', () => {
    expect(splitSentences(`  ${FULL_STOP}${FULL_STOP}  a${FULL_STOP}  `)).toEqual([
      FULL_STOP + FULL_STOP,
      `a${FULL_STOP}`,
    ])
  })
})

describe('buildTtsPayload', () => {
  it('asks for one complete normalized wav', () => {
    expect(buildTtsPayload('hi', {})).toMatchObject({
      text: 'hi',
      format: 'wav',
      streaming: false,
      normalize: true,
    })
  })

  it('omits reference_id and seed unless configured', () => {
    const bare = buildTtsPayload('hi', {})
    expect(bare).not.toHaveProperty('reference_id')
    expect(bare).not.toHaveProperty('seed')
    expect(buildTtsPayload('hi', { referenceId: 'ref-1', seed: 7 })).toMatchObject({
      reference_id: 'ref-1',
      seed: 7,
    })
  })
})

// spec 02 §3.6: the speaking rate is a request-level knob (fish.audio
// `prosody.speed`); unset sends no prosody at all, so today's requests are
// byte-identical.
describe('buildTtsPayload speed', () => {
  it('sends prosody.speed only when a speed is configured', () => {
    expect(buildTtsPayload('hi', {})).not.toHaveProperty('prosody')
    expect(buildTtsPayload('hi', { speed: 0.85 })).toMatchObject({ prosody: { speed: 0.85 } })
  })
})

describe('HostedVoice', () => {
  it('posts one fish-speech request for a single-sentence beat', async () => {
    const { calls, impl } = fakeFetch()
    const voice = new HostedVoice({
      baseUrl: 'https://tts.example/  \r\n',
      apiKey: 'k',
      model: 's2.1-pro-free',
      referenceId: 'ref-1',
      fetch: impl,
    })
    await voice.start()
    const clip = await voice.synthesize('one plain line')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://tts.example/v1/tts')
    expect(calls[0]!.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer k',
      model: 's2.1-pro-free', // hosted model selection; self-hosted omits it
      'user-agent': 'murmur', // urllib-style default UAs get 403'd by Cloudflare
    })
    expect(calls[0]!.body).toMatchObject({ text: 'one plain line', reference_id: 'ref-1' })
    expect(clip.kind).toBe('talk')
    expect(wavSeconds(await readFile(clip.source))).toBeCloseTo(0.05, 2)
    await voice.close()
  })

  it('splits a multi-sentence beat, pads the joins, and pins one voice across them', async () => {
    const { calls, impl } = fakeFetch(0.05)
    const voice = new HostedVoice({ baseUrl: 'https://tts.example', sentencePadS: 0.1, fetch: impl })
    const clip = await voice.synthesize(`first${FULL_STOP} second${FULL_STOP}`)

    expect(calls.map((c) => c.body.text)).toEqual([`first${FULL_STOP}`, `second${FULL_STOP}`])
    // Neither a reference_id nor a configured seed: one fallback seed is drawn
    // and reused, so the timbre cannot drift mid-beat (spec 02 §3.6).
    const seeds = calls.map((c) => c.body.seed)
    expect(typeof seeds[0]).toBe('number')
    expect(seeds[1]).toBe(seeds[0])
    // 2 clips + one pad between them, and only between them.
    expect(wavSeconds(await readFile(clip.source))).toBeCloseTo(0.05 * 2 + 0.1, 2)
    await voice.close()
  })

  it('carries a configured speed into every sentence of a split beat', async () => {
    const { calls, impl } = fakeFetch()
    const voice = new HostedVoice({ baseUrl: 'https://tts.example', speed: 0.85, fetch: impl })
    await voice.synthesize(`first${FULL_STOP}second${BANG}`)
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.body).toMatchObject({ prosody: { speed: 0.85 } })
    await voice.close()
  })

  it('passes a configured seed through unchanged', async () => {
    const { calls, impl } = fakeFetch()
    const voice = new HostedVoice({ baseUrl: 'u', seed: 42, sentencePadS: 0.1, fetch: impl })
    await voice.synthesize(`a${FULL_STOP} b${FULL_STOP}`)
    expect(calls.map((c) => c.body.seed)).toEqual([42, 42])
    await voice.close()
  })

  it('takes the one-shot path when the pad is disabled', async () => {
    const { calls, impl } = fakeFetch()
    const voice = new HostedVoice({ baseUrl: 'u', sentencePadS: 0, fetch: impl })
    const clip = await voice.synthesize(`a${FULL_STOP} b${FULL_STOP}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.text).toBe(`a${FULL_STOP} b${FULL_STOP}`)
    expect(readWav(await readFile(clip.source)).format.sampleRate).toBe(16_000)
    await voice.close()
  })

  it('surfaces an HTTP failure as a clear error', async () => {
    const { impl } = fakeFetch(0.05, 502)
    const voice = new HostedVoice({ baseUrl: 'https://tts.example', fetch: impl })
    await expect(voice.synthesize('hello')).rejects.toThrow(/502/)
    await voice.close()
  })

  it('removes its clip dir on close', async () => {
    const { impl } = fakeFetch()
    const voice = new HostedVoice({ baseUrl: 'u', fetch: impl })
    const clip = await voice.synthesize('hello')
    await voice.close()
    expect(existsSync(dirname(clip.source))).toBe(false)
  })
})
