import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { voiceConfigPath } from '../src/paths.ts'
import {
  createVoiceTool,
  readVoiceConfig,
  setVoiceSpeedTool,
  VOICE_PRESETS,
  resolveVoiceConfigTarget,
  type VoiceConfig,
  VOICE_PROBE_LINE,
  writeVoiceConfig,
  writeVoiceConfigTool,
} from '../src/voice-config.ts'

const home = (): string => mkdtempSync(join(tmpdir(), 'murmur-voice-'))

// The tool's reply is a single JSON text block (the cc-tools convention).
type ToolReply = { ok: boolean; error?: string; path?: string; keySaved?: boolean }
type ToolArgs = {
  ttsUrl: string
  model?: string
  referenceId?: string
  seed?: number
  needsApiKey?: boolean
}
// The raw reply text as well as the parsed payload: the secret-hygiene checks
// are about the BYTES handed back to the model, not just the parsed fields.
async function callRaw(
  tool: ReturnType<typeof writeVoiceConfigTool>,
  args: ToolArgs,
): Promise<{ reply: ToolReply; text: string }> {
  const result = await tool.handler(args, {})
  const block = result.content[0]
  if (block === undefined || block.type !== 'text') throw new Error('tool returned no text')
  return { reply: JSON.parse(block.text) as ToolReply, text: block.text }
}

async function call(
  tool: ReturnType<typeof writeVoiceConfigTool>,
  args: ToolArgs,
): Promise<ToolReply> {
  return (await callRaw(tool, args)).reply
}

