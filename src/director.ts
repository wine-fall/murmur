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

import { currentActivity, type Activity, type ActivitySensor } from './activity.ts'
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
  Turn,
  VoiceProvider,
} from './contracts.ts'
import type { Host } from './host.ts'
import { buildMusicSituation } from './prompts.ts'
import { currentScene } from './scene.ts'
import type { AnchorId, Scheduler } from './scheduler.ts'

const QUIT_COMMAND = '/quit'

// Bounded attempts for a Brain/synth call before it degrades (lose the beat,
// never the radio).
const ATTEMPTS = 2

// How long a started stream may take to produce real audio before the pick is
// dropped for a fresh one (spec 03-02 §3.5: confirm audio BEFORE the announce).
const STREAM_START_TIMEOUT_S = 8
const MUSIC_START_ATTEMPTS = 2

// Anti-repeat depth for the music avoid-list, read from the tier-③ ledger
// (spec 05 §3.5) — cross-session on the persistent store.
const AVOID_DEPTH = 8

// spec 04 §3.3: talk look-ahead buffer depth — pre-synthesized beats kept
// topped up so the next talk airs with no Brain/synth wait, even across music.
// A module constant, not a config knob — deepen only if measurement shows a
// remaining gap (spec 04 §6).
const TALK_LOOKAHEAD = 2

// spec 07 §3.7: behavioral shape as module constants, tunable by ear in one
// place. How much longer the gap runs in an empty room; how many segments must
// air between invites; how long an aired invite stays outstanding (segments OR
// wall-clock, whichever comes first — a song can outlast two segments).
const AWAY_GAP_FACTOR = 3
const INVITE_EVERY_N = 4
const INVITE_WINDOW_SEGMENTS = 2
const INVITE_WINDOW_MS = 90_000

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

// Proactive-and-pacing wiring (spec 07), optional as a block: without it the
// Director behaves exactly as it did before spec 07 — no presence signal in the
// pack, no anchors, no invites, no gating.
export type PacingWiring = {
  sensor: ActivitySensor
  // Absent = --no-anchors.
  scheduler?: Scheduler
  invites?: boolean // default true; false = --no-invites
  gating?: boolean // default true; false = --no-gating
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
  music?: MusicWiring
  pacing?: PacingWiring
  // Off-the-loop profile compaction (spec 05 §3.6), poked once per segment
  // boundary. Absent = disabled (stub runs, tests). The Director only pokes;
  // scheduling, single-flight, and failure posture live in the Compactor.
  compactor?: { maybeSchedule(): boolean }
}

// A look-ahead entry: the beat with its synthesis already running (spec 04
// §3.3) — consuming it awaits a usually-settled clip, never starts one.
type BufferedBeat = { beat: TalkBeat; clip: Promise<AudioClip | null> }

