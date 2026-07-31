import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { voiceConfigPath } from '../src/paths.ts'
import {
  readVoiceConfig,
  resolveVoiceConfigTarget,
  VOICE_PROBE_LINE,
  writeVoiceConfig,
  writeVoiceConfigTool,
} from '../src/voice-config.ts'

const home = (): string => mkdtempSync(join(tmpdir(), 'murmur-voice-'))

// The tool's reply is a single JSON text block (the cc-tools convention).
type ToolReply = { ok: boolean; error?: string; path?: string }
async function call(
  tool: ReturnType<typeof writeVoiceConfigTool>,
  args: { ttsUrl: string; seed?: number },
): Promise<ToolReply> {
  const result = await tool.handler(args, {})
  const block = result.content[0]
  if (block === undefined || block.type !== 'text') throw new Error('tool returned no text')
  return JSON.parse(block.text) as ToolReply
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
