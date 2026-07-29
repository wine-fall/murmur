import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { agenticOptions, GUIDE_BUILTINS, guideOptions, isolatedOptions, runGuideSession, StubBrain } from '../src/brain.ts'
import type { ContextPack, GuideRequest } from '../src/contracts.ts'
import { DEFAULT_PERSONA_PATH } from '../src/prompts.ts'
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

  it('seedPersona returns the bundled seed unchanged (offline no-op, spec 06 §2.2)', async () => {
    const brain = new StubBrain()
    const seeded = await brain.seedPersona([{ question: 'q', answer: 'a' }])
    expect(seeded).toBe(readFileSync(DEFAULT_PERSONA_PATH, 'utf-8').trim())
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

// --- guide harness (spec 03-03) ------------------------------------------- //

const guideReq = (over: Partial<GuideRequest> = {}): GuideRequest => ({
  systemPrompt: 'guide persona',
  prompt: 'fix it',
  model: 'model-x',
  maxTurns: 30,
  ...over,
})

describe('guideOptions (spec 03-03 §5.1)', () => {
  it('keeps the isolation but ENABLES the curated built-ins', () => {
    const o = guideOptions(guideReq())
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.mcpServers).toEqual({})
    expect(o.skills).toEqual([])
    expect(o.tools).toEqual([...GUIDE_BUILTINS])
    expect(GUIDE_BUILTINS).toContain('Bash')
    expect(o.maxTurns).toBe(30)
    expect(o.extraArgs).toHaveProperty('disable-slash-commands')
  })

  it('never auto-approves: allowedTools stays unset, permission flow gates each action', () => {
    // In this SDK `allowedTools` EXECUTES WITHOUT ASKING — the opposite of the
    // per-action confirm the guide is for. The surface is bounded via `tools`.
    const o = guideOptions(guideReq())
    expect(o.allowedTools).toBeUndefined()
    expect(o.permissionMode).toBe('default')
  })

  it('threads permissionMode and canUseTool through', () => {
    const canUseTool = async () => ({ behavior: 'allow' as const })
    const o = guideOptions(guideReq({ permissionMode: 'plan', canUseTool }))
    expect(o.permissionMode).toBe('plan')
    expect(o.canUseTool).toBe(canUseTool)
  })
})

// The multi-turn conversation loop over a fake SDK query: text is surfaced as
// it arrives, each turn end pulls the user's next reply, null ends the session.
// (The real-SDK seam — streaming input + canUseTool — is smoke-tested.)
describe('runGuideSession', () => {
  const assistant = (text: string): SDKAssistantMessage =>
    ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as SDKAssistantMessage
  const result = (): SDKResultMessage => ({ type: 'result', subtype: 'success' }) as SDKResultMessage

  // A fake query: for each user message received, plays back one scripted turn
  // (assistant texts, then the turn's result).
  function fakeQuery(turns: string[][], received: string[]) {
    return ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage> }) => {
      async function* stream() {
        if (typeof prompt === 'string') throw new Error('guide must use streaming input')
        let i = 0
        for await (const message of prompt) {
          received.push(String(message.message.content))
          for (const text of turns[i] ?? []) yield assistant(text)
          yield result()
          i++
        }
      }
      return stream()
    }
  }

  it('single-shot without nextUserInput: one turn, text streamed and returned', async () => {
    const received: string[] = []
    const streamed: string[] = []
    const final = await runGuideSession(
      fakeQuery([['diagnosed.', 'fixed.']], received),
      guideReq({ onText: (t) => void streamed.push(t) }),
    )
    expect(received).toEqual(['fix it'])
    expect(streamed).toEqual(['diagnosed.', 'fixed.'])
    expect(final).toBe('diagnosed.\nfixed.')
  })

  it('multi-turn: each turn end pulls the next reply; null ends the conversation', async () => {
    const received: string[] = []
    const replies = ['do the quick fix', null]
    const final = await runGuideSession(
      fakeQuery([['options: A or B?'], ['done.']], received),
      guideReq({ nextUserInput: async () => replies.shift() ?? null }),
    )
    expect(received).toEqual(['fix it', 'do the quick fix'])
    expect(final).toBe('options: A or B?\ndone.')
  })
})

describe('the shipped path never bypasses permissions (spec 03-03 §5.4)', () => {
  it('grep-guard: bypassPermissions appears nowhere in src/', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => join(e.parentPath, e.name))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toContain('bypassPermissions')
    }
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

  it('carries the invite mark through, and only when set (spec 07 §2.6)', () => {
    expect(cleanBeats([{ text: 'a', invite: true }, { text: 'b', invite: false }], 5)).toEqual([
      { text: 'a', invite: true },
      { text: 'b' },
    ])
    // A model that ignores the field simply produces a normal beat.
    expect(cleanBeats([{ text: 'a' }], 5)).toEqual([{ text: 'a' }])
  })
})
