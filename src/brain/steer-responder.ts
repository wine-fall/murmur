// SteerResponder — the agentic reply turn (spec 11 §2.2).
//
// Runs the harnessed brain over the steer tools for one user turn: the model
// decides whether the words ask the program to DO something, acts through the
// Director-owned callbacks, and finishes with the spoken reply. Null = the
// model never made the terminal call; the Director falls back to the tool-less
// Brain.respond.

import type { ContextPack, Harness, SteerActions, SteerBrain } from '../contracts.ts'
import { buildSteerPrompt } from '../prompts/reply.ts'
import { steerTools } from './steer-tools.ts'

// Enough turns for recall -> act -> reply, plus one slack turn (spec 05-01 §2.2).
const DEFAULT_MAX_TURNS = 4

export type SteerResponderDeps = {
  brain: Harness
  model: string
  maxTurns?: number
}

export class SteerResponder implements SteerBrain {
  private deps: SteerResponderDeps

  constructor(deps: SteerResponderDeps) {
    this.deps = deps
  }

  async respond(userText: string, ctx: ContextPack, actions: SteerActions): Promise<string | null> {
    return this.deps.brain.runTask<string>({
      systemPrompt: ctx.persona,
      prompt: buildSteerPrompt(userText, ctx, {
        musicWired: actions.music !== undefined,
        settingsWired: actions.settings !== undefined,
        memoryWired: actions.memory !== undefined,
        shutdownArmed: actions.shutdown.armed(),
      }),
      model: this.deps.model,
      maxTurns: this.deps.maxTurns ?? DEFAULT_MAX_TURNS,
      tools: (finish) => steerTools(actions, finish),
    })
  }
}
