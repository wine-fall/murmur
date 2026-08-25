import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { agenticOptions, GUIDE_BUILTINS, guideOptions, isolatedOptions, runGuideSession, StubBrain } from '../src/brain.ts'
import type { ContextPack, GuideRequest, GuideSession } from '../src/contracts.ts'
import { renderPersona } from '../src/persona.ts'
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

  it('seedPersona returns the bundled seed, language slot filled (offline no-op, spec 06 §2.2)', async () => {
    const brain = new StubBrain()
    const seeded = await brain.seedPersona([{ question: 'q', answer: 'a' }], 'Japanese')
    expect(seeded).toBe(
      renderPersona(readFileSync(DEFAULT_PERSONA_PATH, 'utf-8').trim(), 'Japanese'),
    )
    expect(seeded).not.toContain('{{')
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

  // Issue #96: the walkthrough must read a provider's CURRENT terms rather
  // than repeat a date from training. WebFetch is how it reads them, and it is
  // strictly narrower than the Bash the guide already holds.
  it('can read a page, so it never quotes a policy from memory', () => {
    expect(GUIDE_BUILTINS).toContain('WebFetch')
  })

  it('bounds the surface via tools: allowedTools stays unset', () => {
    // `allowedTools` only pre-approves — it does not bound the surface. The
    // guide's tool surface is bounded via `tools`.
    const o = guideOptions(guideReq())
    expect(o.allowedTools).toBeUndefined()
    expect(o.permissionMode).toBe('default')
  })

  // The transcript-protection red line (spec 03-03 §7.2) must sit where EVERY
  // tool use passes: the SDK consults canUseTool only when its own policy
  // would ask, and Read / safe Bash commands never ask — a smoke proved a
  // Read of .env sails straight through the permission callback. The
  // PreToolUse hook fires unconditionally.
  describe('the secret guard hook', () => {
    const hook = (): NonNullable<ReturnType<typeof guideOptions>['hooks']> =>
      guideOptions(guideReq()).hooks ?? {}

    const fire = async (tool_name: string, tool_input: unknown) => {
      const callbacks = hook().PreToolUse?.flatMap((m) => m.hooks) ?? []
      expect(callbacks.length).toBeGreaterThan(0)
      return await callbacks[0]!(
        {
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_input,
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '/tmp/t',
          cwd: '/tmp',
        },
        't1',
        { signal: new AbortController().signal },
      )
    }

    it('denies a secret-bearing tool use before it runs, with the credential reason', async () => {
      for (const [tool, input] of [
        ['Read', { file_path: '/Users/zach/.personal/murmur/.env' }],
        ['Read', { file_path: '/Users/zach/.murmur/voice.json' }],
        ['Bash', { command: 'printenv MURMUR_TTS_API_KEY' }],
        ['Bash', { command: 'env | sort' }],
        // The review's bypass set: env-dumping builtins, indirection reads of
        // the config home, bare expansions of un-"api"-named keys.
        ['Bash', { command: 'set' }],
        ['Bash', { command: 'export -p' }],
        ['Bash', { command: 'cat /proc/self/environ' }],
        ['Bash', { command: 'cat ~/.murmur/*.json' }],
        ['Bash', { command: 'echo $FISH_AUDIO_KEY' }],
        ['Grep', { pattern: 'sk-', path: '/Users/zach/.murmur', output_mode: 'content' }],
      ] as const) {
        const out = await fire(tool, input)
        const specific = 'hookSpecificOutput' in out ? out.hookSpecificOutput : undefined
        expect(specific, JSON.stringify(input)).toMatchObject({
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        })
        if (specific?.hookEventName === 'PreToolUse') {
          expect(specific.permissionDecisionReason).toContain('credential')
        }
      }
    })

    it('passes routine tool uses through untouched', async () => {
      for (const [tool, input] of [
        ['Bash', { command: 'node --version' }],
        ['Bash', { command: 'brew install yt-dlp' }],
        ['Bash', { command: 'echo "exit: $?"' }],
        ['Bash', { command: 'ls -l $(which yt-dlp)' }],
        ['Read', { file_path: '/tmp/notes.md' }],
      ] as const) {
        const out = await fire(tool, input)
        expect(out, JSON.stringify(input)).not.toHaveProperty('hookSpecificOutput')
      }
    })

    it('does not deny the work the prompts themselves mandate (review false-positive set)', async () => {
      for (const [tool, input] of [
        // The voice walkthrough opens the provider's api-keys page by URL.
        ['Bash', { command: 'open https://fish.audio/app/api-keys' }],
        // The pip fallback path launches through /usr/bin/env — a launcher,
        // not an environment dump.
        ['Bash', { command: '/usr/bin/env python3 -m pip install -U yt-dlp' }],
        // Reading current pricing may well say "token" in the prompt.
        ['WebFetch', { url: 'https://fish.audio/pricing', prompt: 'what is the cost per token?' }],
        // A written script's shebang is not an env dump either.
        ['Write', { file_path: '/tmp/probe.sh', content: '#!/usr/bin/env bash\necho hi' }],
      ] as const) {
        const out = await fire(tool, input)
        expect(out, JSON.stringify(input)).not.toHaveProperty('hookSpecificOutput')
      }
    })

    it('exempts murmur-owned tools: write_voice_config carries needsApiKey by design', async () => {
      const out = await fire('mcp__murmur__write_voice_config', {
        ttsUrl: 'https://api.fish.audio',
        needsApiKey: true,
      })
      expect(out).not.toHaveProperty('hookSpecificOutput')
    })
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

  // A long install must not run in silence: the message loop surfaces
  // tool_use and tool_result blocks so the host hears what runs (before)
  // and what it printed (after), matched by the block's tool_use id.
  it('streams tool_use and tool_result through the activity callbacks', async () => {
    const toolUses: [string, string, string][] = []
    const toolResults: [string, boolean, string][] = []
    const query = () => {
      async function* stream() {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'upgrading now.' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'brew upgrade yt-dlp' } },
            ],
          },
        } as SDKAssistantMessage
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Upgrading yt-dlp\nDone.' }],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage
        yield { type: 'result', subtype: 'success' } as SDKResultMessage
      }
      return stream()
    }
    const final = await runGuideSession(
      query,
      guideReq({
        onToolUse: (name, detail, id) => void toolUses.push([name, detail, id]),
        onToolResult: (output, isError, id) => void toolResults.push([output, isError, id]),
      }),
    )
    expect(toolUses).toEqual([['Bash', 'brew upgrade yt-dlp', 't1']])
    expect(toolResults).toEqual([['Upgrading yt-dlp\nDone.', false, 't1']])
    expect(final).toBe('upgrading now.') // tool blocks never pollute the returned text
  })

  it('joins text-block tool results and flags errors; typed replies are not results', async () => {
    const toolResults: [string, boolean, string][] = []
    const query = () => {
      async function* stream() {
        yield {
          type: 'user',
          message: { role: 'user', content: 'a typed reply, not a tool result' },
          parent_tool_use_id: null,
        } as SDKUserMessage
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't2',
                content: [
                  { type: 'text', text: 'line one' },
                  { type: 'text', text: 'line two' },
                ],
                is_error: true,
              },
            ],
          },
          parent_tool_use_id: null,
        } as SDKUserMessage
        yield { type: 'result', subtype: 'success' } as SDKResultMessage
      }
      return stream()
    }
    await runGuideSession(
      query,
      guideReq({ onToolResult: (output, isError, id) => void toolResults.push([output, isError, id]) }),
    )
    expect(toolResults).toEqual([['line one\nline two', true, 't2']])
  })

  it('the interrupt breaks the message loop and closes the query instead of waiting out the turn', async () => {
    // A /quit mid-session must not wait for the agent to finish a compose or a
    // spinning stream: the signal wins the race against the next message, the
    // loop breaks, and breaking closes the SDK subprocess (runTask's posture).
    // The fake models the real SDK iterator: queue-backed next(), and a
    // return() that kills the subprocess.
    const queue: SDKMessage[] = [assistant('looking...'), result()]
    let returned = false
    const iterator: AsyncIterator<SDKMessage> = {
      next: () =>
        queue.length > 0
          ? Promise.resolve({ value: queue.shift()!, done: false })
          : new Promise(() => {}),
      return: () => {
        returned = true
        return Promise.resolve({ value: undefined, done: true })
      },
    }
    let fire!: () => void
    const interrupt = new Promise<void>((resolve) => (fire = resolve))
    const final = await runGuideSession(
      () => ({ [Symbol.asyncIterator]: () => iterator }),
      guideReq({
        interrupt,
        onText: () => fire(), // the quit lands right after the first text
        nextUserInput: async () => 'still here',
      }),
    )
    expect(final).toBe('looking...')
    expect(returned).toBe(true)
  })

  it('an exception inside the loop still closes the query (the for-await guarantee)', async () => {
    // The manual iterator must keep what breaking a for-await gave for free:
    // however the loop exits — done, interrupt, or a thrown handler — the SDK
    // subprocess is closed rather than left alive with no consumer.
    const queue: SDKMessage[] = [assistant('boom-fodder'), result()]
    let returned = false
    const iterator: AsyncIterator<SDKMessage> = {
      next: () =>
        queue.length > 0
          ? Promise.resolve({ value: queue.shift()!, done: false })
          : new Promise(() => {}),
      return: () => {
        returned = true
        return Promise.resolve({ value: undefined, done: true })
      },
    }
    await expect(
      runGuideSession(
        () => ({ [Symbol.asyncIterator]: () => iterator }),
        guideReq({
          onText: () => {
            throw new Error('host went away')
          },
        }),
      ),
    ).rejects.toThrow('host went away')
    expect(returned).toBe(true)
  })

  it('onSession.interruptTurn cuts the turn in flight and the conversation continues (Esc)', async () => {
    // Esc mid-turn (spec 03-03 §7 lifecycle): query.interrupt() ends only the
    // CURRENT turn — the SDK answers it with a result — and the streaming
    // input then pulls the user's next reply. The session survives; only the
    // `interrupt` promise (a /quit) closes it.
    const received: string[] = []
    let sess: GuideSession | null = null
    const replies = ['try uv instead', null]
    const query = ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage> }) => {
      if (typeof prompt === 'string') throw new Error('guide must use streaming input')
      const queue: SDKMessage[] = []
      let wake: (() => void) | null = null
      let closed = false
      const push = (m?: SDKMessage): void => {
        if (m !== undefined) queue.push(m)
        wake?.()
        wake = null
      }
      void (async () => {
        let turn = 0
        for await (const message of prompt) {
          received.push(String(message.message.content))
          turn++
          if (turn === 1) push(assistant('installing the slow way...')) // then hangs: no result
          else {
            push(assistant('done via uv.'))
            push(result())
          }
        }
        closed = true
        push()
      })()
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
          while (true) {
            if (queue.length === 0) {
              if (closed) return
              await new Promise<void>((res) => (wake = res))
            }
            const m = queue.shift()
            if (m !== undefined) yield m
          }
        },
        interrupt: async () => push(result()), // the SDK closes the turn with a result
      }
    }
    const final = await runGuideSession(
      query,
      guideReq({
        onSession: (s) => (sess = s),
        onText: (t) => {
          if (t.includes('slow way')) void sess?.interruptTurn()
        },
        nextUserInput: async () => replies.shift() ?? null,
      }),
    )
    expect(received).toEqual(['fix it', 'try uv instead'])
    expect(final).toContain('done via uv.')
  })

  it('onSession still arrives on a query without interrupt support, and interruptTurn is a no-op', async () => {
    let sess: GuideSession | null = null
    const final = await runGuideSession(
      fakeQuery([['all good.']], []),
      guideReq({ onSession: (s) => (sess = s) }),
    )
    expect(sess).not.toBeNull()
    await expect(sess!.interruptTurn()).resolves.toBeUndefined()
    expect(final).toBe('all good.')
  })

  it('an interrupt that never fires changes nothing', async () => {
    const received: string[] = []
    const final = await runGuideSession(
      fakeQuery([['all good.']], received),
      guideReq({ interrupt: new Promise<void>(() => {}) }),
    )
    expect(final).toBe('all good.')
  })

  it('a non-command tool input surfaces as compact JSON', async () => {
    const toolUses: [string, string][] = []
    const query = () => {
      async function* stream() {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/tmp/x' } }],
          },
        } as SDKAssistantMessage
        yield { type: 'result', subtype: 'success' } as SDKResultMessage
      }
      return stream()
    }
    await runGuideSession(
      query,
      guideReq({ onToolUse: (name, detail) => void toolUses.push([name, detail]) }),
    )
    expect(toolUses).toEqual([['Read', '{"file_path":"/tmp/x"}']])
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

  it('a bare beat stays bare — no optional fields invented (spec 04 §3.2)', () => {
    expect(cleanBeats([{ text: 'a' }], 5)).toEqual([{ text: 'a' }])
  })
})
