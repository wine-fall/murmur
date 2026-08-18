// Brain implementations (spec 01 §3.2) behind the Brain contract.
//
// StubBrain — canned, dependency-free text: the fake for the fast test layer
// and offline runs. ClaudeBrain — the real Brain on
// @anthropic-ai/claude-agent-sdk: stateless one-shot query() per call, persona
// as the system prompt, the compact transcript re-sent each time (master §6),
// fully isolated from the user's local Claude Code environment (spec 01 §3.2).
// Batched talk generation rides the in-process MCP tool seam (spec 03-01):
// the model answers by calling emit_talk_beats, so the result arrives as
// schema-validated args, never scraped free text.

import { readFileSync } from 'node:fs'

import {
  createSdkMcpServer,
  query,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type {
  Brain,
  ContextPack,
  GuideCapable,
  GuideRequest,
  Harness,
  SeedAnswer,
  TalkBeat,
  Task,
  Turn,
} from './contracts.ts'
import {
  buildCompactionPrompt,
  buildNextTalkPrompt,
  buildNextTalksPrompt,
  buildRespondPrompt,
  buildSeedPersonaPrompt,
  COMPACTION_SYSTEM_PROMPT,
  DEFAULT_PERSONA_PATH,
  SEED_PERSONA_SYSTEM_PROMPT,
} from './prompts.ts'
import { emitTalkBeatsTool } from './talk-tools.ts'

// Canned English fake output so the loop looks realistic with no network. The
// stub's language is irrelevant to the product: the real radio speaks Chinese
// only at runtime, produced by the model from the persona prompt (DESIGN §0).
const STUB_SEGMENTS = [
  "It's late, and it's just you and me on the air tonight. Let's talk about nothing in particular.",
  'A thought drifted past just now -- the older we get, the more we swallow the things we meant to say.',
  "I'm half in the mood to drop a song here, but music's still a little ways off. Voice will keep you company for now.",
  "Nothing's stirring outside. This kind of quiet is actually nice -- like the world set you down gently.",
  'I keep thinking company is really just this: a voice that stays, that does not rush you or ask anything of you.',
] as const

export class StubBrain implements Brain {
  private i = 0

  private next(): string {
    const text = STUB_SEGMENTS[this.i % STUB_SEGMENTS.length]!
    this.i++
    return text
  }

  async nextTalks(_ctx: ContextPack, count: number): Promise<TalkBeat[]> {
    return Array.from({ length: count }, () => ({ text: this.next() }))
  }

  async respond(userText: string, _ctx: ContextPack): Promise<string> {
    return `Mm -- you said "${userText}". I heard you. Let's follow that thread a little.`
  }

  async compactProfile(profile: string, _transcript: readonly Turn[]): Promise<string> {
    // Offline: leave the profile unchanged so a stub run's canned chatter never
    // rewrites it (spec 05 §2.4 — compaction is a no-op on the stub).
    return profile
  }

  async seedPersona(_answers: readonly SeedAnswer[]): Promise<string> {
    // Offline: hand back the bundled seed, so a stub onboarding is inert and
    // still produces a loadable persona (spec 06 §2.2).
    return readFileSync(DEFAULT_PERSONA_PATH, 'utf-8').trim()
  }
}

// Full isolation from the user's local Claude Code environment: no CLAUDE.md /
// settings / plugins / hooks (settingSources: []), no tools, no skills, no MCP,
// no slash commands. Subscription OAuth is inherited from the local Claude Code
// login by the SDK. Factored out so the isolation invariant is unit-testable
// without any network call (mirrors the Python build verified against the SDK
// init payload).
export function isolatedOptions(systemPrompt: string, model: string): Options {
  return {
    systemPrompt,
    model,
    settingSources: [],
    allowedTools: [],
    tools: [],
    mcpServers: {},
    skills: [],
    maxTurns: 1,
    extraArgs: { 'disable-slash-commands': null },
  }
}

// Options for an agentic task over murmur's OWN in-process MCP tools (spec
// 03-01 §2.1): same isolation, but the allowlist is exactly murmur's tools.
export function agenticOptions(
  systemPrompt: string,
  model: string,
  server: McpSdkServerConfigWithInstance,
  toolNames: string[],
  maxTurns: number,
): Options {
  return {
    systemPrompt,
    model,
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    allowedTools: toolNames,
    mcpServers: { murmur: server },
    skills: [],
    maxTurns,
    extraArgs: { 'disable-slash-commands': null },
  }
}

// Built-in Claude Code tools the guide harness may use to diagnose + repair
// the environment. A curated set (no network fetch tools) — the bounded
// surface a setup/repair task needs, in contrast to the tool-less find-music
// task (per-task tool surface, spec 03-03 §3).
// WebFetch is here so the guide can read a provider's CURRENT terms instead of
// repeating a free-tier date from training (spec 03-03 §7.2); it is strictly
// narrower than the Bash already on the list.
export const GUIDE_BUILTINS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch'] as const

// Where a credential lives (spec 03-03 §7.2: voice.json holds the api key,
// .env* the remote-voice creds, $MURMUR_HOME under ~/.murmur, the process
// environment): any tool input referencing these is refused. Tested against
// the WHOLE input, so a Grep path or a glob hits it too.
export const SECRET_PATH = /\.env\b|voice\.json|\.murmur\b|\benviron\b/i

// Bash-only atoms: a secret-shaped name, an environment dump (bare `env` is a
// dump, `/usr/bin/env <program>` is a launcher), or a parameter expansion —
// the guard cannot tell $HOME from $SOME_KEY, and a denied `$HOME` is cheap
// to rephrase as a literal path. URLs are stripped before the name test: the
// voice walkthrough legitimately opens .../app/api-keys pages.
export const SECRET_NAME = /api[_-]?key|secret|password|credential|token/i
const ENV_DUMP = /\bprintenv\b|\benv\b\s*(?:$|[|;&)])|\b(?:set|export|declare|typeset)\b/
const EXPANSION = /\$(?![?(])/

// This guard is a tripwire against ACCIDENTAL credential ingestion, not a
// sandbox: the model is shaped by the prompt, not adversarial, and a regex
// cannot enumerate every read of every secret. It refuses the shapes a
// diagnosis plausibly wanders into; the deny reason teaches the model why.
export function isSecretBearing(toolName: string, input: unknown): boolean {
  // murmur-owned tools are exempt — their handlers own the secret channel
  // (write_voice_config reads the key at the keyboard, never the transcript).
  if (toolName.startsWith('mcp__murmur__')) return false
  if (SECRET_PATH.test(JSON.stringify(input))) return true
  if (toolName !== 'Bash') return false
  const command = z.object({ command: z.string() }).safeParse(input)
  if (!command.success) return false
  const cmd = command.data.command.replace(/https?:\/\/\S+/g, '')
  return SECRET_NAME.test(cmd) || ENV_DUMP.test(cmd) || EXPANSION.test(cmd)
}

export const SECRET_DENY_MESSAGE =
  'murmur never lets a session read credential-bearing files or variables: ' +
  'the result would be kept in the session transcript. Secrets reach murmur ' +
  'only through its own tools (write_voice_config asks at the keyboard).'

// The transcript-protection red line, enforced where EVERY tool use passes:
// the SDK consults canUseTool only when its own policy would ask, and Read /
// safe Bash commands never ask — so the permission callback alone cannot keep
// a credential out of the transcript (smoke-proven: a Read of .env sailed
// straight through it). A PreToolUse hook fires unconditionally.
const secretGuard: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {}
  if (isSecretBearing(input.tool_name, input.tool_input)) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SECRET_DENY_MESSAGE,
      },
    }
  }
  return {}
}

