// Talk-vs-music scheduling (spec 03-02 §2.3). The Director consults this seam at
// each segment boundary and never knows which mode is behind it.
//
// EveryN and Random are pure local policy — 0 tokens (master §7 pillar 1).
// BrainCadence is the opt-in exception: one cheap-model judgment per boundary,
// which hard-falls-back to a local policy on any failure, timeout, or nonsense
// answer, so the program never stalls waiting on the network.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { Harness } from './contracts.ts'
import { CADENCE_INSTRUCTION, CADENCE_STATE_HEADER } from './prompts.ts'

export type SegmentKind = 'talk' | 'music'

// Local signals a policy may consult; later specs extend it (pacing in 07, the
// ledger in 05). `situation` is rendered text only BrainCadence reads.
export type CadenceState = {
  readonly talksSinceMusic: number
  readonly situation?: string
}

export interface CadencePolicy {
  nextKind(state: CadenceState): Promise<SegmentKind>
}

export class EveryNCadence implements CadencePolicy {
  private n: number

  constructor(n = 2) {
    this.n = Math.max(1, n)
  }

  async nextKind(state: CadenceState): Promise<SegmentKind> {
    return state.talksSinceMusic >= this.n ? 'music' : 'talk'
  }
}

export type RandomCadenceOptions = {
  p?: number
  minGap?: number
  maxGap?: number
  // Injected so tests are deterministic.
  random?: () => number
}

// Probability p per boundary, guarded: never before minGap talks, always by
// maxGap — no wall-to-wall music, no endless talk.
export class RandomCadence implements CadencePolicy {
  private p: number
  private minGap: number
  private maxGap: number
  private random: () => number

  constructor({ p = 0.35, minGap = 1, maxGap = 6, random = Math.random }: RandomCadenceOptions = {}) {
    this.p = p
    this.minGap = Math.max(0, minGap)
    this.maxGap = Math.max(this.minGap, maxGap)
    this.random = random
  }

  async nextKind(state: CadenceState): Promise<SegmentKind> {
    if (state.talksSinceMusic < this.minGap) return 'talk'
    if (state.talksSinceMusic >= this.maxGap) return 'music'
    return this.random() < this.p ? 'music' : 'talk'
  }
}

const DEFAULT_TIMEOUT_MS = 8_000

export type BrainCadenceOptions = {
  brain: Harness
  model: string
  fallback?: CadencePolicy
  timeoutMs?: number
}

export class BrainCadence implements CadencePolicy {
  private opts: BrainCadenceOptions
  private fallback: CadencePolicy

  constructor(opts: BrainCadenceOptions) {
    this.opts = opts
    this.fallback = opts.fallback ?? new EveryNCadence()
  }

  async nextKind(state: CadenceState): Promise<SegmentKind> {
    const prompt =
      `${CADENCE_INSTRUCTION}\n${CADENCE_STATE_HEADER}` +
      `- talk segments since the last song: ${state.talksSinceMusic}\n${state.situation ?? ''}`
    try {
      // A hung model must not hold the boundary: race the judgment against the
      // deadline. The abandoned task keeps running (promises cannot be
      // cancelled) but nothing waits on it.
      const kind = await Promise.race([
        this.opts.brain.runTask<SegmentKind>({
          systemPrompt: '',
          prompt,
          model: this.opts.model,
          maxTurns: 2,
          tools: (finish) => [chooseSegmentTool(finish)],
        }),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS).unref(),
        ),
      ])
      if (kind !== null) return kind
    } catch {
      // fall through to local policy
    }
    return this.fallback.nextKind(state)
  }
}

function chooseSegmentTool(finish: (kind: SegmentKind) => void) {
  return tool(
    'choose_segment',
    'Commit to the next segment kind. Call exactly once.',
    { kind: z.enum(['talk', 'music']).describe('what plays next') },
    async (args) => {
      finish(args.kind)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] }
    },
  )
}

export function buildCadence(
  mode: 'every_n' | 'random' | 'brain',
  { everyN, brain, model = '' }: { everyN: number; brain?: Harness; model?: string },
): CadencePolicy {
  switch (mode) {
    case 'every_n':
      return new EveryNCadence(everyN)
    case 'random':
      return new RandomCadence()
    case 'brain':
      if (brain === undefined) throw new Error('brain cadence requires a harnessed brain')
      return new BrainCadence({ brain, model, fallback: new EveryNCadence(everyN) })
  }
}
