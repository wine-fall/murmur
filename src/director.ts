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

import { spawn } from 'node:child_process'
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
  MusicState,
  Player,
  MemoryOps,
  SteerActions,
  SteerSettingsActions,
  SteerBrain,
  TalkBeat,
  TrackPick,
  TrackSource,
  Turn,
  VoiceProvider,
  RwtTopic,
} from './contracts.ts'
import type { Host } from './host.ts'
import { COMMANDS, type ProgramState } from './ipc.ts'
import type { ReportSession } from './report.ts'
import { INSTALL_COMMAND } from './update.ts'
import { buildMusicSituation, CODA_CUE, withLanguage } from './prompts.ts'
import { currentScene, formatClock, sceneFor } from './scene.ts'
import type { AnchorId, Scheduler } from './scheduler.ts'

// Literal, not destructured from COMMANDS: meaning must never depend on the
// list's (display) order. The type pins each literal to a COMMANDS entry, and
// the steer tests pin the reverse — every entry parses as a command.
const QUIT_COMMAND: (typeof COMMANDS)[number]['name'] = '/quit'
const SETUP_COMMAND: (typeof COMMANDS)[number]['name'] = '/setup'
const SETTINGS_COMMAND: (typeof COMMANDS)[number]['name'] = '/settings'
const BUG_COMMAND: (typeof COMMANDS)[number]['name'] = '/bug'
const FEATURE_COMMAND: (typeof COMMANDS)[number]['name'] = '/feature-request'
const UPDATE_COMMAND: (typeof COMMANDS)[number]['name'] = '/update'

// The prefilled GitHub issue forms (.github/ISSUE_TEMPLATE): the template
// itself carries the label, which is why the command points at a template
// rather than appending ?labels= — a URL label parameter is dropped for any
// submitter without triage rights.
export const BUG_FORM_URL = 'https://github.com/wine-fall/murmur/issues/new?template=bug.yml'
export const FEATURE_FORM_URL = 'https://github.com/wine-fall/murmur/issues/new?template=feature-request.yml'
const FORM_URL: Record<'bug' | 'feature', string> = { bug: BUG_FORM_URL, feature: FEATURE_FORM_URL }

// The desktop's own way to open a URL. `start` is a cmd builtin rather than an
// executable, so Windows goes through cmd explicitly — spawn's shell-plus-argv
// form is deprecated (DEP0190) and would print a warning over the TUI.
export function openerFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  // The URL is quoted because cmd re-parses its own command line and treats a
  // bare `&` as a command separator — a prefilled issue form is nothing but
  // `&`, and unquoted the browser would get only the part before the first one.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', `"${url}"`] }
  return { command: 'xdg-open', args: [url] }
}

// The desktop opener the app wires in. Exported rather than defaulted: the
// Director must never be able to reach a real browser on its own.
export function openInBrowser(url: string): void {
  const { command, args } = openerFor(process.platform, url)
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {}) // a missing opener is not a crash; the printed URL stands in
  child.unref()
}

// Bounded attempts for a Brain/synth call before it degrades (lose the beat,
// never the radio).
const ATTEMPTS = 2

// How long a started stream may take to produce real audio before the pick is
// dropped for a fresh one (spec 03-02 §3.5: confirm audio BEFORE the announce).
const STREAM_START_TIMEOUT_S = 8
const MUSIC_START_ATTEMPTS = 2

// How many recalled lines the reply turn is handed (spec 05-01 §2.5). Five is
// enough to answer "that project" and few enough to stay a memory rather than
// a transcript dump.
const RECALL_LIMIT = 5

// Anti-repeat depth for the music avoid-list, read from the tier-③ ledger
// (spec 05 §3.5) — cross-session on the persistent store. Deep enough to cover
// more than one evening: at eight, a favourite came back every other session,
// and the model's own taste already narrows hard without help. The ledger
// keeps far more than this, and the list costs one prompt line per song.
const AVOID_DEPTH = 32

// How many recent turns the music situation carries (issue #76): choosing a
// track needs the current mood, not the full talk window, and the discovery
// prompt growing with memory was the measured hot-slower-than-cold term.
const MUSIC_RECENT_TURNS = 6

// spec 04 §3.3: talk look-ahead buffer depth — pre-synthesized beats kept
// topped up so the next talk airs with no Brain/synth wait, even across music.
// A module constant, not a config knob — deepen only if measurement shows a
// remaining gap (spec 04 §6).
const TALK_LOOKAHEAD = 2

// spec 04 §3.3, by-ear (spec 03-02 §6.1 lists them): how the coda leaves.
// Half the time it rides the track's outro rather than waiting for silence —
// always doing it would make every song end the same way, never doing it leaves
// the music->talk seam a hard cut every time.
export const CODA_RIDE_P = 0.5
// How many seconds before the end the ride starts, uniform in this range: long
// enough to be talking over the fade, short enough not to sit on the song.
export const CODA_LEAD_MIN_S = 8
export const CODA_LEAD_MAX_S = 12

// spec 07 §3.7: behavioral shape as a module constant, tunable by ear in one
// place. How much longer the gap runs in an empty room.
const AWAY_GAP_FACTOR = 3

// The beat airing while the next pick is chosen, labeled for the pick task: the
// announce is asked to pick up whatever thread this line leaves, so it has to
// arrive as that line and not as one more transcript row (spec 03-02 §1 #6).
// "as this song was chosen", not "just before it": a prefetched pick is fired
// one talk beat (or more) ahead of the boundary that airs it (spec 04 §3.1),
// and a label that overclaimed would have the announce hand over from a line
// the listener heard two beats ago.
function priorLine(text: string): string {
  return `The line on air as this song was chosen: "${text}"`
}

export type Steer =
  | { intent: 'quit' }
  | { intent: 'settings' }
  | { intent: 'setup' }
  | { intent: 'bug' }
  | { intent: 'feature' }
  | { intent: 'update' }
  | { intent: 'talkback'; text: string }
  // A line the report floor took (§3.2-C): steerFromLine never returns this —
  // takeSteer does, for a line it handed to a flow that owns the keyboard. The
  // loop it came from just keeps going.
  | { intent: 'consumed' }