describe('voice config file (spec 03-03 §7.2)', () => {
  it('lives at $MURMUR_HOME/voice.json, through the one path authority', () => {
    expect(voiceConfigPath({ MURMUR_HOME: '/tmp/mh' })).toBe('/tmp/mh/voice.json')
  })

  it('round-trips what the guide wrote', () => {
    const dir = home()
    writeVoiceConfig(join(dir, 'voice.json'), { ttsUrl: 'https://tts.example', seed: 7 })
    expect(readVoiceConfig(join(dir, 'voice.json'))).toEqual({
      ttsUrl: 'https://tts.example',
      seed: 7,
    })
  })

  // Hosted fish.audio needs three things the URL alone cannot carry: a Bearer
  // key, a `model` header, and a reference_id (issue #96). The file mirrors the
  // MURMUR_TTS_* env surface knob for knob; every added knob is optional, so a
  // self-hosted endpoint stays a one-field config.
  it('round-trips every hosted knob, and keeps them all optional', () => {
    const dir = home()
    const path = join(dir, 'voice.json')
    writeVoiceConfig(path, {
      ttsUrl: 'https://api.fish.audio',
      model: 's2.1-pro-free',
      referenceId: 'abc123',
      apiKey: 'sk-not-a-real-key',
      seed: 7,
    })
    expect(readVoiceConfig(path)).toEqual({
      ttsUrl: 'https://api.fish.audio',
      model: 's2.1-pro-free',
      referenceId: 'abc123',
      apiKey: 'sk-not-a-real-key',
      seed: 7,
    })
    writeVoiceConfig(path, { ttsUrl: 'https://tts.example' })
    expect(readVoiceConfig(path)).toEqual({ ttsUrl: 'https://tts.example' })
  })

  // The file can hold a secret now, so it is written owner-only — the cheapest
  // protection that costs nothing to back up or debug (issue #96 decision (a)).
  it('writes the file owner-only, so a stored key is not world-readable', () => {
    const dir = home()
    const path = join(dir, 'voice.json')
    writeFileSync(path, '{}', { mode: 0o644 })
    writeVoiceConfig(path, { ttsUrl: 'https://api.fish.audio', apiKey: 'sk-not-a-real-key' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('a missing file is simply no config, not an error', () => {
    expect(readVoiceConfig(join(home(), 'voice.json'))).toBeNull()
  })

  it('degrades on unreadable or schema-violating content instead of blocking boot', () => {
    // The file boundary is untrusted: hand-edited, torn, or from another
    // murmur version. A bad one costs the voice, never the radio.
    const dir = home()
    const path = join(dir, 'voice.json')
    writeFileSync(path, '{ not json')
    expect(readVoiceConfig(path)).toBeNull()
    writeFileSync(path, JSON.stringify({ seed: 3 }))
    expect(readVoiceConfig(path)).toBeNull()
    writeFileSync(path, JSON.stringify({ ttsUrl: '' }))
    expect(readVoiceConfig(path)).toBeNull()
  })
})

// The trust posture of spec 06 slice B: the write is murmur's, not the SDK's,
// precisely so the path scope is enforceable.
describe('resolveVoiceConfigTarget (realpath scoping)', () => {
  it('resolves to voice.json inside the resolved home, creating the home', () => {
    const dir = join(home(), 'nested')
    // Compared against realpath: on macOS even /var is a symlink, and the
    // resolved form is exactly what the scoping guard is measured against.
    expect(resolveVoiceConfigTarget(dir)).toBe(join(realpathSync(dir), 'voice.json'))
  })

  it('refuses when a symlink planted at voice.json would redirect the write', () => {
    const dir = home()
    const elsewhere = join(home(), 'stolen.json')
    writeFileSync(elsewhere, '{}')
    symlinkSync(elsewhere, join(dir, 'voice.json'))
    expect(resolveVoiceConfigTarget(dir)).toBeNull()
  })

  it('a symlinked home is followed to its real location, not refused', () => {
    // Relocating ~/.murmur with a symlink is a normal thing to do; what must
    // not happen is landing OUTSIDE whatever it really points at.
    const real = home()
    const link = join(home(), 'link')
    symlinkSync(real, link)
    expect(resolveVoiceConfigTarget(link)).toBe(join(realpathSync(real), 'voice.json'))
  })
})

describe('write_voice_config tool (spec 03-03 §7.2)', () => {
  it('validates by ONE real synth before writing anything', async () => {
    const dir = home()
    const spoken: string[] = []
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async (config) => void spoken.push(config.ttsUrl),
    })
    const reply = await call(tool, { ttsUrl: 'https://tts.example', seed: 4 })
    expect(reply.ok).toBe(true)
    expect(spoken).toEqual(['https://tts.example'])
    expect(readVoiceConfig(join(dir, 'voice.json'))).toEqual({
      ttsUrl: 'https://tts.example',
      seed: 4,
    })
  })

  it('a failed validation writes NOTHING and hands back the explanation', async () => {
    const dir = home()
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: () => Promise.reject(new Error('TTS request failed (401): bad key')),
    })
    const reply = await call(tool, { ttsUrl: 'https://tts.example' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('401')
    expect(readVoiceConfig(join(dir, 'voice.json'))).toBeNull()
  })

  it('refuses a redirected path without ever synthesizing', async () => {
    const dir = home()
    const elsewhere = join(home(), 'stolen.json')
    writeFileSync(elsewhere, '{}')
    symlinkSync(elsewhere, join(dir, 'voice.json'))
    let synths = 0
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async () => void synths++,
    })
    const reply = await call(tool, { ttsUrl: 'https://tts.example' })
    expect(reply.ok).toBe(false)
    expect(synths).toBe(0)
    expect(readFileSync(elsewhere, 'utf-8')).toBe('{}')
  })

  it('carries the hosted knobs through to the probe and to disk', async () => {
    const dir = home()
    const probed: VoiceConfig[] = []
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async (config) => void probed.push(config),
    })
    const reply = await call(tool, {
      ttsUrl: 'https://api.fish.audio',
      model: 's2.1-pro-free',
      referenceId: 'abc123',
    })
    expect(reply.ok).toBe(true)
    expect(probed).toEqual([
      { ttsUrl: 'https://api.fish.audio', model: 's2.1-pro-free', referenceId: 'abc123' },
    ])
    expect(readVoiceConfig(join(dir, 'voice.json'))?.model).toBe('s2.1-pro-free')
  })

  // Decision (b), issue #96: a key typed as a conversation message becomes an
  // SDK user message — it goes to the API and is kept in the local session
  // transcript. So the tool asks for it ITSELF and the model never sees it.
  it('takes no apiKey argument — the key cannot be passed through the model', () => {
    const tool = writeVoiceConfigTool({ home: home(), validate: async () => {} })
    const shape = tool.inputSchema as Record<string, unknown>
    expect(Object.keys(shape).sort()).toEqual([
      'model',
      'needsApiKey',
      'referenceId',
      'seed',
      'ttsUrl',
    ])
  })

  it('captures the key out-of-band, and it reaches the probe and disk but never the reply', async () => {
    const dir = home()
    const secret = 'sk-not-a-real-key'
    const probed: VoiceConfig[] = []
    const asked: string[] = []
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async (config) => void probed.push(config),
      promptSecret: async (label) => {
        asked.push(label)
        return secret
      },
    })
    const { reply, text } = await callRaw(tool, {
      ttsUrl: 'https://api.fish.audio',
      model: 's2.1-pro-free',
      needsApiKey: true,
    })
    expect(reply.ok).toBe(true)
    expect(reply.keySaved).toBe(true)
    expect(asked).toHaveLength(1)
    expect(probed[0]?.apiKey).toBe(secret)
    expect(readVoiceConfig(join(dir, 'voice.json'))?.apiKey).toBe(secret)
    // The bytes that go back to the model carry the fact, never the secret.
    expect(text).not.toContain(secret)
  })

  // Peer review (codex): the failure path handed the endpoint's raw error text
  // back to the model — and an endpoint that echoes the Authorization header
  // into its error body would put the key in the transcript the out-of-band
  // capture exists to keep it out of.
  it('an aborted flow neither validates nor writes — Esc mid-paste must not persist', async () => {
    // The stop latch resolves the pending secret read as ''; without the
    // aborted guard the tool would fall through to a real synth and a saved
    // voice.json AFTER the user asked to stop.
    let stopped = false
    let validated = 0
    const dir = home()
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async () => void validated++,
      promptSecret: async () => {
        stopped = true // Esc lands while the paste prompt is waiting
        return ''
      },
      armAbort: () => () => stopped,
    })
    const reply = await call(tool, { ttsUrl: 'https://tts.example', needsApiKey: true })
    expect(reply.ok).toBe(false)
    expect(validated).toBe(0)
    expect(readVoiceConfig(join(dir, 'voice.json'))).toBeNull()
  })

  it('an abort during the validating synth still writes nothing', async () => {
    let stopped = false
    const dir = home()
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async () => {
        stopped = true // Esc lands while the probe synth is in flight
      },
      armAbort: () => () => stopped,
    })
    const reply = await call(tool, { ttsUrl: 'https://tts.example' })
    expect(reply.ok).toBe(false)
    expect(readVoiceConfig(join(dir, 'voice.json'))).toBeNull()
  })

  it('the abort is armed at ENTRY: a cut noticed later still cancels this call, a spent cut does not', async () => {
    // The watch is per-invocation: an Esc that lands mid-flight cancels THIS
    // call even if the flow-level flag has since been reset by a new turn —
    // and a fresh call after the cut is not haunted by it.
    let epoch = 0
    let calls = 0
    const dir = home()
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async () => {
        if (++calls === 1) epoch++ // the Esc lands during the FIRST call's synth
      },
      armAbort: () => {
        const at = epoch
        return () => epoch > at
      },
    })
    const cut = await call(tool, { ttsUrl: 'https://tts.example' })
    expect(cut.ok).toBe(false)
    expect(readVoiceConfig(join(dir, 'voice.json'))).toBeNull()
    // No new Esc: the next call proceeds and writes.
    const clean = await call(tool, { ttsUrl: 'https://tts.example' })
    expect(clean.ok).toBe(true)
    expect(readVoiceConfig(join(dir, 'voice.json'))).not.toBeNull()
  })

  it('redacts the captured key from whatever the endpoint said back', async () => {
    const secret = 'sk-not-a-real-key'
    const tool = writeVoiceConfigTool({
      home: home(),
      validate: () => Promise.reject(new Error(`401 for authorization: Bearer ${secret}`)),
      promptSecret: async () => secret,
    })
    const { reply, text } = await callRaw(tool, {
      ttsUrl: 'https://api.fish.audio',
      needsApiKey: true,
    })
    expect(reply.ok).toBe(false)
    expect(text).not.toContain(secret)
    // Still a usable explanation, not a blank one.
    expect(reply.error).toContain('401')
  })

  it('does not ask for a key unless the model said the endpoint needs one', async () => {
    let asks = 0
    const tool = writeVoiceConfigTool({
      home: home(),
      validate: async () => {},
      promptSecret: async () => {
        asks++
        return 'sk-not-a-real-key'
      },
    })
    expect((await call(tool, { ttsUrl: 'https://self-hosted.example' })).ok).toBe(true)
    expect(asks).toBe(0)
  })

  it('treats an empty capture as no key rather than an empty credential', async () => {
    const dir = home()
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: async () => {},
      promptSecret: async () => '  ',
    })
    const reply = await call(tool, { ttsUrl: 'https://api.fish.audio', needsApiKey: true })
    expect(reply.ok).toBe(true)
    expect(reply.keySaved).toBe(false)
    expect(readVoiceConfig(join(dir, 'voice.json'))?.apiKey).toBeUndefined()
  })

  // A session with no way to reach the keyboard (a stub/non-interactive run)
  // must say so, not silently write a keyless config that then 401s forever.
  it('refuses the key path when this session cannot capture one', async () => {
    const dir = home()
    const tool = writeVoiceConfigTool({ home: dir, validate: async () => {} })
    const reply = await call(tool, { ttsUrl: 'https://api.fish.audio', needsApiKey: true })
    expect(reply.ok).toBe(false)
    expect(readVoiceConfig(join(dir, 'voice.json'))).toBeNull()
  })

  it('is named write_voice_config and probes with one short line', () => {
    const tool = writeVoiceConfigTool({ home: home(), validate: async () => {} })
    expect(tool.name).toBe('write_voice_config')
    expect(VOICE_PROBE_LINE.length).toBeGreaterThan(0)
  })

  it('creates the home when it does not exist yet (a true first run)', async () => {
    const dir = join(home(), 'fresh')
    const tool = writeVoiceConfigTool({ home: dir, validate: async () => {} })
    expect((await call(tool, { ttsUrl: 'https://tts.example' })).ok).toBe(true)
    expect(readVoiceConfig(join(dir, 'voice.json'))?.ttsUrl).toBe('https://tts.example')
  })

  it('leaves an existing config alone when the new endpoint does not validate', async () => {
    const dir = home()
    mkdirSync(dir, { recursive: true })
    writeVoiceConfig(join(dir, 'voice.json'), { ttsUrl: 'https://good.example' })
    const tool = writeVoiceConfigTool({
      home: dir,
      validate: () => Promise.reject(new Error('nope')),
    })
    await call(tool, { ttsUrl: 'https://bad.example' })
    expect(readVoiceConfig(join(dir, 'voice.json'))?.ttsUrl).toBe('https://good.example')
  })
})

