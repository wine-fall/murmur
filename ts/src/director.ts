// Program Director — the loop + interruption (spec 01 §3.3).
//
// Phase 1 is the talk-only spec-01 loop: at each segment boundary the Director
// airs the next beat (drawn from one batched Brain call — token-economy pillar
// 2), paces with an inter-segment gap, and arbitrates typed interjections.
//
// Interjection is prepare-then-barge-in: a typed line becomes a Steer; the
// current clip keeps playing while the Brain composes the reply and the voice
// synthesizes it, and only when the reply clip is ready does the loop cut over
// (player.stop()) — an interjection never opens a dead-air gap. A line landing
// while the reply is still composing is merged into the one reply. Promises
// cannot be cancelled, so a merged-away prepare keeps running and its result
// is discarded — the wasted call is the cost of merge-anytime, and merges are
// rare.

import { setTimeout as sleep } from 'node:timers/promises'

import type {
  AudioClip,
  Brain,
  ContextPack,
  MemoryStore,
  Player,
  TalkBeat,
  VoiceProvider,
} from './contracts.ts'
import type { Host } from './host.ts'

const QUIT_COMMAND = '/quit'

// Bounded attempts for a Brain/synth call before it degrades (lose the beat,
// never the radio).
const ATTEMPTS = 2

export type Steer = { intent: 'quit' } | { intent: 'talkback'; text: string }

export function steerFromLine(line: string): Steer {
  return line.trim() === QUIT_COMMAND ? { intent: 'quit' } : { intent: 'talkback', text: line }
}

// A play promise with a synchronously readable settled flag, so barge-in can
// tell "still on air" (stop first) from "already ended" (just air the reply).
type OnAir = { promise: Promise<void>; done: () => boolean }

function onAir(promise: Promise<void>): OnAir {
  let settled = false
  return { promise: promise.finally(() => (settled = true)), done: () => settled }
}

export type DirectorDeps = {
  persona: string
  brain: Brain
  voice: VoiceProvider
  player: Player
  memory: MemoryStore
  host: Host
  gapSeconds: number
  recentWindow: number
  talkBatch: number
}

export class Director {
  private quit = false
  // Beats already generated but not yet aired (the rest of the last batch).
  // Discarded on a talkback steer — they predate the user's turn.
  private beats: TalkBeat[] = []

  private deps: DirectorDeps

  constructor(deps: DirectorDeps) {
    this.deps = deps
  }

  // Orderly-stop entry for signal handlers (Ctrl-C): the loop notices after
  // the current await settles; a playing clip is cut in runVoice's exit path.
  requestQuit(): void {
    this.quit = true
  }

  async run(maxSegments?: number): Promise<void> {
    this.deps.host.start()
    let produced = 0
    while (!this.quit && (maxSegments === undefined || produced < maxSegments)) {
      await this.talkSegment()
      produced++
      const last = maxSegments !== undefined && produced >= maxSegments
      if (!last && !this.quit) await this.gap()
    }
  }

  private context(): ContextPack {
    return {
      persona: this.deps.persona,
      recent: this.deps.memory.recent(this.deps.recentWindow),
    }
  }

  private async talkSegment(): Promise<void> {
    if (this.beats.length === 0) this.beats = await this.generateTalks()
    const beat = this.beats.shift()
    if (beat === undefined) return // generation degraded; the loop keeps broadcasting
    const clip = await this.synthesizeOrSkip(beat.text)
    if (clip === null) return
    // Printed + recorded at air time, so an interjection's reply sees this
    // segment in context.
    this.deps.host.onRadioSegment(beat.text)
    this.deps.memory.record({ role: 'radio', text: beat.text })
    await this.runVoice(onAir(this.deps.player.play(clip)))
  }

