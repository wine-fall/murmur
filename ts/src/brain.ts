// Brain implementations (spec 01 §3.2) behind the two-method contract.
//
// StubBrain — canned, dependency-free text: the fake for the fast test layer
// and offline runs. ClaudeBrain — the real Brain on
// @anthropic-ai/claude-agent-sdk: stateless one-shot query() per call, persona
// as the system prompt, the compact transcript re-sent each time (master §6),
// fully isolated from the user's local Claude Code environment (spec 01 §3.2).
// Batched talk generation rides the in-process MCP tool seam (spec 03-01):
// the model answers by calling emit_talk_beats, so the result arrives as
// schema-validated args, never scraped free text.

import {
  createSdkMcpServer,
  query,
  type McpSdkServerConfigWithInstance,
  type Options,
} from '@anthropic-ai/claude-agent-sdk'

import type { Brain, ContextPack, Harness, TalkBeat, Task, Turn } from './contracts.ts'
import {
  buildCompactionPrompt,
  buildNextTalkPrompt,
  buildNextTalksPrompt,
  buildRespondPrompt,
  COMPACTION_SYSTEM_PROMPT,
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

export class ClaudeBrain implements Brain, Harness {
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

  // A plain tool-less generation under a neutral system framing — bookkeeping,
  // not the host speaking. The Compactor runs this off the live loop.
  async compactProfile(profile: string, transcript: readonly Turn[]): Promise<string> {
    return this.generate(COMPACTION_SYSTEM_PROMPT, buildCompactionPrompt(profile, transcript))
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