// --- create_voice (cloning a timbre from the listener's own recording) ------ //

type CloneReply = { ok: boolean; error?: string; referenceId?: string; title?: string }
type CloneArgs = { audioPath?: string; title?: string; text?: string; preset?: 'male' | 'female' }

async function callClone(
  tool: ReturnType<typeof createVoiceTool>,
  args: CloneArgs,
): Promise<{ reply: CloneReply; text: string }> {
  const result = await tool.handler(args, {})
  const block = result.content[0]
  if (block === undefined || block.type !== 'text') throw new Error('tool returned no text')
  return { reply: JSON.parse(block.text) as CloneReply, text: block.text }
}

// A configured endpoint with a key, as write_voice_config would have left it.
function configured(dir: string, apiKey = 'sk-secret-value'): string {
  const path = join(dir, 'voice.json')
  writeVoiceConfig(path, { ttsUrl: 'https://api.fish.audio', model: 's2.1-pro-free', apiKey })
  return path
}

function wav(dir: string, name = 'me.wav'): string {
  const path = join(dir, name)
  writeFileSync(path, Buffer.from('RIFF....WAVEfmt '))
  return path
}

describe('create_voice tool (the guide clones a timbre for the listener)', () => {
  it('uploads the file and pins the new voice, all without the model seeing the key', async () => {
    const dir = home()
    configured(dir)
    const audio = wav(dir)
    const sent: { url: string; auth: string | null; fields: string[] }[] = []
    const tool = createVoiceTool({
      home: dir,
      fetchImpl: async (url, init) => {
        const body = init?.body as FormData
        sent.push({
          url: String(url),
          auth: new Headers(init?.headers).get('authorization'),
          fields: [...body.keys()].sort(),
        })
        return new Response(JSON.stringify({ _id: 'abc123', state: 'trained' }), { status: 201 })
      },
    })
    const { reply, text } = await callClone(tool, { audioPath: audio, title: 'my own voice' })
    expect(reply.ok).toBe(true)
    expect(reply.referenceId).toBe('abc123')
    // The endpoint's own required fields (probed against the live API).
    expect(sent[0]!.url).toBe('https://api.fish.audio/model')
    expect(sent[0]!.fields).toEqual(['title', 'train_mode', 'type', 'voices'])
    expect(sent[0]!.auth).toBe('Bearer sk-secret-value')
    // The key travels tool -> endpoint and NEVER back into the conversation.
    expect(text).not.toContain('sk-secret-value')
    // The point of the whole call: the timbre is now pinned on disk.
    expect(readVoiceConfig(join(dir, 'voice.json'))?.referenceId).toBe('abc123')
  })

  it('refuses a path that is not an audio file — a config is not a recording', async () => {
    // The model chooses this path from what the listener typed. Handed
    // voice.json or a .env it would upload the credential itself to a third
    // party, which is the one thing the out-of-band capture exists to prevent.
    const dir = home()
    const secret = configured(dir)
    let calls = 0
    const tool = createVoiceTool({
      home: dir,
      fetchImpl: async () => {
        calls++
        return new Response('{}', { status: 201 })
      },
    })
    for (const path of [secret, join(dir, '.env'), join(dir, 'notes.txt')]) {
      writeFileSync(path, 'x', { flag: 'a' })
      const { reply } = await callClone(tool, { audioPath: path, title: 'nope' })
      expect(reply.ok).toBe(false)
    }
    expect(calls).toBe(0)
  })

  it('expands a ~ path, because that is how people write where their files are', async () => {
    const dir = home()
    configured(dir)
    const audio = wav(dir, 'tilde.wav')
    let uploaded = false
    const tool = createVoiceTool({
      home: dir,
      expandPath: (path) => path.replace('~', dir),
      fetchImpl: async () => {
        uploaded = true
        return new Response(JSON.stringify({ _id: 'ok-id' }), { status: 201 })
      },
    })
    const { reply } = await callClone(tool, { audioPath: '~/tilde.wav', title: 'mine' })
    expect(audio).toContain('tilde.wav')
    expect(uploaded).toBe(true)
    expect(reply.ok).toBe(true)
  })

  it('uploads to the endpoint the RUN is using, not just the one on disk', async () => {
    // Precedence is voice.json < env < flags. A listener whose endpoint comes
    // from .env has no voice.json at all — reading only the file would tell
    // them no endpoint is configured while the radio is speaking through one.
    const dir = home()
    const seen: string[] = []
    const tool = createVoiceTool({
      home: dir,
      endpoint: () => ({ ttsUrl: 'https://from-env.example', apiKey: 'env-key' }),
      fetchImpl: async (url, init) => {
        seen.push(`${String(url)} ${new Headers(init?.headers).get('authorization') ?? ''}`)
        return new Response(JSON.stringify({ _id: 'env-id' }), { status: 201 })
      },
    })
    const { reply } = await callClone(tool, { audioPath: wav(dir), title: 'mine' })
    expect(reply.ok).toBe(true)
    expect(seen[0]).toBe('https://from-env.example/model Bearer env-key')
    // The new voice still lands in the one file murmur may write.
    expect(readVoiceConfig(join(dir, 'voice.json'))?.referenceId).toBe('env-id')
  })

  it('refuses a symlink, however audio-shaped its name is', async () => {
    // The suffix is the model's word for what the file IS; a link is someone
    // else's word. /tmp/sample.wav pointing at voice.json passes every name
    // check and uploads the credential itself — and murmur's own tools are
    // exempt from the generic secret guard, so this is the only place it can
    // be caught.
    const dir = home()
    const secret = configured(dir)
    const decoy = join(dir, 'sample.wav')
    symlinkSync(secret, decoy)
    let calls = 0
    const tool = createVoiceTool({
      home: dir,
      fetchImpl: async () => {
        calls++
        return new Response('{}', { status: 201 })
      },
    })
    const { reply } = await callClone(tool, { audioPath: decoy, title: 'nope' })
    expect(reply.ok).toBe(false)
    expect(calls).toBe(0)
  })

  it('refuses an oversize file without reading it into memory first', async () => {
    // A mistyped path at a video (or an archive) must be turned away on its
    // size, not after allocating it — a synchronous read of gigabytes freezes
    // the boot it is supposed to be repairing, Esc included.
    const dir = home()
    configured(dir)
    const big = join(dir, 'huge.wav')
    writeFileSync(big, '')
    truncateSync(big, 64 * 1024 * 1024)
    const tool = createVoiceTool({ home: dir, fetchImpl: async () => new Response('{}') })
    const { reply } = await callClone(tool, { audioPath: big, title: 'mine' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/large|size|bytes/i)
  })

  it('carries an abort signal, and pins nothing when the upload is cut', async () => {
    // Esc after the request is in flight has to reach the request itself: the
    // listener is stopping their own recording from being sent.
    const dir = home()
    configured(dir)
    let cut = false
    const seen: (AbortSignal | null | undefined)[] = []
    const tool = createVoiceTool({
      home: dir,
      armAbort: () => () => cut,
      fetchImpl: async (_url, init) => {
        seen.push(init?.signal)
        cut = true // the listener hits Esc while the upload is running
        return new Response(JSON.stringify({ _id: 'late-id' }), { status: 201 })
      },
    })
    const { reply } = await callClone(tool, { audioPath: wav(dir), title: 'mine' })
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(reply.ok).toBe(false)
    expect(readVoiceConfig(join(dir, 'voice.json'))?.referenceId).toBeUndefined()
  })

  it('says what to do first when no endpoint is configured yet', async () => {
    const dir = home()
    const audio = wav(dir)
    const tool = createVoiceTool({ home: dir, fetchImpl: async () => new Response('{}') })
    const { reply } = await callClone(tool, { audioPath: audio, title: 'mine' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/endpoint/i)
  })

  it('needs a key: a keyless endpoint cannot create a hosted voice', async () => {
    const dir = home()
    writeVoiceConfig(join(dir, 'voice.json'), { ttsUrl: 'https://self.hosted' })
    const tool = createVoiceTool({ home: dir, fetchImpl: async () => new Response('{}') })
    const { reply } = await callClone(tool, { audioPath: wav(dir), title: 'mine' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/key/i)
  })

  it('scrubs the key out of an endpoint error before it reaches the conversation', async () => {
    const dir = home()
    configured(dir, 'sk-leaky-key')
    const tool = createVoiceTool({
      home: dir,
      fetchImpl: async () =>
        new Response('bad token: sk-leaky-key', { status: 401, statusText: 'Unauthorized' }),
    })
    const { reply, text } = await callClone(tool, { audioPath: wav(dir), title: 'mine' })
    expect(reply.ok).toBe(false)
    expect(text).not.toContain('sk-leaky-key')
    expect(reply.error).toContain('401')
    // A failed upload must not repoint the voice at nothing.
    expect(readVoiceConfig(join(dir, 'voice.json'))?.referenceId).toBeUndefined()
  })

  it('carries the transcript when the listener gave one, and drops it when they did not', async () => {
    const dir = home()
    configured(dir)
    const fields: string[][] = []
    const tool = createVoiceTool({
      home: dir,
      fetchImpl: async (_url, init) => {
        fields.push([...new FormData(), ...(init!.body as FormData)].map(([k]) => k).sort())
        return new Response(JSON.stringify({ _id: 'id-1' }), { status: 201 })
      },
    })
    await callClone(tool, { audioPath: wav(dir), title: 'mine', text: 'what I said' })
    await callClone(tool, { audioPath: wav(dir), title: 'mine' })
    expect(fields[0]).toContain('texts')
    expect(fields[1]).not.toContain('texts')
  })

  it('stops on the listener\'s esc instead of uploading their recording', async () => {
    const dir = home()
    configured(dir)
    let calls = 0
    const tool = createVoiceTool({
      home: dir,
      armAbort: () => () => true,
      fetchImpl: async () => {
        calls++
        return new Response('{}', { status: 201 })
      },
    })
    const { reply } = await callClone(tool, { audioPath: wav(dir), title: 'mine' })
    expect(reply.ok).toBe(false)
    expect(calls).toBe(0)
  })
})

// --- create_voice with a bundled preset (murmur's own two timbres) ---------- //

// A fake of the two networks the preset path touches: GitHub (the clip) and
// the provider (the upload). Records what was fetched and what was uploaded.
function presetNetwork(clip: Buffer, opts: { clipStatus?: number } = {}) {
  const fetched: string[] = []
  const uploads: { title: string | null; text: string | null; bytes: number }[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('/model')) {
      const body = init?.body as FormData
      const voices = body.get('voices') as Blob
      uploads.push({
        title: body.get('title') as string | null,
        text: body.get('texts') as string | null,
        bytes: voices.size,
      })
      return new Response(JSON.stringify({ _id: 'preset-id' }), { status: 201 })
    }
    fetched.push(target)
    return new Response(new Uint8Array(clip), { status: opts.clipStatus ?? 200 })
  }
  return { fetchImpl, fetched, uploads }
}

// The real clip bytes are not in the test; the preset's pinned hash is what
// the tool checks, so the tests pin a hash of their own over the fake clip.
const CLIP = Buffer.from('ID3 fake mp3 bytes')
const CLIP_SHA = createHash('sha256').update(CLIP).digest('hex')
function withFakeHash(): () => void {
  const saved = { ...VOICE_PRESETS.male }
  VOICE_PRESETS.male.sha256 = CLIP_SHA
  return () => {
    VOICE_PRESETS.male.sha256 = saved.sha256
  }
}

describe('create_voice preset (bundled male/female timbre, fetched on demand)', () => {
  it('downloads the clip, verifies it, caches it, and uploads it under the preset title', async () => {
    const restore = withFakeHash()
    try {
      const dir = home()
      configured(dir)
      const net = presetNetwork(CLIP)
      const tool = createVoiceTool({ home: dir, fetchImpl: net.fetchImpl })
      const { reply, text } = await callClone(tool, { preset: 'male' })
      expect(reply.ok).toBe(true)
      expect(reply.referenceId).toBe('preset-id')
      expect(net.fetched).toEqual([VOICE_PRESETS.male.url])
      expect(net.uploads).toEqual([
        { title: VOICE_PRESETS.male.title, text: VOICE_PRESETS.male.text, bytes: CLIP.length },
      ])
      expect(text).not.toContain('sk-secret-value')
      expect(readVoiceConfig(join(dir, 'voice.json'))?.referenceId).toBe('preset-id')
      // Cached under the home, so the next pick (or the other preset later)
      // does not go back to GitHub.
      const cached = join(dir, 'cache', 'voices', 'male.mp3')
      expect(readFileSync(cached).equals(CLIP)).toBe(true)
    } finally {
      restore()
    }
  })

  it('serves the second call from the cache without touching GitHub', async () => {
    const restore = withFakeHash()
    try {
      const dir = home()
      configured(dir)
      const net = presetNetwork(CLIP)
      const tool = createVoiceTool({ home: dir, fetchImpl: net.fetchImpl })
      await callClone(tool, { preset: 'male' })
      await callClone(tool, { preset: 'male' })
      expect(net.fetched).toHaveLength(1)
      expect(net.uploads).toHaveLength(2)
    } finally {
      restore()
    }
  })

  it('refuses a clip whose bytes do not match the pinned hash — nothing is uploaded or cached', async () => {
    const dir = home()
    configured(dir)
    // VOICE_PRESETS.male.sha256 is the real clip's hash; the fake bytes miss it.
    const net = presetNetwork(CLIP)
    const tool = createVoiceTool({ home: dir, fetchImpl: net.fetchImpl })
    const { reply } = await callClone(tool, { preset: 'male' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/did not match/)
    expect(net.uploads).toHaveLength(0)
    expect(existsSync(join(dir, 'cache', 'voices', 'male.mp3'))).toBe(false)
  })

  it('a failed download names the URL so the guide can hand it to the listener', async () => {
    const dir = home()
    configured(dir)
    const net = presetNetwork(CLIP, { clipStatus: 404 })
    const tool = createVoiceTool({ home: dir, fetchImpl: net.fetchImpl })
    const { reply } = await callClone(tool, { preset: 'male' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain(VOICE_PRESETS.male.url)
    expect(net.uploads).toHaveLength(0)
  })

  it('a stale cached clip is re-fetched rather than uploaded', async () => {
    const restore = withFakeHash()
    try {
      const dir = home()
      configured(dir)
      const cache = join(dir, 'cache', 'voices')
      mkdirSync(cache, { recursive: true })
      writeFileSync(join(cache, 'male.mp3'), 'not the clip')
      const net = presetNetwork(CLIP)
      const tool = createVoiceTool({ home: dir, fetchImpl: net.fetchImpl })
      const { reply } = await callClone(tool, { preset: 'male' })
      expect(reply.ok).toBe(true)
      expect(net.fetched).toHaveLength(1)
      expect(net.uploads[0]!.bytes).toBe(CLIP.length)
    } finally {
      restore()
    }
  })

  it('an Esc during the download stops it: nothing cached, nothing uploaded', async () => {
    const restore = withFakeHash()
    try {
      const dir = home()
      configured(dir)
      let stopped = false
      const uploads: string[] = []
      const fetchImpl: typeof fetch = (url, init) =>
        new Promise((resolve, reject) => {
          if (String(url).endsWith('/model')) {
            uploads.push(String(url))
            resolve(new Response(JSON.stringify({ _id: 'x' }), { status: 201 }))
            return
          }
          // The download hangs until the listener cuts it.
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          stopped = true
        })
      const tool = createVoiceTool({ home: dir, fetchImpl, armAbort: () => () => stopped })
      const { reply } = await callClone(tool, { preset: 'male' })
      expect(reply.ok).toBe(false)
      expect(reply.error).toMatch(/stopped/)
      expect(uploads).toHaveLength(0)
      expect(existsSync(join(dir, 'cache', 'voices', 'male.mp3'))).toBe(false)
    } finally {
      restore()
    }
  })

  it('an unwritable cache degrades to an uncached upload, not a failure', async () => {
    const restore = withFakeHash()
    try {
      const dir = home()
      configured(dir)
      // cache/voices is a FILE, so the clip cannot be written there.
      mkdirSync(join(dir, 'cache'), { recursive: true })
      writeFileSync(join(dir, 'cache', 'voices'), 'in the way')
      const net = presetNetwork(CLIP)
      const tool = createVoiceTool({ home: dir, fetchImpl: net.fetchImpl })
      const { reply } = await callClone(tool, { preset: 'male' })
      expect(reply.ok).toBe(true)
      expect(net.uploads).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('needs either a preset or a recording, and a recording needs a title', async () => {
    const dir = home()
    configured(dir)
    const net = presetNetwork(CLIP)
    const tool = createVoiceTool({ home: dir, fetchImpl: net.fetchImpl })
    expect((await callClone(tool, {})).reply.ok).toBe(false)
    expect((await callClone(tool, { audioPath: wav(dir) })).reply.ok).toBe(false)
    expect(net.uploads).toHaveLength(0)
  })

  it('the bundled clips in the repo are the bytes the presets pin', () => {
    for (const preset of Object.values(VOICE_PRESETS)) {
      const bytes = readFileSync(join(import.meta.dirname, '..', 'voices', preset.file))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(preset.sha256)
      expect(preset.url.endsWith('/voices/' + preset.file)).toBe(true)
    }
  })
})

// spec 03-03 §7.2, the third tool: the speaking rate. Same posture as
// write_voice_config — proven by one real synth at the new rate before the
// file changes, and nothing else in the saved config is touched.
describe('set_voice_speed tool (spec 03-03 §7.2)', () => {
  type SpeedReply = { ok: boolean; error?: string; speed?: number }
  const say = async (
    tool: ReturnType<typeof setVoiceSpeedTool>,
    speed: number,
  ): Promise<SpeedReply> => {
    const result = await tool.handler({ speed }, {})
    const block = result.content[0]
    if (block === undefined || block.type !== 'text') throw new Error('tool returned no text')
    return JSON.parse(block.text) as SpeedReply
  }
  const SAVED: VoiceConfig = {
    ttsUrl: 'https://api.fish.audio',
    model: 's2.1-pro-free',
    referenceId: 'ref-1',
    apiKey: 'sk-saved',
  }

  it('validates with ONE synth at the new rate, then writes only the speed', async () => {
    const dir = home()
    writeVoiceConfig(join(dir, 'voice.json'), SAVED)
    const probed: VoiceConfig[] = []
    const written: number[] = []
    const tool = setVoiceSpeedTool({
      home: dir,
      validate: async (config) => void probed.push(config),
      onWritten: (speed) => void written.push(speed),
    })
    expect(await say(tool, 0.85)).toEqual({ ok: true, speed: 0.85 })
    expect(probed).toEqual([{ ...SAVED, speed: 0.85 }])
    expect(readVoiceConfig(join(dir, 'voice.json'))).toEqual({ ...SAVED, speed: 0.85 })
    expect(written).toEqual([0.85])
  })

  it('refuses when there is no endpoint to speak through', async () => {
    const tool = setVoiceSpeedTool({ home: home(), validate: async () => {} })
    const reply = await say(tool, 0.85)
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/endpoint/)
  })

  it('a failed synth writes nothing and explains', async () => {
    const dir = home()
    writeVoiceConfig(join(dir, 'voice.json'), SAVED)
    const tool = setVoiceSpeedTool({
      home: dir,
      validate: () => Promise.reject(new Error('TTS request failed (422): prosody')),
    })
    const reply = await say(tool, 0.85)
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('422')
    expect(readVoiceConfig(join(dir, 'voice.json'))).toEqual(SAVED)
  })

  it('bounds the rate: outside 0.5..2.0 is refused before any synth', async () => {
    const dir = home()
    writeVoiceConfig(join(dir, 'voice.json'), SAVED)
    let synths = 0
    const tool = setVoiceSpeedTool({ home: dir, validate: async () => void synths++ })
    for (const bad of [0.2, 3, Number.NaN]) expect((await say(tool, bad)).ok).toBe(false)
    expect(synths).toBe(0)
    expect(readVoiceConfig(join(dir, 'voice.json'))).toEqual(SAVED)
  })

  it('speaks through the LIVE endpoint (env over file) but writes the file', async () => {
    // A .env-configured listener has no voice.json at all: the probe has to
    // reach the endpoint the run is actually using, and the file it leaves
    // behind must be a complete config (the same shape create_voice writes).
    const dir = home()
    const probed: VoiceConfig[] = []
    const live: VoiceConfig = { ttsUrl: 'https://from-env.example', apiKey: 'env-key' }
    const tool = setVoiceSpeedTool({
      home: dir,
      endpoint: () => live,
      validate: async (config) => void probed.push(config),
    })
    expect((await say(tool, 0.9)).ok).toBe(true)
    expect(probed).toEqual([{ ...live, speed: 0.9 }])
    expect(readVoiceConfig(join(dir, 'voice.json'))).toEqual({ ...live, speed: 0.9 })
  })

  it('an abort during the validating synth writes nothing', async () => {
    const dir = home()
    writeVoiceConfig(join(dir, 'voice.json'), SAVED)
    let stopped = false
    const tool = setVoiceSpeedTool({
      home: dir,
      validate: async () => {
        stopped = true
      },
      armAbort: () => () => stopped,
    })
    expect((await say(tool, 0.85)).ok).toBe(false)
    expect(readVoiceConfig(join(dir, 'voice.json'))).toEqual(SAVED)
  })
})
