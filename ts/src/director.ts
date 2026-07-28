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

import type { CadencePolicy } from './cadence.ts'
import type {
  AudioClip,
  Brain,
  ContextPack,
  MemoryStore,
  MixingPlayer,
  MusicContext,
  MusicHandle,
  Player,
  TalkBeat,
  TrackPick,
  TrackSource,
  VoiceProvider,
} from './contracts.ts'
import type { Host } from './host.ts'
import { buildMusicSituation } from './prompts.ts'

const QUIT_COMMAND = '/quit'

// Bounded attempts for a Brain/synth call before it degrades (lose the beat,
// never the radio).
const ATTEMPTS = 2

// How long a started stream may take to produce real audio before the pick is
// dropped for a fresh one (spec 03-02 §3.5: confirm audio BEFORE the announce).
const STREAM_START_TIMEOUT_S = 8
const MUSIC_START_ATTEMPTS = 2

// Session-local anti-repeat depth for the music avoid-list (the persistent
// ledger is spec 05, Phase 4).
const AVOID_DEPTH = 8

export type Steer = { intent: 'quit' } | { intent: 'talkback'; text: string }

export function steerFromLine(line: string): Steer {
  return line.trim() === QUIT_COMMAND ? { intent: 'quit' } : { intent: 'talkback', text: line }
}

// A promise with a synchronously readable settled flag: barge-in tells "still
// on air" from "already ended"; the music boundary tells "pick ready" from
// "pick still resolving" (never block the air on it).
type Pending<T> = { promise: Promise<T>; done: () => boolean }

function pending<T>(promise: Promise<T>): Pending<T> {
  let settled = false
  return { promise: promise.finally(() => (settled = true)), done: () => settled }
}

type OnAir = Pending<void>
const onAir = (promise: Promise<void>): OnAir => pending(promise)

// Music wiring is optional as a block: without it the Director is exactly the
// spec-01 talk loop (no capability sniffing on the player).
export type MusicWiring = {
  source: TrackSource
  cadence: CadencePolicy
  engine: MixingPlayer
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
  music?: MusicWiring
}

