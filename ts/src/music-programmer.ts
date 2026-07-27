// MusicProgrammer — the Director-facing find-and-pull entry (spec 03-01 §2.4).
//
// Runs the harnessed brain over the music tools and a rendered context, and
// hands back the resolved TrackPick (or null). It finds and pulls a track; it
// does not play, schedule, or announce it — that is the Phase 3 audio engine
// (spec 03-02).

import type { Harness, MusicContext, MusicProvider, TrackPick, TrackSource } from './contracts.ts'
import { musicTools, type StreamProbe } from './music-tools.ts'
import { FIND_MUSIC_INSTRUCTION, MUSIC_CONTEXT_HEADER } from './prompts.ts'

// Enough turns for search -> (maybe refine) -> judge -> submit, and a couple of
// pick-agains if a ref will not resolve.
const DEFAULT_MAX_TURNS = 6

// Context insertion (spec 03-01 §2.5), the one place a MusicContext becomes
// prompt text: the stable persona goes to the system prompt so repeated calls hit
// the prompt cache, the volatile situation rides the per-call turn. Adding a
// context field touches this function and the carrier, never the harness.
export function renderMusicContext(ctx: MusicContext): [string, string] {
  return [ctx.persona, `${MUSIC_CONTEXT_HEADER}${ctx.situation}`]
}

export type MusicProgrammerDeps = {
  brain: Harness
  provider: MusicProvider
  model: string
  maxTurns?: number
  instruction?: string
  probe?: StreamProbe
}

export class MusicProgrammer implements TrackSource {
  private deps: MusicProgrammerDeps

  constructor(deps: MusicProgrammerDeps) {
    this.deps = deps
  }

  async nextTrack(ctx: MusicContext): Promise<TrackPick | null> {
    const [systemPrompt, situationBlock] = renderMusicContext(ctx)
    return this.deps.brain.runTask<TrackPick>({
      systemPrompt,
      prompt: `${this.deps.instruction ?? FIND_MUSIC_INSTRUCTION}\n\n${situationBlock}`,
      model: this.deps.model,
      maxTurns: this.deps.maxTurns ?? DEFAULT_MAX_TURNS,
      tools: (finish) => musicTools(this.deps.provider, finish, this.deps.probe),
    })
  }
}