// Options for the guide harness (spec 03-03): same isolation as the other
// harnesses (no user settings/skills/MCP), but the curated BUILT-IN tools are
// enabled. The surface is bounded via `tools` — NOT `allowedTools`, which
// only pre-approves and does not bound what exists. Factored out so the
// isolation, the bounded surface, and the secret-guard hook are unit-testable
// without a network call. murmur-owned tools ride the same `tools` allowlist
// as the built-ins (spec 03-03 §7.2's write_voice_config).
export function guideOptions(req: GuideRequest): Options {
  const extra = req.tools ?? []
  const server = extra.length > 0 ? createSdkMcpServer({ name: 'murmur', tools: [...extra] }) : null
  return {
    systemPrompt: req.systemPrompt,
    model: req.model,
    settingSources: [],
    strictMcpConfig: true,
    tools: [...GUIDE_BUILTINS, ...extra.map((t) => `mcp__murmur__${t.name}`)],
    mcpServers: server === null ? {} : { murmur: server },
    skills: [],
    permissionMode: req.permissionMode ?? 'default',
    hooks: { PreToolUse: [{ hooks: [secretGuard] }] },
    ...(req.canUseTool !== undefined && { canUseTool: req.canUseTool }),
    maxTurns: req.maxTurns,
    extraArgs: { 'disable-slash-commands': null },
  }
}

type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}) => AsyncIterable<SDKMessage>

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
})

