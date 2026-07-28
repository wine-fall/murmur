import { describe, expect, it } from 'vitest'

import { agenticOptions, isolatedOptions, StubBrain } from '../src/brain.ts'
import type { ContextPack } from '../src/contracts.ts'
import { cleanBeats, emitTalkBeatsTool } from '../src/talk-tools.ts'

const ctx: ContextPack = { persona: 'p', recent: [] }

describe('StubBrain', () => {
  it('cycles canned beats and echoes replies', async () => {
    const brain = new StubBrain()
    const beats = await brain.nextTalks(ctx, 2)
    expect(beats).toHaveLength(2)
    expect(beats[0]!.text).not.toBe(beats[1]!.text)
    const reply = await brain.respond('hi', ctx)
    expect(reply).toContain('hi')
  })

  it('compactProfile is a no-op (offline chatter never rewrites the profile)', async () => {
    const brain = new StubBrain()
    const updated = await brain.compactProfile('who you are', [{ role: 'radio', text: 'x' }])
    expect(updated).toBe('who you are')
  })
})

// The isolation invariant (spec 01 §3.2): the radio must not be influenced by
// the user's CLAUDE.md, settings, plugins, skills, MCP servers, or hooks.
// Verified on the options object — the SDK boundary itself is smoke-tested.
describe('isolatedOptions', () => {
  it('loads nothing from the user environment and allows no tools', () => {
    const o = isolatedOptions('persona text', 'model-x')
    expect(o.systemPrompt).toBe('persona text')
    expect(o.model).toBe('model-x')
    expect(o.settingSources).toEqual([])
    expect(o.allowedTools).toEqual([])
    expect(o.tools).toEqual([])
    expect(o.mcpServers).toEqual({})
    expect(o.skills).toEqual([])
    expect(o.maxTurns).toBe(1)
    expect(o.extraArgs).toHaveProperty('disable-slash-commands')
  })
})

describe('agenticOptions', () => {
  it('keeps the isolation but allowlists exactly the murmur tools', () => {
    const server = { type: 'sdk', name: 'murmur' } as never
    const o = agenticOptions('sys', 'model-x', server, ['mcp__murmur__emit_talk_beats'], 2)
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.tools).toEqual([]) // no built-in tools (Read/Bash/...)
    expect(o.allowedTools).toEqual(['mcp__murmur__emit_talk_beats'])
    expect(o.mcpServers).toHaveProperty('murmur')
    expect(o.maxTurns).toBe(2)
    expect(o.skills).toEqual([])
  })
})

describe('emit_talk_beats tool', () => {
  it('captures cleaned beats, capped at count', async () => {
    let captured: unknown = null
    const t = emitTalkBeatsTool(2, (beats) => (captured = beats))
    const result = await t.handler(
      {
        beats: [
          { text: '  first  ', topic: ' mood ' },
          { text: 'second' },
          { text: 'third (over cap)' },
        ],
      },
      {},
    )
    expect(captured).toEqual([{ text: 'first', topic: 'mood' }, { text: 'second' }])
    expect(result.content[0]).toMatchObject({ type: 'text' })
  })

  it('does not capture when every beat is empty', async () => {
    let captured: unknown = null
    const t = emitTalkBeatsTool(2, (beats) => (captured = beats))
    await t.handler({ beats: [{ text: '   ' }] }, {})
    expect(captured).toBeNull()
  })
})

describe('cleanBeats', () => {
  it('drops empties, trims, and omits blank topics', () => {
    const beats = cleanBeats(
      [{ text: '', topic: 'x' }, { text: 'keep', topic: '  ' }, { text: 'and me' }],
      5,
    )
    expect(beats).toEqual([{ text: 'keep' }, { text: 'and me' }])
  })
})
