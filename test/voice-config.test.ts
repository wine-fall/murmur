import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { voiceConfigPath } from '../src/paths.ts'
import {
  readVoiceConfig,
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
      aborted: () => stopped,
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
      aborted: () => stopped,
    })
    const reply = await call(tool, { ttsUrl: 'https://tts.example' })
    expect(reply.ok).toBe(false)
    expect(readVoiceConfig(join(dir, 'voice.json'))).toBeNull()
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