export function steerFromLine(line: string): Steer {
  const trimmed = line.trim()
  if (trimmed === QUIT_COMMAND) return { intent: 'quit' }
  if (trimmed === SETTINGS_COMMAND) return { intent: 'settings' }
  if (trimmed === SETUP_COMMAND) return { intent: 'setup' }
  if (trimmed === BUG_COMMAND) return { intent: 'bug' }
  if (trimmed === FEATURE_COMMAND) return { intent: 'feature' }
  if (trimmed === UPDATE_COMMAND) return { intent: 'update' }
  return { intent: 'talkback', text: line }
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
// pack, no anchors, no gating.
export type PacingWiring = {
  sensor: ActivitySensor
  // Absent = --no-anchors.
  scheduler?: Scheduler
  gating?: boolean // default true; false = --no-gating
}

// The live knobs the loop consults per decision (spec 12 §3.2): a thunk rather
// than captured scalars, so a settings change lands at the next boundary with
// no reconstruction. The SettingsStore's current() satisfies it directly.
export type DirectorSettings = {
  gapSeconds: number
  recentWindow: number
  anchorsEnabled: boolean
  musicEnabled: boolean
  // Whether an ordinary talk batch may be offered real-world material (spec
  // 13 §2.6); read live at each batch, so "stop with the news" lands at once.
  rwtEnabled: boolean
  // Absent = the persona decides (spec 12 §3.9). Read live like every other
  // knob here, so a change lands on the next beat with no restart.
  language?: string | undefined
}

export type DirectorDeps = {
  persona: string
  brain: Brain
  voice: VoiceProvider
  player: Player
  memory: MemoryStore
  host: Host
  settings: () => DirectorSettings
  // The mutable side of the same layer, handed to the reply turn's
  // change_settings tool (spec 12 §2.6). Absent = the tool is not offered.
  settingsStore?: SteerSettingsActions
  music?: MusicWiring
  pacing?: PacingWiring
  // The agentic reply turn (spec 11): preferred over brain.respond when
  // present; absent on stub runs (the harness behind it is the real SDK).
  steer?: SteerBrain
  // The persistent memory tier (spec 05-01 §2.2): what recall_memory and
  // forget_memory act through, and where a steered turn is flagged. Absent =
  // neither tool is offered — a stub run has nothing on record to search.
  memoryOps?: MemoryOps
  // Off-the-loop profile compaction (spec 05 §3.6), poked once per segment
  // boundary. Absent = disabled (stub runs, tests). The Director only pokes;
  // scheduling, single-flight, and failure posture live in the Compactor.
  compactor?: { maybeSchedule(): boolean }
  // Real-world material (spec 13 §2.4): one synchronous offer per ordinary
  // talk batch, and a refresh poked at every boundary that runs off the loop
  // like the compactor's fold. Absent = never offered (stub runs, tests).
  rwt?: { offer(): RwtTopic | null; maybeRefresh(): boolean }
  // The mid-broadcast recall (spec 10 §3.4): a typed /setup parks the talk
  // loop inside this call — the engine keeps playing — and the loop resumes
  // when it returns. Absent (stub runs): /setup answers with the shell pointer.
  setupRecall?: () => Promise<void>
  // How /bug and /feature-request reach a browser (spec 10 §3.2-C). Required,
  // with no fallback behind it: every construction site must say which opener
  // it means, because a spawned browser is invisible from in here — spawn's
  // error is swallowed, so a wrong default would fail silently. The type is
  // the guard.
  openUrl: (url: string) => void
  // The report floor (§3.2-C): a feedback command opens a short conversation
  // that leaves a draft on disk. UNLIKE setupRecall this is never awaited — the
  // program keeps going while it runs, and the Director only routes the
  // keyboard to it. Absent: the commands fall back to the browser form.
  reportRecall?: (kind: 'bug' | 'feature') => ReportSession
  // The /update command (spec 10 §3.2-C): check npm for a newer murmur and
  // install it. Like reportRecall this is never awaited — npm takes as long as
  // it takes and the program owes the listener its air throughout — but unlike
  // it, nothing changes hands: the check only narrates through host.info.
  // Absent (stub runs, tests): the command hands over the shell one-liner.
  updateRecall?: () => Promise<void>
  // An auth-shaped voice failure, raised so the app can mark the endpoint as
  // failing — detectGaps then treats the configured endpoint as a gap (#97).
  onVoiceAuthFailure?: () => void
  // The one place chance enters the loop: whether the coda rides a track's
  // outro, and how far before the end (spec 04 §3.3). Injectable so a test can
  // pin both; Math.random otherwise.
  random?: () => number
}

// A look-ahead entry: the beat with its synthesis already running (spec 04
// §3.3) — consuming it awaits a usually-settled clip, never starts one.
type BufferedBeat = { beat: TalkBeat; clip: Promise<AudioClip | null> }

export class Director {
  private quit = false
  // A racer for the quit flag. `/quit` arrives as a typed line and so already
  // wins runVoice's race; Ctrl-C arrives as a signal and had nothing to win
  // with, which left shutdown waiting out the rest of the song (spec 01 §3.6:
  // Ctrl-C stops playback). Resolving this wakes that wait immediately.
  private wakeOnQuit!: () => void
  private quitting = new Promise<'quit'>((resolve) => {
    this.wakeOnQuit = () => resolve('quit')
  })
  // spec 04 §3.3: pre-synthesized look-ahead beats, kept topped up to
  // TALK_LOOKAHEAD so the next talk airs warm — even across music. Discarded
  // on a talkback steer (they predate the user's turn).
  private talkAhead: BufferedBeat[] = []
  // The single in-flight refill topping the buffer back up (mirrors the
  // single-slot pendingPick). Promises cannot be cancelled, so a discarded
  // refill keeps running and the epoch guard drops its stale result.
  private talkFill: Pending<void> | null = null
  private talkEpoch = 0
  // spec 04 §3.3: the beat that answers the song currently on air, generated at
  // its start. Kept OUT of talkAhead so the look-ahead's depth invariant is
  // untouched — it either rides the track's outro or goes to the head of the
  // queue when the track ends, and is dropped by a steer like any other beat
  // written before the listener spoke.
  private coda: { beat: TalkBeat; clip: AudioClip } | null = null
  private codaEpoch = 0
  private talksSinceMusic = 0
  // spec 07: the boundary's clock and presence reading, taken once per segment
  // (§3.2) and refreshed when a typed line proves the listener is back.
  private now = new Date()
  private activity: Activity | undefined
  // The segment the front-end is currently showing (spec 10 §2.1). A music
  // segment carries the track's length and the moment it went on air, which is
  // what makes the strip's progress bar the front-end's own arithmetic.
  private segment: ProgramState = { kind: 'gap' }
  // Single-slot music prefetch (spec 04 slice 1): the next pick resolves in the
  // background so its find-and-pull latency overlaps talk, never the boundary.
  private pendingPick: Pending<TrackPick | null> | null = null
  // The steer-task state (spec 11): a due switch hands the air over when the
  // fresh pick resolves (or owns the next boundary when no track is live);
  // pickPredatesTurn tells a hinted switch whether the primed pick is stale.
  private switchDue = false
  private pickPredatesTurn = false
  // Two-phase shutdown (spec 11 §2.1): armed survives across steer tasks;
  // steerEndCalled tracks whether the task that just ran touched end_broadcast
  // (a task that did not disarms); quitAfterReply defers the confirmed close
  // until the sign-off reply has aired.
  private shutdownArmed = false
  private steerEndCalled = false
  // How many listener lines the turn being composed merged (spec 05-01 §3.5):
  // all of them are the asking when the reply forgets something.
  private pendingUserLines = 1
  private quitAfterReply = false
  // A merged reply discards its in-flight steer task, but the task cannot be
  // cancelled — the epoch makes the orphan's late tool calls dead instead of
  // letting them mutate live state (mirrors talkEpoch).
  private steerEpoch = 0
  // The track currently on air, for the steer tools' playing() — runVoice owns
  // its lifetime.
  private liveSong: MusicHandle | null = null
  // The prompt's music grounding (spec 04 bugfix): the last track that aired,
  // and whether the latest pick came back empty — together with the segment
  // and the pick slot they derive the pack's real music status.
  private lastTrack: string | null = null
  private pickFailed = false
  // A dropped pick's promise cannot be cancelled (the switch_music re-prime);
  // the epoch keeps its late resolution from repainting pickFailed after a
  // fresher search already spoke (mirrors talkEpoch).
  private pickEpoch = 0

  private deps: DirectorDeps

  constructor(deps: DirectorDeps) {
    this.deps = deps
  }

  // Orderly-stop entry for signal handlers (Ctrl-C): the loop notices after
  // the current await settles; a playing clip is cut in runVoice's exit path.
  requestQuit(): void {
    this.beginQuit()
    this.wakeOnQuit()
  }

  // The /setup recall: park the loop in the app's setup conversation while
  // whatever is on the air plays out (the record keeps spinning — boundary
  // decision Q6). Single-flight: while a session runs, the guide owns the
  // keyboard and a second /setup would be its reply, not a command.
  private inSetup = false
  private async recallSetup(): Promise<void> {
    if (this.deps.setupRecall === undefined) {
      this.deps.host.info('the setup guide needs the real brain — run `murmur --setup` from a shell.')
      return
    }
    if (this.inSetup) return
    this.inSetup = true
    try {
      await this.deps.setupRecall()
    } finally {
      this.inSetup = false
    }
  }

  // A feedback command (spec 10 §3.2-C): open the prefilled form, and print
  // the URL either way — over ssh, or with a dead opener, the printed line is
  // the whole affordance.
  private openIssueForm(kind: 'bug' | 'feature'): void {
    const url = FORM_URL[kind]
    try {
      this.deps.openUrl(url)
    } catch {
      // silent: the info line below is the fallback
    }
    this.deps.host.info(`file it at ${url}`)
  }

  // Every way a quit begins routes through here, so the listener hears the
  // acknowledgment the moment the quit is HEARD — the teardown that follows
  // (voice close, engine drain, bed position) is honest work, but doing it in
  // silence read as a hang (user report).
  private beginQuit(): void {
    if (!this.quit) this.deps.host.info('going off the air...', 'flow')
    this.quit = true
    // A report waiting on a prompt has nobody left to answer it: end it here
    // rather than leave its read — and whatever the model still holds open —
    // pending behind a listener who has gone.
    this.report?.cancel()
    this.report = null
  }

  async run(maxSegments?: number): Promise<void> {
    this.deps.host.start()
    // Prime the first pick immediately (issue #76): discovery is the measured
    // dominant first-music term and is independent of the cold talk batch —
    // serializing them cost the first song a ~25-35s head start. The persona
    // (plus any prior-session ledger) is enough to choose by; staleness is
    // the accepted spec 04 §3.1 trade.
    this.prefetchMusic()
    let produced = 0
    while (!this.quit && (maxSegments === undefined || produced < maxSegments)) {
      this.beginBoundary()
      // The scheduler stays constructed; the live flag decides at the fire
      // site (spec 12 §3.2), so an anchors toggle needs no restart.
      const anchor = this.deps.settings().anchorsEnabled
        ? (this.deps.pacing?.scheduler?.due(this.now) ?? null)
        : null
      // An anchor is checked BEFORE cadence, so it always wins the boundary it
      // is due at (spec 07 §2.3).
      if (anchor !== null) {
        await this.anchorSegment(anchor)
        this.talksSinceMusic++
      } else if ((await this.wantsMusic()) && (await this.musicSegment())) {
        this.talksSinceMusic = 0
      } else if (!this.quit) {
        // A quit that won inside music prep reads as "music failed" to this
        // branch — it must not buy one more talk segment (codex review).
        await this.talkSegment()
        this.talksSinceMusic++
      }
      produced++
      this.deps.compactor?.maybeSchedule() // background, single-flight
      const last = maxSegments !== undefined && produced >= maxSegments
      if (!last && !this.quit) await this.gap()
    }
  }

  // --- presence, anchors (spec 07) ----------------------------------------- //

  // Once per boundary: read the clock and the presence signal.
  private beginBoundary(): void {
    this.now = new Date()
    this.readActivity()
    this.deps.rwt?.maybeRefresh() // background, single-flight
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

  // Every typed line funnels through here: it stamps the presence sensor and
  // refreshes the presence reading — the listener just proved they are back.
  private takeSteer(): Steer {
    const line = this.deps.host.takeLine()!
    this.now = new Date()
    this.deps.pacing?.sensor.noteInput(this.now)
    this.readActivity()
    this.restate()
    const steer = steerFromLine(line)
    // While a report is being written every line is its material: there is no
    // way to tell a bug description from talk-back, so the floor that asked
    // for the words gets them. /quit is the one exception — a listener must
    // always be able to leave.
    if (this.report !== null && steer.intent !== 'quit') {
      this.report.deliver(line)
      return { intent: 'consumed' }
    }
    return steer
  }

  // The open report floor (§3.2-C), or null when the radio has the keyboard.
  private report: ReportSession | null = null

  // A feedback command. The floor runs ALONGSIDE the program — nothing here is
  // awaited — because writing a report changes nothing about the run; only the
  // keyboard changes hands. Single-flight: a second /bug while one is open is
  // already that report's material and never reaches this.
  private openReport(kind: 'bug' | 'feature'): void {
    const start = this.deps.reportRecall
    if (start === undefined) {
      this.openIssueForm(kind)
      return
    }
    const session = start(kind)
    this.report = session
    void session.done.then(
      () => (this.report = null),
      () => (this.report = null),
    )
  }

  // Single-flight, for the same reason the report floor is: a listener who
  // types /update twice while npm is running means "is it working", not "run
  // two installs over each other".
  private updating = false

  // The /update side-errand. Never awaited (npm is slow and the program keeps
  // going), and total — runUpdate narrates its own failures.
  private startUpdate(): void {
    const start = this.deps.updateRecall
    if (start === undefined) {
      this.deps.host.info(`this run updates with \`${INSTALL_COMMAND}\`.`)
      return
    }
    if (this.updating) return
    this.updating = true
    void start().then(
      () => (this.updating = false),
      () => (this.updating = false),
    )
  }

  // Commands are commands, not conversation: they must never wait out a
  // compose or a spinning stream (user report — a /quit typed while a pick was
  // resolving sat unread for its whole tail). Every line-blind segment-prep
  // await runs through here: /quit (typed or Ctrl-C's requestQuit) wins the
  // race and stops the loop, /settings shows the pane and keeps waiting, and a
  // talk-back line stays QUEUED — the on-air race owns it, exactly as before.
  // Null = quit won (this.quit is set); callers bail without touching the air.
  private async steerable<T>(work: Promise<T>): Promise<T | null> {
    // Rejection rides as a value so an abandoned racer can never become an
    // unhandled rejection; it rethrows only when the work actually wins.
    const tagged = work.then(
      (value) => ({ kind: 'work' as const, value }),
      (err: unknown) => ({ kind: 'fail' as const, err }),
    )
    while (true) {
      const winner = await Promise.race([
        tagged,
        this.deps.host.peekLine().then((line) => ({ kind: 'line' as const, line })),
        this.quitting.then(() => ({ kind: 'quit' as const })),
      ])
      if (winner.kind === 'fail') throw winner.err
      if (winner.kind === 'work') return winner.value
      if (winner.kind === 'quit') {
        this.quit = true
        return null
      }
      const intent = steerFromLine(winner.line).intent
      // A talkback line waits for the on-air race — unless a report holds the
      // keyboard, in which case it is a sentence of the description and has no
      // business sitting behind a synth.
      if (intent === 'talkback' && this.report === null) return work // queued for the on-air race
      const steer = this.takeSteer()
      if (steer.intent === 'quit') {
        this.beginQuit()
        return null
      }
      if (steer.intent === 'setup') {
        await this.recallSetup()
        if (this.quit) return null // a /quit landed inside the conversation
        continue
      }
      if (steer.intent === 'bug' || steer.intent === 'feature') {
        this.openReport(steer.intent)
        continue
      }
      if (steer.intent === 'update') {
        this.startUpdate()
        continue
      }
      if (steer.intent === 'consumed') continue
      if (this.deps.host.showSettings !== undefined) this.deps.host.showSettings()
      else this.deps.host.info('settings live in settings.json under the murmur home.')
    }
  }

  // One anchor beat, inserted AHEAD of the look-ahead buffer: the buffered beat
  // airs at the following boundary, nothing is discarded or regenerated
  // (§3.4/§3.9). Ledgered at air time, so a degraded generation leaves the
  // anchor due at the next boundary instead of silently consuming the day's
  // occurrence.
  private async anchorSegment(id: AnchorId): Promise<void> {
    const prepared = await this.steerable(
      (async () => {
        const [beat] = await this.generateTalks(1, [], `anchor:${id}`)
        if (beat === undefined) return null
        const clip = await this.synthesizeOrSkip(beat.text)
        return clip === null ? null : { beat, clip }
      })(),
    )
    if (prepared === null) return
    const { beat, clip } = prepared
    this.airBeat(beat)
    this.deps.pacing!.scheduler!.markFired(id, this.now)
    this.deps.host.debug?.(`anchor ${id} aired`)
    // Same two primings the ordinary talk path does, so an anchor does not leave
    // the next boundary cold: the music pick resolves around this beat's mood,
    // and the look-ahead (untouched by the anchor) is topped back up.
    this.prefetchMusic(priorLine(beat.text))
    this.prefetchTalk()
    await this.runVoice(onAir(this.deps.player.play(clip)))
  }

  // Printed + recorded at air time, so an interjection's reply sees this
  // segment in context. The topic tag (when the model provided one) feeds the
  // cross-day anti-repeat ledger (spec 05 §3.9).
  private airBeat(beat: TalkBeat): void {
    this.recordBeat(beat)
    this.emitState('talk')
  }

  // Everything airing a beat means EXCEPT claiming the segment: a coda riding a
  // track's outro (spec 04 §3.3) is spoken over a song that is still playing,
  // so the front-end must keep naming the track — same reason the reply path
  // does not emitState('talk') either.
  private recordBeat(beat: TalkBeat): void {
    this.deps.host.onRadioSegment(beat.text)
    this.deps.memory.record({ role: 'radio', text: beat.text })
    if (beat.topic !== undefined) this.deps.memory.recordEvent('topic', beat.topic)
  }

  // What the program is doing, for a front-end with a status region (spec 10
  // §2.1). Pushed at the boundaries that already exist — no timer, no polling,
  // and nothing here changes what the radio does.
  private emitState(kind: ProgramState['kind'], track?: { label: string; durationS?: number }): void {
    this.segment = {
      kind,
      ...(track !== undefined && {
        nowPlaying: track.label,
        // Stamped here, once, where the track actually goes on air — restate()
        // below re-sends this same origin rather than minting a new one.
        startedAt: Date.now(),
        ...(track.durationS !== undefined && { durationS: track.durationS }),
      }),
    }
    this.restate()
  }

  // Re-announce the CURRENT segment because something around it moved (a typed
  // line refreshed presence). Deliberately not emitState('talk'): a reply
  // during a song is ducked over it, so the track has to stay named.
  private restate(): void {
    this.deps.host.onState?.({
      ...this.segment,
      scene: currentScene(this.now),
      ...(this.activity !== undefined && { activity: this.activity }),
    })
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
  private context(
    queued: readonly string[] = [],
    cue?: string,
    rwt?: ContextPack['rwt'],
  ): ContextPack {
    const window = this.deps.settings().recentWindow
    const recent = this.deps.memory.recent(window)
    const turns: Turn[] = queued.map((text) => ({ role: 'radio', text }))
    const now = new Date()
    const music = this.musicState()
    const scene = currentScene(now)
    return {
      persona: this.persona(),
      recent: queued.length === 0 ? recent : [...recent, ...turns],
      scene,
      // A forced MURMUR_SCENE would contradict the real clock; the audition
      // wins and the clock line is dropped (codex review).
      ...(scene === sceneFor(now) && { time: formatClock(now) }),
      ...(music !== undefined && { music }),
      profile: this.deps.memory.profile(),
      coveredTopics: this.deps.memory.recentTopics(window),
      ...(this.activity !== undefined && { activity: this.activity }),
      ...(cue !== undefined && { cue }),
      ...(rwt !== undefined && { rwt }),
    }
  }

  // The pack's real music status (spec 04 bugfix), most-live fact first: a
  // track on air, a pick still resolving, the last pick's empty result, the
  // last track that aired. Undefined when music is not wired (renders nothing).
  private musicState(): MusicState | undefined {
    if (this.deps.music === undefined) return undefined
    if (this.segment.kind === 'music' && this.segment.nowPlaying !== undefined) {
      return { kind: 'playing', track: this.segment.nowPlaying }
    }
    if (this.pendingPick !== null && !this.pendingPick.done()) return { kind: 'picking' }
    if (this.pickFailed) return { kind: 'pickFailed' }
    return { kind: 'quiet', ...(this.lastTrack !== null && { lastTrack: this.lastTrack }) }
  }

  private async talkSegment(): Promise<void> {
    const aired = await this.steerable(this.nextTalkClip())
    if (aired === null) return // quit won, or generation/synthesis degraded; the loop decides
    this.airBeat(aired.beat)
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
      this.prefetchMusic(priorLine(primed.beat.text))
      const clip = await primed.clip
      return clip === null ? null : { beat: primed.beat, clip }
    }
    this.deps.host.debug?.('talk.buffer cold; batching inline')
    const beats = await this.generateTalks(TALK_LOOKAHEAD)
    const first = beats.shift()
    if (first === undefined) return null
    this.prefetchMusic(priorLine(first.text))
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
    const beats = await this.generateTalks(need, queued)
    // A steer discarded the buffer while the batch was in flight: its beats
    // predate the user's turn — drop them.
    if (epoch !== this.talkEpoch) return
    for (const beat of beats) {
      if (this.talkAhead.length >= TALK_LOOKAHEAD) break
      this.talkAhead.push({ beat, clip: this.synthesizeOrSkip(beat.text) })
    }
    this.deps.host.debug?.(`talk.refill got=${beats.length} depth=${this.talkAhead.length}`)
  }

  // The voice provider just changed under the delegate (spec 10 §3.4): every
  // buffered clip was synthesized — and stored — by the OLD provider, whose
  // close may remove its temp clips. Drop them; the refill re-synthesizes.
  invalidateTalkAhead(): void {
    this.discardTalkAhead()
  }

  // Drop the buffered look-ahead and orphan any in-flight refill (spec 04
  // §3.3): called when a talkback steer makes them stale. The refill cannot be
  // cancelled — the epoch bump makes it discard its own result on arrival.
  private discardTalkAhead(): void {
    this.talkEpoch++
    this.codaEpoch++
    this.talkAhead = []
    this.talkFill = null
    this.coda = null
  }

  // -- the coda: the way out of a song (spec 04 §3.3) ----------------------- //

  // One beat per track, fired once the song is confirmed on air and its intro
  // is in context. Fire-and-forget and epoch-guarded at both ends: a steer
  // drops it (it predates the listener's turn), and a newer track's coda always
  // wins over an older one still in flight.
  private prefetchCoda(): void {
    if (this.gated()) return
    const epoch = ++this.codaEpoch
    // The slot belongs to the track on air: a previous track's coda must never
    // be left in it to be spoken after a different song.
    this.coda = null
    void (async () => {
      // No queued beats in the context: unlike a look-ahead refill, the coda
      // airs BEFORE whatever is buffered, so handing it those beats as prior
      // turns would have it continue speech the listener has not heard yet.
      const [beat] = await this.generateTalks(1, [], CODA_CUE)
      if (beat === undefined || epoch !== this.codaEpoch) return
      const clip = await this.synthesizeOrSkip(beat.text)
      if (clip === null || epoch !== this.codaEpoch) return
      // Stored only once it is a beat that can go on air THIS instant: the slot
      // never holds a promise, so neither exit can ever wait on synthesis.
      this.coda = { beat, clip }
      this.deps.host.debug?.('coda ready')
    })()
  }

  // The song ended without the coda riding its outro: it goes to the HEAD of
  // the look-ahead, so the next talk segment is the one that knows the song
  // happened rather than a beat written before it existed. This can briefly
  // hold TALK_LOOKAHEAD + 1 — prefetchTalk's `>=` simply does not refill until
  // it drains.
  private queueCoda(): void {
    const coda = this.coda
    if (coda === null) return
    this.coda = null
    this.talkAhead.unshift({ beat: coda.beat, clip: Promise.resolve(coda.clip) })
    this.deps.host.debug?.(`coda queued depth=${this.talkAhead.length}`)
  }

  // Arm the outro ride for the track now on air: a timer that resolves at the
  // moment the coda should start talking over the tail. Null = not riding this
  // one (the length is unknown, the coin missed, or the track is already
  // shorter than the lead) — the coda then leaves through queueCoda instead.
  private armCodaRide(): Promise<'coda'> | null {
    const { durationS, startedAt } = this.segment
    if (durationS === undefined || startedAt === undefined) return null
    const random = this.deps.random ?? Math.random
    if (random() >= CODA_RIDE_P) return null
    const lead = CODA_LEAD_MIN_S + random() * (CODA_LEAD_MAX_S - CODA_LEAD_MIN_S)
    const at = durationS - lead - (Date.now() - startedAt) / 1000
    if (at <= 0) return null
    // Unref'd: a song that ends first leaves this timer unobserved, and it must
    // not hold the process open on its own.
    return sleep(at * 1000, 'coda' as const, { ref: false })
  }

  // The coda, if there is one to go out over the outro RIGHT NOW. Null = not
  // generated (or not synthesized) yet — the ride is lost and the beat leaves
  // through the post-song path, or not at all.
  private takeCoda(): { beat: TalkBeat; clip: AudioClip } | null {
    const coda = this.coda
    if (coda === null) return null
    this.coda = null
    return coda
  }

  // -- the music branch (spec 03-02 §3.5) ----------------------------------- //

  private async wantsMusic(): Promise<boolean> {
    const music = this.deps.music
    if (music === undefined) return false
    // The live off switch (spec 12 §3.2): pure talk radio from the very next
    // boundary — checked ahead of a due switch, because a listener who turned
    // music off outranks their own earlier request for a different song.
    if (!this.deps.settings().musicEnabled) return false
    // A due switch owns the boundary (spec 11 §2.3): the listener asked, so the
    // cadence policy is bypassed until a track airs or the pick comes back empty.
    if (this.switchDue) return true
    const recent = this.deps.memory.recent(this.deps.settings().recentWindow)
    const situation = recent.map((t) => `- ${t.role}: ${t.text}`).join('\n')
    const kind = await music.cadence.nextKind({
      talksSinceMusic: this.talksSinceMusic,
      situation,
      ...(this.activity !== undefined && { activity: this.activity }),
    })
    return kind === 'music'
  }

  // The persona as the model receives it: the file's text plus the listener's
  // language override when they set one (spec 12 §3.9). Composed per read, not
  // captured, so the knob is hot.
  private persona(): string {
    return withLanguage(this.deps.persona, this.deps.settings().language)
  }

  private musicContext(): MusicContext {
    return {
      persona: this.persona(),
      situation: buildMusicSituation(
        this.deps.memory.recent(Math.min(MUSIC_RECENT_TURNS, this.deps.settings().recentWindow)),
        this.deps.memory.recentSongs(AVOID_DEPTH),
      ),
    }
  }

  // `extraLine` is a pre-rendered situation line (the airing beat, or a
  // listener request from switch_music).
  private prefetchMusic(extraLine?: string): void {
    const music = this.deps.music
    if (music === undefined || this.pendingPick !== null) return
    // The live off switch gates the SPEND, not just the airtime (spec 12 §3.2):
    // a disabled session must not pay discovery calls it will never play.
    if (!this.deps.settings().musicEnabled) return
    const base = this.musicContext()
    const ctx =
      extraLine === undefined ? base : { ...base, situation: `${base.situation}\n${extraLine}` }
    // A failed prefetch degrades like an empty pick at the boundary. One
    // two-handler then (not catch-then-then): the resolution stamps pickFailed
    // so the prompt's music status tracks the latest search's real outcome
    // (spec 04 bugfix) without deepening the chain the boundary races against.
    // Epoch-guarded: only the newest search may write.
    const epoch = ++this.pickEpoch
    this.pendingPick = pending(
      music.source.nextTrack(ctx).then(
        (pick) => {
          if (epoch === this.pickEpoch) this.pickFailed = pick === null
          return pick
        },
        () => {
          if (epoch === this.pickEpoch) this.pickFailed = true
          return null
        },
      ),
    )
  }

  // spec 11 §2.1: the listener asked for different music. A hinted request must
  // not air a pick primed before it — the stale slot is dropped (the abandoned
  // promise resolves unobserved) and a fresh one primed with the request riding
  // the situation. The due switch then hands the air over on resolve, or owns
  // the next boundary when no track is live.
  private switchMusic(hint?: string): void {
    if (hint !== undefined && this.pickPredatesTurn) this.pendingPick = null
    this.prefetchMusic(hint === undefined ? undefined : `- listener request: ${hint}`)
    this.switchDue = true
    this.deps.host.debug?.('music.switch due')
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
    // Never block the air on a pick still resolving: air talk instead and
    // re-attempt music at the next boundary while it keeps resolving.
    if (this.pendingPick !== null && !this.pendingPick.done()) return false
    try {
      // A song is going on air: the talk look-ahead SURVIVES it and is topped
      // up during it (spec 04 §3.3) — the song's whole duration overlaps the
      // refill's Brain+synth, so the post-song talk airs warm.
      this.prefetchTalk()
      for (let attempt = 0; attempt < MUSIC_START_ATTEMPTS && !this.quit; attempt++) {
        const pick = await this.steerable(this.takePick())
        if (this.quit) return false
        if (pick === null) {
          this.pickFailed = true
          if (this.switchDue) {
            this.switchDue = false
            this.deps.host.debug?.('music.switch failed')
          }
          this.deps.host.info('music: nothing suitable found; back to talk.')
          return false
        }
        const started = await this.steerableStart(pick)
        if (this.quit) return false
        if (started === null) continue
        this.switchDue = false
        await this.runVoice(started.voice, started.handle)
        this.noteTrackEnd()
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

  // What the dev log needs to answer "did that song finish?" — the two numbers
  // are otherwise unrecoverable, since a stream that dies mid-track ends the
  // segment exactly like a natural end. Sited after runVoice so /quit is
  // reported too; a mid-segment swap reports whichever track it left on air.
  private noteTrackEnd(): void {
    const { nowPlaying, startedAt, durationS } = this.segment
    if (nowPlaying === undefined || startedAt === undefined) return
    this.lastTrack = nowPlaying
    const played = Math.round((Date.now() - startedAt) / 1000)
    const expected = durationS === undefined ? 'unknown' : `${durationS}s`
    this.deps.host.debug?.(`music.end ${JSON.stringify(nowPlaying)} played=${played}s expected=${expected}`)
  }

  // startTrack raced against the keyboard. When quit wins mid-start, the
  // abandoned start cannot be cancelled — a live track (and its announce clip)
  // may still land after the loop is gone, so it is cut on arrival.
  private async steerableStart(pick: TrackPick): Promise<{ handle: MusicHandle; voice: OnAir | null } | null> {
    const starting = this.startTrack(pick)
    const started = await this.steerable(starting)
    if (this.quit) {
      void starting
        .then(async (s) => {
          if (s !== null) {
            await this.deps.player.stop()
            await s.handle.stop()
          }
        })
        .catch(() => {})
    }
    return started
  }

  // Start a pick on the engine and confirm real audio before anything is said
  // about it (spec 03-02 §3.5): the intro synthesizes WHILE the stream spins
  // up, but the announce commits only once audio is confirmed — the narration
  // must never claim a song that turns out silent. Null = the stream never
  // produced audio; the pick is spent (a previous track, if any, was already
  // cut by the engine's single-music playMusic).
  private async startTrack(pick: TrackPick): Promise<{ handle: MusicHandle; voice: OnAir | null } | null> {
    const music = this.deps.music!
    const handle = await music.engine.playMusic(pick.clip)
    const announced = pick.announce === undefined ? null : this.synthesizeOrSkip(pick.announce)
    // The head of the track is born ducked when something is about to be said
    // over it (spec 03-02 §1 #6): a song that comes up at full volume and is
    // shoved down 0.3s later is the edge the ear hears. play()'s own scheduled
    // unduck lifts it slowly when the announce ends.
    if (announced !== null) handle.duck()
    // A quit typed while the stream spun up: the start is void — no announce,
    // no "now playing", no ledger entry for a song nobody heard (codex review).
    if (!(await handle.waitStarted(STREAM_START_TIMEOUT_S)) || this.quit) {
      await announced?.then(
        () => {},
        () => {},
      )
      await handle.stop()
      return null
    }
    const label = pick.artist === undefined ? (pick.title ?? 'music') : `${pick.title ?? 'music'} — ${pick.artist}`
    this.pickFailed = false
    this.deps.host.info(`now playing: ${label}`)
    this.emitState('music', {
      label,
      ...(pick.clip.durationS !== undefined && { durationS: pick.clip.durationS }),
    })
    // Ledger the song at air time (spec 05 §3.5): a confirmed, playing song
    // only — not a dropped candidate. Feeds the music avoid-list.
    this.deps.memory.recordEvent('song', label)
    let voice: OnAir | null = null
    const announceClip = announced === null ? null : await announced
    if (pick.announce !== undefined && announceClip !== null) {
      this.deps.host.onRadioSegment(pick.announce)
      this.deps.memory.record({ role: 'radio', text: pick.announce })
      voice = onAir(this.deps.player.play(announceClip))
    } else {
      // Nothing will speak over this head, so nothing will schedule its lift:
      // an unsynthesized announce (or a handle born ducked under a still-airing
      // clip) would otherwise leave the whole song at the duck target.
      handle.unduck()
    }
    // The way out of this song is written now, while it plays: the beat that
    // airs after it (or over its outro) is the one that knows it happened.
    this.prefetchCoda()
    return { handle, voice }
  }

  // The mid-segment swap (spec 11 §2.3): the switch's fresh pick landed while a
  // track is on air. Null = nothing changed (the pick came back empty; the old
  // track plays on). Otherwise the engine's playMusic already cut the old track
  // — `handle` is the new one, or undefined when the new stream died after the
  // cut (rare; the segment continues voice-only and ends at the boundary).
  private async handoverTrack(): Promise<{ handle?: MusicHandle; voice: OnAir | null } | null> {
    const pick = await this.steerable(this.takePick())
    this.switchDue = false
    if (this.quit) return null // runVoice's loop exits; its finally cuts the air
    if (pick === null) {
      this.deps.host.debug?.('music.switch failed')
      return null
    }
    const started = await this.steerableStart(pick)
    if (this.quit) return null
    if (started === null) {
      this.deps.host.debug?.('music.switch failed')
      return { voice: null }
    }
    this.deps.host.debug?.('music.switch handover')
    return started
  }

  // Batched generation with bounded retry; [] on ultimate failure (degrade —
  // lose the batch this round, never the radio). Serves both the cold path and
  // the background refill (spec 04 §3.3).
  private async generateTalks(
    count: number,
    queued: readonly string[] = [],
    cue?: string,
  ): Promise<TalkBeat[]> {
    // One roll per batch, before the retry loop: a retried batch is the same
    // batch, not a second chance at a topic. Anchors and the coda have a job
    // of their own and are never offered one (spec 13 §2.4).
    const offered = cue === undefined && this.deps.settings().rwtEnabled ? this.deps.rwt?.offer() : undefined
    const rwt = offered == null ? undefined : { title: offered.title, gist: offered.gist }
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await this.deps.brain.nextTalks(this.context(queued, cue, rwt), count)
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

  // An auth-shaped voice failure names the way back ONCE (issue #97): a
  // lapsed key used to skip segments silently forever, with no path to the
  // guide short of the shell.
  private voiceSetupHinted = false

  private async synthesizeOrSkip(text: string): Promise<AudioClip | null> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await this.deps.voice.synthesize(text)
      } catch (err) {
        if (attempt === ATTEMPTS) {
          this.deps.host.info(`voice synthesis failed (${String(err)}); skipping this segment.`)
          if (/\b40[123]\b/.test(String(err))) {
            this.deps.onVoiceAuthFailure?.()
            if (!this.voiceSetupHinted) {
              this.voiceSetupHinted = true
              this.deps.host.info('the voice endpoint is refusing auth — type /setup to fix it.', 'flow')
            }
          }
        }
      }
    }
    return null
  }

  // Inter-segment pause, steerable: a line during the gap gets its reply; the
  // gap is not resumed afterward (the program moves to the next segment).
  private async gap(): Promise<void> {
    this.emitState('gap')
    const ac = new AbortController()
    // Longer gaps in an empty room (spec 07 §3.2) — the stream keeps playing,
    // it just stops crowding a room nobody is in.
    const factor = this.activity === 'away' ? AWAY_GAP_FACTOR : 1
    const slept = sleep(this.deps.settings().gapSeconds * factor * 1000, undefined, {
      signal: ac.signal,
    }).then(
      () => true,
      () => false,
    )
    while (true) {
      const line = this.deps.host.peekLine().then(() => false)
      const finished = await Promise.race([slept, line])
      if (finished) return
      const steer = this.takeSteer()
      // A line the report floor ate is not a reason to cut the gap short:
      // writing out a bug description must not make the radio talk more often.
      // The gap keeps running and the same sleep is re-raced.
      if (steer.intent === 'consumed') continue
      ac.abort()
      await this.runVoice(null, undefined, steer)
      return
    }
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
    let track = song
    let steer: Steer | null = seed ?? null
    this.liveSong = track ?? null
    // spec 04 §3.3: half the time the coda talks over the track's tail instead
    // of waiting for silence. Armed once per track (re-armed on a handover, for
    // the new one), and cleared once it has been raced.
    let codaRide = track === undefined ? null : this.armCodaRide()
    try {
      while (!this.quit) {
        if (steer === null) {
          const voiceLive = current !== null && !current.done()
          const audio = voiceLive
            ? current!.promise.then(() => 'voice' as const)
            : track !== undefined
              ? track.wait().then(() => 'song' as const)
              : null
          if (audio === null) return
          // A due switch races its fresh pick too (spec 11 §2.3): the handover
          // must wait for neither the song's end nor the listener's next line.
          const pickReady =
            track !== undefined && this.switchDue && this.pendingPick !== null
              ? this.pendingPick.promise.then(() => 'pick' as const)
              : null
          // Only while the voice channel is free: the ride is a beat, and one
          // voice clip at a time still holds.
          const riding = codaRide !== null && !voiceLive ? codaRide : null
          const winner = await Promise.race([
            audio,
            ...(pickReady !== null ? [pickReady] : []),
            ...(riding !== null ? [riding] : []),
            this.deps.host.peekLine().then(() => 'line' as const),
            this.quitting,
          ])
          if (winner === 'quit') return // the finally below cuts voice and song
          if (winner === 'song') {
            // The outro passed without the ride (or there was none): the coda
            // goes to the head of the talk queue instead.
            this.queueCoda()
            return // the song ended -> segment over
          }
          if (winner === 'coda') {
            codaRide = null // one ride per track, won or lost
            const ride = this.takeCoda()
            if (ride === null) {
              this.deps.host.debug?.('coda not ready for the outro; it waits for the boundary')
              continue
            }
            this.deps.host.debug?.('coda rides the outro')
            // Recorded, not aired as a segment: the song is still on air under
            // it, so the front-end keeps naming the track (see recordBeat).
            this.recordBeat(ride.beat)
            current = onAir(this.deps.player.play(ride.clip))
            continue
          }
          if (winner === 'pick') {
            // One voice clip at a time: let a still-airing reply finish, then
            // swap — the cut lands between clips, never over one.
            if (current !== null && !current.done()) await current.promise
            current = null
            const swapped = await this.handoverTrack()
            if (swapped !== null) {
              track = swapped.handle
              this.liveSong = track ?? null
              current = swapped.voice
              // A new track brought its own coda (startTrack fired one); the
              // ride belongs to ITS length, from ITS start.
              codaRide = track === undefined ? null : this.armCodaRide()
            }
            continue
          }
          if (winner === 'voice') {
            if (track === undefined) return // clip ended -> segment over
            current = null // intro/reply finished; keep racing the song
            continue
          }
          steer = this.takeSteer()
        }
        if (steer.intent === 'quit') {
          this.beginQuit()
          return
        }
        if (steer.intent === 'settings') {
          // A command, not a turn (spec 12 §3.6): nothing on air is touched and
          // no reply is composed. A pane-capable host shows the pane; the plain
          // host gets the one pointer it can act on.
          if (this.deps.host.showSettings !== undefined) this.deps.host.showSettings()
          else this.deps.host.info('settings live in settings.json under the murmur home.')
          steer = null
          continue
        }
        if (steer.intent === 'setup') {
          // The song (or the tail of the clip) keeps playing under the guide's
          // text — the loop parks here and the race resumes on return.
          await this.recallSetup()
          if (this.quit) return // the finally cuts voice and song
          steer = null
          continue
        }
        if (steer.intent === 'bug' || steer.intent === 'feature') {
          this.openReport(steer.intent)
          steer = null
          continue
        }
        if (steer.intent === 'update') {
          this.startUpdate()
          steer = null
          continue
        }
        if (steer.intent === 'consumed') {
          steer = null
          continue
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
        // A confirmed end_broadcast (spec 11 §2.1): the reply is the sign-off —
        // let it air in full, then the same orderly close /quit performs.
        if (this.quitAfterReply) {
          this.quitAfterReply = false
          await current.promise
          this.beginQuit()
          return
        }
      }
    } finally {
      this.liveSong = null
      // /quit or shutdown while audio is live: cut the voice, stop the song.
      if (this.quit) {
        if (current !== null && !current.done()) {
          await this.deps.player.stop()
          await current.promise
        }
        if (track !== undefined) await track.stop()
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
    // The user's turn is fresh mood signal: prime the next pick around it. A
    // pick already in flight predates this turn — a hinted switch_music uses
    // that to decide whether it must re-prime (spec 11 §2.1).
    this.pickPredatesTurn = this.pendingPick !== null
    this.prefetchMusic()
    while (true) {
      const prep = this.prepareReply(texts)
      const winner = await Promise.race([
        prep.then((r) => ({ kind: 'ready' as const, r })),
        this.deps.host.peekLine().then(() => ({ kind: 'line' as const })),
      ])
      if (winner.kind === 'ready') return winner.r
      prep.catch(() => {}) // discarded in-flight prepare (cannot cancel a promise)
      this.steerEpoch++ // the orphaned steer task's actions are dead (spec 11 §2.2)
      const merged = this.takeSteer()
      if (merged.intent === 'quit') {
        this.beginQuit()
        return null
      }
      if (merged.intent === 'setup') {
        // A command, not a turn: run the recall, then keep composing — unless
        // a /quit landed inside the conversation.
        await this.recallSetup()
        if (this.quit) return null
        continue
      }
      if (merged.intent === 'settings') {
        // A /settings typed mid-compose is still just a command: show the pane
        // (or the pointer) and keep composing the reply already in flight.
        if (this.deps.host.showSettings !== undefined) this.deps.host.showSettings()
        else this.deps.host.info('settings live in settings.json under the murmur home.')
        continue
      }
      if (merged.intent === 'bug' || merged.intent === 'feature') {
        // Same rule: a command mid-compose does not become part of the turn.
        this.openReport(merged.intent)
        continue
      }
      if (merged.intent === 'update') {
        this.startUpdate()
        continue
      }
      if (merged.intent === 'consumed') continue
      texts.push(merged.text)
      this.deps.host.onUserLine(merged.text)
      this.deps.memory.record({ role: 'user', text: merged.text })
    }
  }

  // Total (never rejects): a failed compose degrades to null so the race in
  // compose() and the loop above never unwind the radio on a Brain error.
  private async prepareReply(texts: string[]): Promise<{ reply: string; clip: AudioClip } | null> {
    this.pendingUserLines = texts.length
    let reply: string
    try {
      reply = await this.composeReply(texts.join('\n'))
    } catch (err) {
      this.deps.host.info(`reply failed (${String(err)}); back to the program.`)
      return null
    }
    const clip = await this.synthesizeOrSkip(reply)
    return clip === null ? null : { reply, clip }
  }

  // The agentic reply (spec 11 §2.2) with its fallback chain: a steer task that
  // never finishes (or throws) degrades to the tool-less respond. The armed
  // shutdown disarms when a task passes without touching end_broadcast — the
  // listener moved on.
  private async composeReply(userText: string): Promise<string> {
    const steer = this.deps.steer
    if (steer === undefined) return this.deps.brain.respond(userText, this.context())
    const armedBefore = this.shutdownArmed
    this.steerEndCalled = false
    // Attempt-local (spec 05-01 §3.2): reply attempts overlap when a line lands
    // mid-compose, and a shared flag let the newer attempt reset what the older
    // one had already acted on — the acted-on command then entered the fold.
    const acted = { value: false }
    let reply: string | null = null
    try {
      reply = await steer.respond(userText, this.context(), this.steerActions(acted))
    } catch (err) {
      this.deps.host.debug?.(`steer task failed (${String(err)}); falling back to respond`)
    }
    if (armedBefore && !this.steerEndCalled) this.shutdownArmed = false
    if (acted.value) this.deps.memoryOps?.markSteered()
    if (reply !== null) return reply
    return this.deps.brain.respond(userText, this.context())
  }

  // The Director-owned surface the steer tools act through (spec 11 §2.2):
  // callbacks closed over live state; tools never import the Director. `music`
  // rides only when music is wired — that absence gates switch_music out of
  // the tool set.
  private steerActions(acted: { value: boolean }): SteerActions {
    // Mutators are live only while this attempt is the latest — a merged reply
    // orphans its predecessor, whose late calls must land on a dead surface.
    const epoch = this.steerEpoch
    const live = () => epoch === this.steerEpoch
    return {
      ...(this.deps.music !== undefined && {
        music: {
          playing: () => this.liveSong !== null,
          switchTrack: (hint?: string) => {
            if (!live()) return
            acted.value = true
            this.switchMusic(hint)
          },
        },
      }),
      // The conversational half of the settings layer (spec 12 §2.6). Absent on
      // a run with no store, which gates change_settings out of the tool set.
      // The epoch guard applies here too: an orphaned attempt must not land a
      // knob change the listener's newer turn already superseded.
      ...(this.deps.settingsStore !== undefined && {
        settings: {
          current: () => this.deps.settingsStore!.current(),
          set: (patch) => {
            if (!live()) return false
            acted.value = true
            return this.deps.settingsStore!.set(patch)
          },
        },
      }),
      // What the listener has said before, past the transcript (spec 05-01
      // §2.2). The limit is the Director's call, not the model's; the epoch
      // guard rides forget for the same reason it rides every other mutator —
      // an orphaned attempt must never delete what a newer turn superseded.
      ...(this.deps.memoryOps !== undefined && {
        memory: {
          recall: (query: string) => {
            const hits = this.deps.memoryOps!.recall(
              query,
              RECALL_LIMIT,
              this.deps.settings().recentWindow,
            )
            // The deterministic seam a real run is read from, never the model's
            // account of what it remembered (spec 05-01 §5.13) — but SHAPE
            // only. Diagnostics persist under the murmur home and ride along on
            // a /bug report, so the words themselves must not land here: a
            // later forget cannot reach into this file.
            const when = hits.map((h) => `${new Date(h.ts * 1000).toISOString().slice(0, 10)} ${h.role}`)
            this.deps.host.debug?.(`memory.recall -> ${hits.length} [${when.join(' | ')}]`)
            return hits
          },
          forget: (what: string) => {
            if (!live()) return { rows: 0, lines: 0 }
            // Forgetting is an action on the program like any other: the turn
            // that asked for it is a command, not a preference, and must never
            // teach the profile the very thing it destroyed.
            acted.value = true
            // Every merged line of this turn is the asking (spec 05-01 §3.5):
            // removed, but never counted as a memory that was there before.
            const gone = this.deps.memoryOps!.forget(what, this.pendingUserLines)
            // Counts only — never `what`, for the same reason as above.
            this.deps.host.debug?.(`memory.forget -> ${gone.rows} rows, ${gone.lines} lines`)
            return gone
          },
        },
      }),
      shutdown: {
        armed: () => this.shutdownArmed,
        arm: () => {
          if (!live()) return
          acted.value = true
          this.shutdownArmed = true
          this.steerEndCalled = true
        },
        confirm: () => {
          if (!live()) return
          acted.value = true
          this.quitAfterReply = true
          this.steerEndCalled = true
        },
      },
    }
  }
}
