// MusicProgrammer — the Director-facing find-and-pull entry (spec 03-01 §2.4).
//
// Runs the harnessed brain over the music tools and a rendered context, and
// hands back the resolved TrackPick (or null). It finds and pulls a track; it
// does not play, schedule, or announce it — that is the Phase 3 audio engine
// (spec 03-02).

import type { AudioClip, Harness, MusicContext, MusicProvider, TrackCandidate, TrackPick, TrackSource } from './contracts.ts'
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
  // Per-stage discovery timing (spec 04 §3.1, issue #76): dev-log-only lines
  // that say where a pick's wall-clock goes. Optional — absent means silent.
  debug?: (message: string) => void
}

const elapsed = (since: number) => `${Math.round(performance.now() - since)}ms`

// Time each provider call on its way through, success or failure — the tail of
// a slow pick must name its stage, not read as one opaque wait.
function timedProvider(provider: MusicProvider, debug: (message: string) => void): MusicProvider {
  return {
    async search(query: string, limit?: number): Promise<TrackCandidate[]> {
      const t = performance.now()
      try {
        const hits = await provider.search(query, limit)
        debug(`music.search ${elapsed(t)} hits=${hits.length} query="${query}"`)
        return hits
      } catch (err) {
        debug(`music.search ${elapsed(t)} failed: ${String(err)}`)
        throw err
      }
    },
    async resolve(ref: string): Promise<AudioClip> {
      const t = performance.now()
      try {
        const clip = await provider.resolve(ref)
        debug(`music.resolve ${elapsed(t)} ok`)
        return clip
      } catch (err) {
        debug(`music.resolve ${elapsed(t)} failed: ${String(err)}`)
        throw err
      }
    },
  }
}

function timedProbe(probe: StreamProbe, debug: (message: string) => void): StreamProbe {
  return async (source) => {
    const t = performance.now()
    const ok = await probe(source)
    debug(`music.probe ${elapsed(t)} ${ok ? 'ok' : 'dead'}`)
    return ok
  }
}

export class MusicProgrammer implements TrackSource {
  private deps: MusicProgrammerDeps

  constructor(deps: MusicProgrammerDeps) {
    this.deps = deps
  }

  async nextTrack(ctx: MusicContext): Promise<TrackPick | null> {
    const [systemPrompt, situationBlock] = renderMusicContext(ctx)
    const { debug, probe } = this.deps
    const provider = debug === undefined ? this.deps.provider : timedProvider(this.deps.provider, debug)
    const wiredProbe = probe !== undefined && debug !== undefined ? timedProbe(probe, debug) : probe
    const t = performance.now()
    // The situation size rides along because prompt growth is the suspected
    // hot-slower-than-cold term (spec 04 §3.3 measurement).
    debug?.(`music.pick start situation=${ctx.situation.length}ch`)
    const pick = await this.deps.brain.runTask<TrackPick>({
      systemPrompt,
      prompt: `${this.deps.instruction ?? FIND_MUSIC_INSTRUCTION}\n\n${situationBlock}`,
      model: this.deps.model,
      maxTurns: this.deps.maxTurns ?? DEFAULT_MAX_TURNS,
      tools: (finish) => musicTools(provider, finish, wiredProbe),
    })
    debug?.(`music.pick done ${elapsed(t)} picked=${pick === null ? 'no' : 'yes'}`)
    return pick
  }
}