export class Director {
  private quit = false
  // spec 04 §3.3: pre-synthesized look-ahead beats, kept topped up to
  // TALK_LOOKAHEAD so the next talk airs warm — even across music. Discarded
  // on a talkback steer (they predate the user's turn).
  private talkAhead: BufferedBeat[] = []
  // The single in-flight refill topping the buffer back up (mirrors the
  // single-slot pendingPick). Promises cannot be cancelled, so a discarded
  // refill keeps running and the epoch guard drops its stale result.
  private talkFill: Pending<void> | null = null
  private talkEpoch = 0
  private talksSinceMusic = 0
  // spec 07: the boundary's clock and presence reading, taken once per segment
  // (§3.2) and refreshed when a typed line proves the listener is back.
  private now = new Date()
  private activity: Activity | undefined
  // The invite state machine in full (§3.5): one counter, one flag, one
  // deadline — there is deliberately nothing more, because a retry path is what
  // would make the radio needy.
  private segmentsSinceInvite = 0
  private segmentsSinceUserLine = 1
  private awaitingReply: { deadlineMs: number; segments: number } | null = null
  private slideBackDue = false
  // Single-slot music prefetch (spec 04 slice 1): the next pick resolves in the
  // background so its find-and-pull latency overlaps talk, never the boundary.
  private pendingPick: Pending<TrackPick | null> | null = null

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
      this.beginBoundary()
      const anchor = this.deps.pacing?.scheduler?.due(this.now) ?? null
      // An anchor is checked BEFORE cadence, so it always wins the boundary it
      // is due at (spec 07 §2.3).
      if (anchor !== null) {
        await this.anchorSegment(anchor)
        this.talksSinceMusic++
      } else if ((await this.wantsMusic()) && (await this.musicSegment())) {
        this.talksSinceMusic = 0
      } else {
        await this.talkSegment()
        this.talksSinceMusic++
      }
      produced++
      this.deps.compactor?.maybeSchedule() // background, single-flight
      const last = maxSegments !== undefined && produced >= maxSegments
      if (!last && !this.quit) await this.gap()
    }
  }

  // --- presence, anchors, invites (spec 07) -------------------------------- //

  // Once per boundary: read the clock and the presence signal, age the invite
  // window, and turn an expired one into a slide-back.
  private beginBoundary(): void {
    this.now = new Date()
    this.readActivity()
    this.segmentsSinceInvite++
    this.segmentsSinceUserLine++
    const outstanding = this.awaitingReply
    if (outstanding === null) return
    outstanding.segments--
    if (outstanding.segments > 0 && this.now.getTime() < outstanding.deadlineMs) return
    // Nobody answered: drop the question and slide back into the program. There
    // is no retry path — the interval counter runs from the invite that AIRED.
    this.awaitingReply = null
    this.slideBackDue = true
    this.deps.host.debug?.('invite: window expired; sliding back')
  }

  // The sensor read, honoring MURMUR_ACTIVITY (by-ear). Also taken right after
  // a typed line, so a listener who just came back is engaged immediately
  // rather than at the next boundary (§3.3 resume).
  private readActivity(): void {
    const sensor = this.deps.pacing?.sensor
    this.activity = sensor === undefined ? undefined : currentActivity(sensor, this.now)
  }

  // Talk generation pauses in an empty room (§3.3) — the two most expensive
  // things the radio does, spent on nobody. Anchors are exempt (they ARE the
  // welcome-back moment) and buffered beats are kept, never discarded.
  private gated(): boolean {
    const pacing = this.deps.pacing
    return pacing !== undefined && (pacing.gating ?? true) && this.activity === 'away'
  }

  // Whether the NEXT batch may be asked to turn to the listener — all local,
  // 0 tokens (§3.6). Re-evaluated at request time, not at air time.
  private inviteEligible(): boolean {
    const pacing = this.deps.pacing
    if (pacing === undefined || pacing.invites === false) return false
    return (
      this.activity !== 'away' &&
      this.awaitingReply === null &&
      this.segmentsSinceInvite >= INVITE_EVERY_N &&
      // They just typed — they are already engaged, so asking is redundant.
      this.segmentsSinceUserLine >= 1
    )
  }

  // The one place local policy picks a cue for an ordinary talk batch. The
  // slide-back is one-shot: asked for once, then gone.
  private talkCue(): string | undefined {
    if (this.slideBackDue) {
      this.slideBackDue = false
      return 'slide-back'
    }
    if (!this.inviteEligible()) return undefined
    // The interval restarts at REQUEST time, not at air time: an invited beat
    // sits in the look-ahead for a boundary or two before it airs, and a refill
    // in between must not queue a second one behind it (back-to-back questions
    // are exactly the pressure §3.5 exists to prevent). A model that ignores
    // the field simply costs this round's ask — the next comes at the normal
    // interval, never sooner.
    this.segmentsSinceInvite = 0
    return 'invite'
  }

  private openInviteWindow(): void {
    this.segmentsSinceInvite = 0
    this.awaitingReply = {
      deadlineMs: this.now.getTime() + INVITE_WINDOW_MS,
      segments: INVITE_WINDOW_SEGMENTS,
    }
    this.deps.host.debug?.('invite: aired; awaiting a reply')
  }

  // Every typed line funnels through here: it stamps the presence sensor, and
  // it clears any outstanding invite — the listener took the floor, so an
  // answered invite is just ordinary talkback and no slide-back is owed (§3.9).
  private takeSteer(): Steer {
    const line = this.deps.host.takeLine()!
    this.now = new Date()
    this.deps.pacing?.sensor.noteInput(this.now)
    this.readActivity()
    this.segmentsSinceUserLine = 0
    this.awaitingReply = null
    return steerFromLine(line)
  }

  // One anchor beat, inserted AHEAD of the look-ahead buffer: the buffered beat
  // airs at the following boundary, nothing is discarded or regenerated
  // (§3.4/§3.9). Ledgered at air time, so a degraded generation leaves the
  // anchor due at the next boundary instead of silently consuming the day's
  // occurrence.
  private async anchorSegment(id: AnchorId): Promise<void> {
    const [beat] = await this.generateTalks(1, [], `anchor:${id}`)
    if (beat === undefined) return
    const clip = await this.synthesizeOrSkip(beat.text)
    if (clip === null) return
    this.airBeat(beat)
    this.deps.pacing!.scheduler!.markFired(id, this.now)
    this.deps.host.debug?.(`anchor ${id} aired`)
    // Same two primings the ordinary talk path does, so an anchor does not leave
    // the next boundary cold: the music pick resolves around this beat's mood,
    // and the look-ahead (untouched by the anchor) is topped back up.
    this.prefetchMusic(beat.text)
    this.prefetchTalk()
    await this.runVoice(onAir(this.deps.player.play(clip)))
  }

  // Printed + recorded at air time, so an interjection's reply sees this
  // segment in context. The topic tag (when the model provided one) feeds the
  // cross-day anti-repeat ledger (spec 05 §3.9).
  private airBeat(beat: TalkBeat): void {
    this.deps.host.onRadioSegment(beat.text)
    this.deps.memory.record({ role: 'radio', text: beat.text })
    if (beat.topic !== undefined) this.deps.memory.recordEvent('topic', beat.topic)
  }

  // The real clock lives here; currentScene applies a MURMUR_SCENE override
  // (by-ear) over the pure, unit-tested bucketing. Profile + recent topics come
  // from the persistent store (spec 05 §3.5): profile is the stable-prefix
  // block, coveredTopics the cross-day anti-repeat cue.
  // `queued` are look-ahead beats already generated but not yet aired (spec 04
  // §3.3): appended as the host's own prior turns so a refill continues AFTER
  // them instead of regenerating the same beat — the buffered text lives here
  // in the Director, so the stateless Brain is told what is already scheduled,
  // not only what has aired and been recorded.
  private context(queued: readonly string[] = [], cue?: string): ContextPack {
    const recent = this.deps.memory.recent(this.deps.recentWindow)
    const turns: Turn[] = queued.map((text) => ({ role: 'radio', text }))
    return {
      persona: this.deps.persona,
      recent: queued.length === 0 ? recent : [...recent, ...turns],
      scene: currentScene(new Date()),
      profile: this.deps.memory.profile(),
      coveredTopics: this.deps.memory.recentTopics(this.deps.recentWindow),
      ...(this.activity !== undefined && { activity: this.activity }),
      ...(cue !== undefined && { cue }),
    }
  }

  private async talkSegment(): Promise<void> {
    const aired = await this.nextTalkClip()
    if (aired === null) return // generation/synthesis degraded; the loop keeps broadcasting
    this.airBeat(aired.beat)
    // The beat the model marked as turning to the listener (spec 07 §2.6):
    // hold the reply window open from the moment it airs.
    if (aired.beat.invite === true) this.openInviteWindow()
    // Refill AFTER recording, so the top-up's context already carries this
    // just-aired beat and its Brain+synth overlap the playback below.
    this.prefetchTalk()
    await this.runVoice(onAir(this.deps.player.play(aired.clip)))
  }

  // The next beat + clip to air. From the look-ahead buffer when primed — its
  // synth ran behind the prior audio, so the await is near-instant. Else cold:
  // one batched nextTalks, air beat 1, buffer the rest (spec 04 §3.3). An
  // in-flight refill is awaited over a cold call so the two never
  // double-generate; a refill that degraded to nothing falls through cold.
  private async nextTalkClip(): Promise<{ beat: TalkBeat; clip: AudioClip } | null> {
    // Nobody around: yield the whole boundary to music/bed (spec 07 §3.2 —
    // "music/bed only"). Checked BEFORE the buffer is touched, so pre-synthesized
    // beats are kept for the moment the listener returns rather than spent on an
    // empty room — which is what happens in a talk-only session (--no-music, or
    // a failed music preflight) where nothing else would gate this branch.
    if (this.gated()) {
      this.deps.host.debug?.('talk.gated: nobody around; yielding to music/bed')
      return null
    }
    if (this.talkAhead.length === 0 && this.talkFill !== null && !this.talkFill.done()) {
      await this.talkFill.promise
    }
    const primed = this.talkAhead.shift()
    if (primed !== undefined) {
      this.deps.host.debug?.(`talk.buffer warm depth=${this.talkAhead.length + 1}`)
      // Prime the next music pick around the airing text (mood) — it needs no
      // audio, so the find-and-pull overlaps this beat's airtime.
      this.prefetchMusic(primed.beat.text)
      const clip = await primed.clip
      return clip === null ? null : { beat: primed.beat, clip }
    }
    this.deps.host.debug?.('talk.buffer cold; batching inline')
    const beats = await this.generateTalks(TALK_LOOKAHEAD, [], this.talkCue())
    const first = beats.shift()
    if (first === undefined) return null
    this.prefetchMusic(first.text)
    // Beat 1's synth first (it airs next), the look-ahead synths right behind
    // it — all in flight together on a concurrent backend.
    const firstClip = this.synthesizeOrSkip(first.text)
    this.talkAhead = beats.map((beat) => ({ beat, clip: this.synthesizeOrSkip(beat.text) }))
    const clip = await firstClip
    return clip === null ? null : { beat: first, clip }
  }

  // spec 04 §3.3: keep the look-ahead topped up to TALK_LOOKAHEAD — fire-and-
  // forget, at most one refill in flight (mirrors prefetchMusic). Fired after
  // a consumed beat is recorded and at a music segment's start, so the buffer
  // stays full and the refill's work overlaps whatever is on air.
  private prefetchTalk(): void {
    if (this.gated()) return // no batch, no parallel synthesis, no spend (§3.3)
    if (this.talkAhead.length >= TALK_LOOKAHEAD) return
    if (this.talkFill !== null && !this.talkFill.done()) return
    this.talkFill = pending(this.fillTalk())
  }

  // Background refill of the shortfall: one batched nextTalks whose context
  // carries the queued beats (coherence), results synthesized in parallel and
  // appended, capped at the depth. Total — a failed batch just leaves the
  // buffer short and the next prefetchTalk retries.
  private async fillTalk(): Promise<void> {
    const need = TALK_LOOKAHEAD - this.talkAhead.length
    if (need <= 0) return
    const epoch = this.talkEpoch
    const queued = this.talkAhead.map((b) => b.beat.text)
    this.deps.host.debug?.(`talk.refill need=${need} queued=${queued.length}`)
    const beats = await this.generateTalks(need, queued, this.talkCue())
    // A steer discarded the buffer while the batch was in flight: its beats
    // predate the user's turn — drop them.
    if (epoch !== this.talkEpoch) return
    for (const beat of beats) {
      if (this.talkAhead.length >= TALK_LOOKAHEAD) break
      this.talkAhead.push({ beat, clip: this.synthesizeOrSkip(beat.text) })
    }
    this.deps.host.debug?.(`talk.refill got=${beats.length} depth=${this.talkAhead.length}`)
  }

  // Drop the buffered look-ahead and orphan any in-flight refill (spec 04
  // §3.3): called when a talkback steer makes them stale. The refill cannot be
  // cancelled — the epoch bump makes it discard its own result on arrival.
  private discardTalkAhead(): void {
    this.talkEpoch++
    this.talkAhead = []
    this.talkFill = null
  }

  // -- the music branch (spec 03-02 §3.5) ----------------------------------- //

  private async wantsMusic(): Promise<boolean> {
    const music = this.deps.music
    if (music === undefined) return false
    const recent = this.deps.memory.recent(this.deps.recentWindow)
    const situation = recent.map((t) => `- ${t.role}: ${t.text}`).join('\n')
    const kind = await music.cadence.nextKind({
      talksSinceMusic: this.talksSinceMusic,
      situation,
      ...(this.activity !== undefined && { activity: this.activity }),
    })
    return kind === 'music'
  }

  private musicContext(): MusicContext {
    return {
      persona: this.deps.persona,
      situation: buildMusicSituation(
        this.deps.memory.recent(this.deps.recentWindow),
        this.deps.memory.recentSongs(AVOID_DEPTH),
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
      // A song is going on air: the talk look-ahead SURVIVES it and is topped
      // up during it (spec 04 §3.3) — the song's whole duration overlaps the
      // refill's Brain+synth, so the post-song talk airs warm.
      this.prefetchTalk()
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
        // Ledger the song at air time (spec 05 §3.5): a confirmed, playing song
        // only — not a dropped candidate. Feeds the music avoid-list.
        this.deps.memory.recordEvent('song', label)
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

  // Batched generation with bounded retry; [] on ultimate failure (degrade —
  // lose the batch this round, never the radio). Serves both the cold path and
  // the background refill (spec 04 §3.3).
  private async generateTalks(
    count: number,
    queued: readonly string[] = [],
    cue?: string,
  ): Promise<TalkBeat[]> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await this.deps.brain.nextTalks(this.context(queued, cue), count)
      } catch (err) {
        if (attempt < ATTEMPTS) {
          this.deps.host.debug?.(`talk.next_talks failed (attempt ${attempt}/${ATTEMPTS}); retrying`)
        } else {
          this.deps.host.info(`talk generation failed (${String(err)}); the radio plays on.`)
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
    // Longer gaps in an empty room (spec 07 §3.2) — the stream keeps playing,
    // it just stops crowding a room nobody is in.
    const factor = this.activity === 'away' ? AWAY_GAP_FACTOR : 1
    const slept = sleep(this.deps.gapSeconds * factor * 1000, undefined, { signal: ac.signal }).then(
      () => true,
      () => false,
    )
    const line = this.deps.host.peekLine().then(() => false)
    const finished = await Promise.race([slept, line])
    if (finished) return
    ac.abort()
    await this.runVoice(null, undefined, this.takeSteer())
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
          steer = this.takeSteer()
        }
        if (steer.intent === 'quit') {
          this.quit = true
          return
        }
        this.discardTalkAhead() // buffered look-ahead predates this user turn -> stale
        const composed = await this.compose(steer.text)
        steer = null
        if (this.quit) return // a merged-in line was /quit
        if (composed === null) continue // reply degraded; keep racing current audio
        if (current !== null && !current.done()) await this.deps.player.stop()
        await current?.promise
        this.deps.host.onRadioSegment(composed.reply)
        this.deps.memory.record({ role: 'radio', text: composed.reply })
        // The steer just discarded the look-ahead: refill NOW, with the fresh
        // user turn + reply in context, so the regen overlaps the reply (and
        // any still-playing song) instead of going cold at the next boundary.
        this.prefetchTalk()
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
      const merged = this.takeSteer()
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
