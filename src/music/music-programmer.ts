// MusicProgrammer — the Director-facing find-and-pull entry (spec 03-01 §2.4).
//
// Runs the harnessed brain over the music tools and a rendered context, and
// hands back the resolved TrackPick (or null). It finds and pulls a track; it
// does not play, schedule, or announce it — that is the Phase 3 audio engine
// (spec 03-02).

import type {
  AudioClip,
  Catalogue,
  Familiarity,
  Harness,
  MusicContext,
  MusicProvider,
  TrackCandidate,
  TrackPick,
  TrackSource,
} from '../contracts.ts'
import { musicTools, type ChannelCatalogue, type StreamProbe, type TasteToolOptions } from './music-tools.ts'
import { FIND_MUSIC_INSTRUCTION, MUSIC_CONTEXT_HEADER, NO_REPEATS_RULE } from '../prompts/music.ts'

// Enough turns for several searches -> judge -> submit, and a couple of
// pick-agains if a ref will not resolve: a real pick can spend 5 searches
// before submitting, so the budget leaves headroom beyond that.
const DEFAULT_MAX_TURNS = 8

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
  // The pick instruction, re-read per call (spec 03-01 §2.3): the listener's
  // policy file is hot, so an edit lands on the next song without a restart.
  instruction?: () => string
  probe?: StreamProbe
  // The taste wiring (spec 14 §2.4/§2.6): mounted catalogues, the auth
  // report, the preview-trap probe. Absent = the tools are their pre-taste
  // selves and search_music lists youtube alone.
  taste?: TasteToolOptions
  // The curated-channel pool (spec 14 §2.9): the extra place to LOOK for a
  // song, never taste. Poked at each boundary — the pool's own staleness gate
  // makes that a no-op on all but one pick a day, so there is no second
  // scheduler here. Absent = the catalogue is not offered at all.
  channels?: ChannelCatalogue & { maybeRefresh: () => boolean }
  // The discovery wiring (spec 14 3.10): the neighbour pool submit_pick
  // fills from the ref it commits to, and what the listener already knows of
  // a candidate. The slot verdict rides the context, not this.
  discovery?: { prime?: (ref: string) => void; label?: (title: string, artist: string, played: readonly string[]) => Promise<Familiarity> }
  // Per-stage discovery timing (spec 04 §3.1, issue #76): dev-log-only lines
  // that say where a pick's wall-clock goes. Optional — absent means silent.
  debug?: (message: string) => void
}

const elapsed = (since: number) => `${Math.round(performance.now() - since)}ms`

// yt-dlp echoes the whole search spec in its errors; the terms are the
// listener's taste (spec 14 §3.6), so only the spec's head is kept.
const SEARCH_SPEC = /\b(yt|bili)search\d*:.*/gs

function withoutQuery(text: string): string {
  return text.replace(SEARCH_SPEC, '$1search:<query>')
}

// Time each provider call on its way through, success or failure — the tail of
// a slow pick must name its stage, not read as one opaque wait.
function timedProvider(provider: MusicProvider, debug: (message: string) => void): MusicProvider {
  return {
    async search(query: string, limit?: number, catalogue?: Catalogue): Promise<TrackCandidate[]> {
      const t = performance.now()
      const where = catalogue === undefined ? '' : ` catalogue=${catalogue}`
      try {
        const hits = await provider.search(query, limit, catalogue)
        // The query's size, never its words (spec 14 §3.6): a taste-led
        // search quotes a kept title, and the dev log is what a /bug report
        // attaches. Same reading the situation's `NNNch` gets.
        debug(`music.search ${elapsed(t)} hits=${hits.length} q=${query.length}ch${where}`)
        return hits
      } catch (err) {
        debug(`music.search ${elapsed(t)} failed: ${withoutQuery(String(err))}${where}`)
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
  return async (source, headers, startS) => {
    const t = performance.now()
    const ok = await probe(source, headers, startS)
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
    // Background, never awaited: a stale pool must not hold up a pick, and a
    // fresh one is ready for the boundary after this.
    this.deps.channels?.maybeRefresh()
    const [systemPrompt, situationBlock] = renderMusicContext(ctx)
    const instruction = this.deps.instruction?.() ?? FIND_MUSIC_INSTRUCTION
    // The avoid-list is enforced in code only while the policy in force still
    // asks for it: the rule is the listener's to replace (spec 03-01 §2.3),
    // and a policy that welcomes repeats must not be overruled by a tool.
    const avoid = instruction.includes(NO_REPEATS_RULE) ? ctx.avoid : undefined
    const { debug, probe } = this.deps
    const provider = debug === undefined ? this.deps.provider : timedProvider(this.deps.provider, debug)
    const wiredProbe = probe !== undefined && debug !== undefined ? timedProbe(probe, debug) : probe
    // The relocation line (spec 14 §2.13) rides the same sink as the timings.
    const taste =
      this.deps.taste === undefined || debug === undefined ? this.deps.taste : { ...this.deps.taste, debug }
    // The discovery wiring, bound to THIS pick (spec 14 3.10): what murmur
    // has aired and whether this slot may play something they know are facts
    // about the moment, so they arrive with the context, not with the deps.
    const wired = this.deps.discovery
    const discovery =
      wired === undefined
        ? undefined
        : {
            ...(wired.prime !== undefined && { prime: wired.prime }),
            ...(wired.label !== undefined && {
              label: (title: string, artist: string): Promise<Familiarity> => wired.label!(title, artist, ctx.played ?? []),
            }),
            ...(ctx.newOnly !== undefined && { newOnly: ctx.newOnly }),
            ...(debug !== undefined && { log: debug }),
          }
    const t = performance.now()
    // The situation size rides along because prompt growth is the suspected
    // hot-slower-than-cold term (spec 04 §3.3 measurement).
    debug?.(`music.pick start situation=${ctx.situation.length}ch`)
    const pick = await this.deps.brain.runTask<TrackPick>({
      systemPrompt,
      prompt: `${instruction}\n\n${situationBlock}`,
      model: this.deps.model,
      maxTurns: this.deps.maxTurns ?? DEFAULT_MAX_TURNS,
      // The pick is a bounded search-and-commit whose method the policy already
      // states, and nothing reads its reasoning back. The SDK's default extended
      // thinking spent ~45 s of a ~100 s pick writing it (issue #164).
      thinking: 'disabled',
      tools: (finish) => musicTools(provider, finish, wiredProbe, taste, this.deps.channels, avoid, discovery),
    })
    debug?.(`music.pick done ${elapsed(t)} picked=${pick === null ? 'no' : 'yes'}`)
    return pick
  }
}