  private async generateTalks(): Promise<TalkBeat[]> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await this.deps.brain.nextTalks(this.context(), this.deps.talkBatch)
      } catch (err) {
        if (attempt === ATTEMPTS) {
          this.deps.host.info(`talk generation failed (${String(err)}); skipping this segment.`)
        }
      }
    }
    return []
  }

  private async synthesizeOrSkip(text: string): Promise<AudioClip | null> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await this.deps.voice.synthesize(text)
      } catch (err) {
        if (attempt === ATTEMPTS) {
          this.deps.host.info(`voice synthesis failed (${String(err)}); skipping this segment.`)
        }
      }
    }
    return null
  }

  // Inter-segment pause, steerable: a line during the gap gets its reply; the
  // gap is not resumed afterward (the program moves to the next segment).
  private async gap(): Promise<void> {
    const ac = new AbortController()
    const slept = sleep(this.deps.gapSeconds * 1000, undefined, { signal: ac.signal }).then(
      () => true,
      () => false,
    )
    const line = this.deps.host.peekLine().then(() => false)
    const finished = await Promise.race([slept, line])
    if (finished) return
    ac.abort()
    const steer = steerFromLine(this.deps.host.takeLine()!)
    await this.runVoice(null, steer)
  }

  // The single steer-arbitration loop (spec 01 §3.3): races the on-air clip
  // against the next typed line; a talkback steer composes the reply while the
  // clip keeps playing, then barges in when the reply clip is ready. An
  // initial steer seeds the loop (the gap path, where nothing is on air).
  private async runVoice(voice: OnAir | null, seed?: Steer): Promise<void> {
    let current = voice
    let steer: Steer | null = seed ?? null
    try {
      while (!this.quit) {
        if (steer === null) {
          if (current === null || current.done()) return
          const winner = await Promise.race([
            current.promise.then(() => null),
            this.deps.host.peekLine().then(() => 'line' as const),
          ])
          if (winner === null) return // clip ended -> segment over
          steer = steerFromLine(this.deps.host.takeLine()!)
        }
        if (steer.intent === 'quit') {
          this.quit = true
          return
        }
        this.beats = [] // buffered beats predate this user turn -> stale
        const composed = await this.compose(steer.text)
        steer = null
        if (this.quit) return // a merged-in line was /quit
        if (composed === null) continue // reply degraded; keep racing current audio
        if (current !== null && !current.done()) await this.deps.player.stop()
        await current?.promise
        this.deps.host.onRadioSegment(composed.reply)
        this.deps.memory.record({ role: 'radio', text: composed.reply })
        current = onAir(this.deps.player.play(composed.clip))
      }
    } finally {
      // /quit or shutdown while a clip is playing: cut it on the way out.
      if (this.quit && current !== null && !current.done()) {
        await this.deps.player.stop()
        await current.promise
      }
    }
  }

  // Compose + synthesize the reply, merging any line that lands before the
  // reply clip is ready into one combined reply (spec 01 §3.3). Echoes and
  // records each user turn. Returns null when synthesis degraded, or when a
  // merged-in line was /quit (this.quit is then set).
  private async compose(first: string): Promise<{ reply: string; clip: AudioClip } | null> {
    const texts = [first]
    this.deps.host.onUserLine(first)
    this.deps.memory.record({ role: 'user', text: first })
    while (true) {
      const prep = this.prepareReply(texts)
      const winner = await Promise.race([
        prep.then((r) => ({ kind: 'ready' as const, r })),
        this.deps.host.peekLine().then(() => ({ kind: 'line' as const })),
      ])
      if (winner.kind === 'ready') return winner.r
      prep.catch(() => {}) // discarded in-flight prepare (cannot cancel a promise)
      const merged = steerFromLine(this.deps.host.takeLine()!)
      if (merged.intent === 'quit') {
        this.quit = true
        return null
      }
      texts.push(merged.text)
      this.deps.host.onUserLine(merged.text)
      this.deps.memory.record({ role: 'user', text: merged.text })
    }
  }

  // Total (never rejects): a failed compose degrades to null so the race in
  // compose() and the loop above never unwind the radio on a Brain error.
  private async prepareReply(texts: string[]): Promise<{ reply: string; clip: AudioClip } | null> {
    let reply: string
    try {
      reply = await this.deps.brain.respond(texts.join('\n'), this.context())
    } catch (err) {
      this.deps.host.info(`reply failed (${String(err)}); back to the program.`)
      return null
    }
    const clip = await this.synthesizeOrSkip(reply)
    return clip === null ? null : { reply, clip }
  }
}