export class Director {
  private quit = false
  // Beats already generated but not yet aired (the rest of the last batch).
  // Discarded on a talkback steer — they predate the user's turn.
  private beats: TalkBeat[] = []
  private talksSinceMusic = 0
  // Single-slot music prefetch (spec 04 slice 1): the next pick resolves in the
  // background so its find-and-pull latency overlaps talk, never the boundary.
  private pendingPick: Pending<TrackPick | null> | null = null
  // Songs aired this session, newest last — the pick avoid-list.
  private playedSongs: string[] = []

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
      if ((await this.wantsMusic()) && (await this.musicSegment())) {
        this.talksSinceMusic = 0
      } else {
        await this.talkSegment()
        this.talksSinceMusic++
      }
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
    // Prime the next music pick before synth: its find-and-pull latency overlaps
    // this talk's synthesis + airtime. The beat text folds into the mood even
    // though it is only recorded at air time.
    this.prefetchMusic(beat.text)
    const clip = await this.synthesizeOrSkip(beat.text)
    if (clip === null) return
    // Printed + recorded at air time, so an interjection's reply sees this
    // segment in context.
    this.deps.host.onRadioSegment(beat.text)
    this.deps.memory.record({ role: 'radio', text: beat.text })
    await this.runVoice(onAir(this.deps.player.play(clip)))
  }

  // -- the music branch (spec 03-02 §3.5) ----------------------------------- //

  private async wantsMusic(): Promise<boolean> {
    const music = this.deps.music
    if (music === undefined) return false
    const recent = this.deps.memory.recent(this.deps.recentWindow)
    const situation = recent.map((t) => `- ${t.role}: ${t.text}`).join('\n')
    return (await music.cadence.nextKind({ talksSinceMusic: this.talksSinceMusic, situation })) === 'music'
  }

  private musicContext(): MusicContext {
    return {
      persona: this.deps.persona,
      situation: buildMusicSituation(
        this.deps.memory.recent(this.deps.recentWindow),
        this.playedSongs.slice(-AVOID_DEPTH),
      ),
    }
  }

  private prefetchMusic(latest?: string): void {
    const music = this.deps.music
    if (music === undefined || this.pendingPick !== null) return
    const base = this.musicContext()
    const ctx =
      latest === undefined ? base : { ...base, situation: `${base.situation}\n- radio: ${latest}` }
    // A failed prefetch degrades like an empty pick at the boundary.
    this.pendingPick = pending(music.source.nextTrack(ctx).catch(() => null))
  }

  // The pick for the boundary: the prefetched one if primed (near-instant when
  // already resolved), else a cold fetch. Clears the slot; later talk refills it.
  private takePick(): Promise<TrackPick | null> {
    const primed = this.pendingPick
    this.pendingPick = null
    if (primed !== null) return primed.promise
    return this.deps.music!.source.nextTrack(this.musicContext())
  }

  // Find, confirm, announce, and air one track. False = nothing aired (the
  // caller falls back to talk — a music error must never crash the radio).
  private async musicSegment(): Promise<boolean> {
    const music = this.deps.music!
    // Never block the air on a pick still resolving: air talk instead and
    // re-attempt music at the next boundary while it keeps resolving.
    if (this.pendingPick !== null && !this.pendingPick.done()) return false
    try {
      for (let attempt = 0; attempt < MUSIC_START_ATTEMPTS && !this.quit; attempt++) {
        const pick = await this.takePick()
        if (pick === null) {
          this.deps.host.info('music: nothing suitable found; back to talk.')
          return false
        }
        // Start the stream, then synthesize the intro WHILE it spins up, but
        // commit to the announce only once real audio is confirmed — the
        // narration must never claim a song that turns out silent.
        const handle = await music.engine.playMusic(pick.clip)
        const announced =
          pick.announce === undefined ? null : this.synthesizeOrSkip(pick.announce)
        if (!(await handle.waitStarted(STREAM_START_TIMEOUT_S))) {
          await announced?.then(
            () => {},
            () => {},
          )
          await handle.stop()
          continue
        }
        const label = pick.artist === undefined ? (pick.title ?? 'music') : `${pick.title ?? 'music'} — ${pick.artist}`
        this.deps.host.info(`now playing: ${label}`)
        this.playedSongs.push(label)
        let voice: OnAir | null = null
        const announceClip = announced === null ? null : await announced
        if (pick.announce !== undefined && announceClip !== null) {
          this.deps.host.onRadioSegment(pick.announce)
          this.deps.memory.record({ role: 'radio', text: pick.announce })
          voice = onAir(this.deps.player.play(announceClip))
        }
        await this.runVoice(voice, handle)
        return true
      }
      if (!this.quit) {
        this.deps.host.info('music: stream failed to start; back to talk.')
      }
      return false
    } catch (err) {
      this.deps.host.info(`music segment failed (${String(err)}); back to talk.`)
      return false
    }
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
    await this.runVoice(null, undefined, steer)
  }

  // The single steer-arbitration loop (spec 01 §3.3 + 03-02 §3.5): races the
  // on-air voice clip (a talk beat, a music intro, or a reply) and, when the
  // voice channel is idle, the persistent `song`, against the next typed line.
  // A talkback steer composes the reply while the audio keeps playing, then
  // barges in: the reply replaces the VOICE clip (player.stop() — never the
  // song; the engine auto-ducks it under the reply). The song is a background
  // activity — chained interjections all ride over it; it ends naturally or on
  // /quit. An initial steer seeds the loop (the gap path, nothing on air).
  private async runVoice(voice: OnAir | null, song?: MusicHandle, seed?: Steer): Promise<void> {
    let current = voice
    let steer: Steer | null = seed ?? null
    try {
      while (!this.quit) {
        if (steer === null) {
          const voiceLive = current !== null && !current.done()
          const audio = voiceLive
            ? current!.promise.then(() => 'voice' as const)
            : song !== undefined
              ? song.wait().then(() => 'song' as const)
              : null
          if (audio === null) return
          const winner = await Promise.race([
            audio,
            this.deps.host.peekLine().then(() => 'line' as const),
          ])
          if (winner === 'song') return // the song ended -> segment over
          if (winner === 'voice') {
            if (song === undefined) return // clip ended -> segment over
            current = null // intro/reply finished; keep racing the song
            continue
          }
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
      // /quit or shutdown while audio is live: cut the voice, stop the song.
      if (this.quit) {
        if (current !== null && !current.done()) {
          await this.deps.player.stop()
          await current.promise
        }
        if (song !== undefined) await song.stop()
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
    // The user's turn is fresh mood signal: prime the next pick around it.
    this.prefetchMusic()
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