// The guide conversation loop (spec 03-03 §2), factored over an injectable
// query so the deterministic machinery is unit-testable against a fake SDK.
// Always streaming input: the multi-turn reply loop needs it, and the
// permission callback only works in that mode (the seam that bit the Python
// build as a unit-green regression).
export async function runGuideSession(queryFn: QueryFn, req: GuideRequest): Promise<string> {
  // Turn-end coordination between the two async flows: the message loop fires
  // when a turn's result arrives; the input stream then pulls the user's reply.
  const waiters: (() => void)[] = []
  let fired = 0
  const turnEnded = {
    fire(): void {
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter()
      else fired++
    },
    wait(): Promise<void> {
      if (fired > 0) {
        fired--
        return Promise.resolve()
      }
      return new Promise((resolve) => waiters.push(resolve))
    },
  }

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(req.prompt)
    if (req.nextUserInput === undefined) return // single-shot: end after one turn
    while (true) {
      await turnEnded.wait()
      const reply = await req.nextUserInput()
      if (reply === null) return // user done -> the SDK closes the session
      yield userMessage(reply)
    }
  }

  const parts: string[] = []
  // The message loop, raced against the interrupt: a /quit must not wait for
  // the agent to finish the turn in flight. However the loop exits — done,
  // interrupted, or a thrown handler — the finally closes the SDK subprocess
  // (the guarantee breaking a for-await gave), without awaiting it: the exit
  // must not hang on a slow subprocess teardown.
  const INTERRUPTED = 'interrupted' as const
  const interrupted = req.interrupt?.then(() => INTERRUPTED)
  const iterator = queryFn({ prompt: input(), options: guideOptions(req) })[Symbol.asyncIterator]()
  try {
    while (true) {
      const step =
        interrupted === undefined
          ? await iterator.next()
          : await Promise.race([iterator.next(), interrupted])
      if (step === INTERRUPTED) break
      if (step.done === true) break
      const message = step.value
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text)
            req.onText?.(block.text) // stream out as it arrives
          } else if (block.type === 'tool_use') {
            req.onToolUse?.(block.name, toolDetail(block.input), block.id)
          }
        }
      } else if (message.type === 'user') {
        // Tool results come back as synthesized user messages. Typed replies
        // are string content (or text blocks) and never match `tool_result`.
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              req.onToolResult?.(toolResultText(block.content), block.is_error === true, block.tool_use_id)
            }
          }
        }
      } else if (message.type === 'result') {
        turnEnded.fire()
      }
    }
  } finally {
    void iterator.return?.().catch(() => {})
  }
  return parts.join('\n').trim()
}

// One line naming what a tool is about to do: a Bash command reads best as
// itself; every other input reads as compact JSON.
export function toolDetail(input: unknown): string {
  const command = z.object({ command: z.string() }).safeParse(input)
  return command.success ? command.data.command : JSON.stringify(input)
}

function toolResultText(content: string | { type: string; text?: string }[] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export class ClaudeBrain implements Brain, Harness, GuideCapable {
  private model: string

  constructor(model: string) {
    this.model = model
  }

  // The harness (spec 03-01 §2.1): a bounded tool-use loop over murmur's OWN
  // in-process tools, capability-agnostic — music discovery and brain cadence
  // ride the same entry point. The task ends as soon as a tool calls `finish`;
  // breaking the iteration closes the query subprocess.
  async runTask<T>(task: Task<T>): Promise<T | null> {
    let captured: T | null = null
    const tools = task.tools((value) => (captured = value))
    const server = createSdkMcpServer({ name: 'murmur', tools })
    const allowed = tools.map((t) => `mcp__murmur__${t.name}`)
    const q = query({
      prompt: task.prompt,
      options: agenticOptions(task.systemPrompt, task.model, server, allowed, task.maxTurns),
    })
    for await (const _message of q) {
      if (captured !== null) break
    }
    return captured
  }

  async nextTalks(ctx: ContextPack, count: number): Promise<TalkBeat[]> {
    const beats = await this.runTask<TalkBeat[]>({
      systemPrompt: ctx.persona,
      prompt: buildNextTalksPrompt(ctx, count),
      model: this.model,
      maxTurns: 2,
      tools: (finish) => [emitTalkBeatsTool(count, finish)],
    })
    if (beats !== null) return beats
    // The model never made the terminal call. Degrade to one plain-text beat
    // rather than skip the segment into dead air (spec 04 §3.2).
    return [{ text: await this.generate(ctx.persona, buildNextTalkPrompt(ctx)) }]
  }

  async respond(userText: string, ctx: ContextPack): Promise<string> {
    return this.generate(ctx.persona, buildRespondPrompt(userText, ctx))
  }

  // The setup/repair capability (spec 03-03): the native Claude Code agent
  // with built-in tools, the entry-authorization permission policy, and the
  // multi-turn user-reply loop — a different harness from runTask.
  async runGuide(req: GuideRequest): Promise<string> {
    return runGuideSession(query, req)
  }

  // A plain tool-less generation under a neutral system framing — bookkeeping,
  // not the host speaking. The Compactor runs this off the live loop.
  async compactProfile(profile: string, transcript: readonly Turn[]): Promise<string> {
    return this.generate(COMPACTION_SYSTEM_PROMPT, buildCompactionPrompt(profile, transcript))
  }

  // One tool-less fold of the onboarding answers into a persona, on the good
  // tier: it happens once per install and every later beat inherits it (spec
  // 06 §3.3).
  async seedPersona(answers: readonly SeedAnswer[]): Promise<string> {
    return this.generate(SEED_PERSONA_SYSTEM_PROMPT, buildSeedPersonaPrompt(answers))
  }

  private async generate(persona: string, prompt: string): Promise<string> {
    const parts: string[] = []
    for await (const message of query({ prompt, options: isolatedOptions(persona, this.model) })) {
      if (message.type !== 'assistant') continue
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) parts.push(block.text)
      }
    }
    const text = parts.join('').trim()
    if (!text) throw new Error('ClaudeBrain produced no text (check Claude Code login / network)')
    return text
  }
}
