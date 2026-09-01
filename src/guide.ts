// Wire the guide harness into murmur's Host (spec 03-03), and run the
// conversational onboarding built on it (§7).
//
// The deterministic probes decide whether to engage; when they do, the guide
// runs with its conversation routed through the Host — the agent's text prints
// as it streams (onText), its tool activity is narrated, and the user's
// natural-language replies flow back (nextUserInput). Consent is the ENTRY:
// the offer card's y authorizes the fixes, canUseTool allows within that
// authorization (denying only secret-bearing input), and the substantive
// checkpoints live in the conversation itself.
//
// The posture the onboarding slice adds: murmur assumes the user has Claude
// Code, so a gap is never a wall. The radio launches degraded and then OFFERS
// to fix itself by talking. runSetup is that offer — once per boot, actively,
// covering every gap in one conversation.

import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

import {
  isSecretBearing,
  SECRET_DENY_MESSAGE,
  SECRET_NAME,
  SECRET_PATH,
  toolDetail,
} from './brain.ts'
import type { GuideCapable, GuideSession, LedgerKind } from './contracts.ts'
import { ask, type Host } from './host.ts'
import { expandUser } from './paths.ts'
import { HostedVoice } from './hosted-voice.ts'
import { buildSetupPrompt, GUIDE_PERSONA, VISIT_PERSONA } from './prompts.ts'
import {
  preflightBun,
  preflightMusic,
  preflightYtdlpFreshness,
  type PreflightResult,
} from './startup.ts'
import {
  createVoiceTool,
  type VoiceConfig,
  VOICE_PROBE_LINE,
  writeVoiceConfigTool,
} from './voice-config.ts'

// Repair is judgment-heavy and occasional; the token cost amortizes (spec
// 03-03 §3). Not a config knob until someone needs one.
const GUIDE_MODEL = 'claude-opus-4-8'
const GUIDE_MAX_TURNS = 30

// Consent parsing hears the listener's own language: this radio converses in
// Chinese, so an affirmation in either language is a yes. The Chinese entries
// ride as \u escapes — v1 sources stay ASCII by the language gate — each
// named in pinyin beside it.
const YES = new Set([
  'y',
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  '\u597d', // hao - good / yes
  '\u597d\u7684', // hao de - sure
  '\u597d\u554a', // hao a - sure
  '\u53ef\u4ee5', // ke yi - can do
  '\u884c', // xing - fine
  '\u55ef', // en - yeah
  '\u540c\u610f', // tong yi - agree
])
const NO = new Set([
  'n',
  'no',
  'nope',
  '\u4e0d', // bu - no
  '\u4e0d\u7528', // bu yong - no need
  '\u4e0d\u8981', // bu yao - do not
  '\u522b', // bie - do not
])
const END = new Set(['', '/done', '/quit', 'q'])

// The one consent test murmur uses: anything but an explicit yes declines, so
// EOF (which reads as '') always means no.
export function isYes(line: string): boolean {
  return YES.has(line.trim().toLowerCase())
}

// The standing "stop asking me" needs an explicit no — an unrecognized answer
// (Enter included) is only "not now", never "never again".
export function isNo(line: string): boolean {
  return NO.has(line.trim().toLowerCase())
}

// A serialized, consuming line read for the guide's asks. Two things the
// Director's raw peek/take race primitive gets wrong here (codex-review
// regressions): one typed line wakes EVERY concurrent waiter (concurrent
// permission asks would share an answer and drop the rest), and a closed
// stdin pends forever (a non-interactive run would wedge startup). So reads
// queue one behind the other, and EOF resolves '' — which every consumer
// already treats as decline/skip/end.
// `echo: false` reads a line the log must never see: the credential the
// voice tool captures out of band (spec 03-03 §7.2). Every other read is a
// half of a conversation and belongs in the program log (spec 10 §3.3).
export type ReadLine = (opts?: { echo?: boolean }) => Promise<string>

// The listener's way OUT of a Q&A flow (spec 01 §3.6 extended to onboarding):
// Ctrl-C in the TUI arrives as a typed /quit, and a consuming reader must not
// swallow it as an answer. Once fired, every later read resolves '' instantly
// (the EOF fast-forward), the flows decline through, and the app checks
// `requested` to shut down instead of starting the broadcast.
export type QuitLatch = { requested: boolean; fire(): void; seen: Promise<string> }

export function quitLatch(): QuitLatch {
  let fire!: () => void
  const seen = new Promise<string>((resolve) => {
    fire = () => resolve('')
  })
  const latch: QuitLatch = {
    requested: false,
    seen,
    fire() {
      latch.requested = true
      fire()
    },
  }
  return latch
}

const QUIT = '/quit'

// The Esc event (spec 10 §3.4): a PULSE, not a latch. Each fire answers the
// read that was waiting with '' and re-arms; a fire with nobody waiting is
// dropped (the Esc router acts on it through other channels — interruptTurn —
// and a stored pulse would kill a read the user never aimed at). What ''
// MEANS is the consumer's business, decided by where the flow stood.
export type EscPulse = { wait(): Promise<string>; fire(): void }

export function escPulse(): EscPulse {
  let waiters: ((line: string) => void)[] = []
  return {
    wait() {
      return new Promise<string>((resolve) => waiters.push(resolve))
    },
    fire() {
      const woken = waiters
      waiters = []
      for (const wake of woken) wake('')
    },
  }
}

// `esc` answers the pending read with '' when the listener's Esc fires — the
// app is not shutting down; the read's consumer decides what the Esc meant.
export function lineReader(host: Host, quit: QuitLatch, esc?: EscPulse): ReadLine {
  const eof: Promise<string> = host.eof?.().then(() => '') ?? new Promise<string>(() => {})
  let chain: Promise<unknown> = Promise.resolve()
  return ({ echo = true } = {}) => {
    const read = chain.then(() => {
      // `settled` marks this read as already resolved through EOF or the quit
      // latch: its peekLine callback is then a stale wake-up, and taking would
      // silently destroy a line typed AFTER that resolution — the second
      // /quit a stuck user types, or the first line a re-attached front-end
      // sends. Leave the line queued for whoever reads next.
      let settled = false
      const take = host.peekLine().then(() => {
        if (settled) return ''
        const line = host.takeLine() ?? ''
        // The listener's own half of a foreground conversation (spec 10 §3.3:
        // the program log is segments + user lines + info). The front-end
        // paints only what the engine reports, and this reader — the guide,
        // the first-run seeds, the crash-report offer — is the one keyboard
        // path the Director's `onUserLine` never covered. A secret read is
        // the one exception: an echo would put the credential on the wire,
        // in the replay backlog, and in the dev log (spec 03-03 §7.2).
        if (echo && line !== '') host.onUserLine(line)
        if (line.trim() === QUIT) {
          quit.fire()
          return ''
        }
        return line
      })
      const outs = esc === undefined ? [take, eof, quit.seen] : [take, eof, quit.seen, esc.wait()]
      return Promise.race(outs).finally(() => (settled = true))
    })
    chain = read
    return read
  }
}

// The permission callback under the entry authorization (spec 03-03 §3):
// the offer card's y IS the consent, so every tool call is allowed outright
// and no permission question ever reaches the user — the checkpoints that remain are conversational (the prompt stops at
// substantive forks). The secret-input guard's enforcement point is the
// PreToolUse hook in guideOptions (the SDK consults this callback only when
// its own policy would ask); the same test here is the belt for the calls
// that do arrive. The dev log keeps a record of everything allowed.
export function cliPermission(host: Host, quit: QuitLatch, halted?: () => boolean): CanUseTool {
  return async (toolName, input) => {
    // A user who is leaving, or a turn the user just cut (the belt behind
    // interruptTurn): deny outright.
    if (quit.requested) return { behavior: 'deny', message: 'user quit' }
    if (halted?.() === true) return { behavior: 'deny', message: 'the user stopped this turn' }
    if (isSecretBearing(toolName, input)) {
      return { behavior: 'deny', message: SECRET_DENY_MESSAGE }
    }
    host.debug?.(`guide auto-allowed [${toolName}]: ${toolDetail(input)}`)
    return { behavior: 'allow' }
  }
}

// The Esc router's view of the conversation: `waiting` is true exactly while
// the reply prompt holds the keyboard (Esc then means "hand back"), and
// `turnAborted` is the per-turn cut flag, reset the moment a new prompt opens.
export type ConversationFlow = { waiting: boolean; turnAborted: boolean }

// Read the user's next natural-language reply from the CLI Host. An empty
// line or /done|/quit|q ends the conversation (returns null). The prompt is
// an info line, never an ask: the guide's own words carry the question, and a
// spotlight card reading only "your reply" would hush the room over nothing —
// the modal stays reserved for the onboarding decisions.
export function cliConversation(
  host: Host,
  read: ReadLine,
  quit: QuitLatch,
  flow?: ConversationFlow,
): () => Promise<string | null> {
  return async () => {
    if (quit.requested) return null
    // A new turn is about to open: the previous turn's cut is spent.
    if (flow !== undefined) flow.turnAborted = false
    host.info('setup guide is listening — reply here; /done or esc hands back to the radio:')
    if (flow !== undefined) flow.waiting = true
    // The busy sign follows the keyboard exactly (spec 10 §3.4): dark while
    // the prompt holds it, lit again the moment the reply is in and the model
    // has the turn back.
    host.setBusy?.(false)
    try {
      const line = (await read()).trim()
      // A line that ENDS the conversation starts no turn: relighting here
      // would leave the sign burning through the SDK teardown and the closing
      // re-probe, with nothing left to clear it.
      if (END.has(line.toLowerCase())) return null
      host.setBusy?.(true)
      return line
    } finally {
      if (flow !== undefined) flow.waiting = false
    }
  }
}

// How much of a tool's printed output the host shows. Installs can print
// hundreds of lines; the tail is where a package manager puts its verdict.
const RESULT_TAIL_LINES = 12
const RESULT_TAIL_CHARS = 1600

// The visible face of a tool run: output indents under the `-> [tool]` line
// the caller printed, long output keeps only the tail, errors are labeled.
export function formatToolResult(output: string, isError: boolean): string {
  const trimmed = output.trim()
  const body = trimmed === '' ? ['(no output)'] : trimmed.split('\n')
  let tail = body.slice(-RESULT_TAIL_LINES)
  const joined = tail.join('\n')
  if (joined.length > RESULT_TAIL_CHARS) tail = joined.slice(-RESULT_TAIL_CHARS).split('\n')
  const clipped = tail.length < body.length || joined.length > RESULT_TAIL_CHARS
  const lines = [
    ...(clipped ? ['... (output trimmed, showing the tail)'] : []),
    ...(isError ? ['[error]'] : []),
    ...tail,
  ]
  return lines.map((line) => `  ${line}`).join('\n')
}

// --- conversational onboarding (spec 03-03 §7) ---------------------------- //

export type GapKind = 'music' | 'ytdlp' | 'bun' | 'voice'
export type Gap = { readonly kind: GapKind; readonly reason: string }

// The tier-3 ledger key for the onboarding offer's standing answer. A decline
// is a fact about the user, so it belongs on the ledger and not in a dotfile.
export const SETUP_DECLINED = 'declined'

// The narrow ledger surface this flow needs — impl-level, like spec 06's
// ProfileWritable. A session with no persistent memory simply has none.
export type SetupLedger = {
  recordEvent(kind: LedgerKind, key: string): void
  recentEvents(kind: LedgerKind, n: number): string[]
}

// What this session WANTS, and what it can see right now. `voiceUrl` is a thunk
// rather than a string because the conversation may write one mid-flight — the
// recheck has to read the world again, not the world as it was at boot.
export type SetupTargets = {
  readonly ytdlp: string
  readonly ffmpeg: string
  readonly bunCmd: string
  readonly home: string // $MURMUR_HOME — the one place a voice config may land
  readonly wantsMusic: boolean
  readonly wantsBun: boolean
  readonly wantsVoice: boolean
  readonly voiceUrl: () => string
  // A configured endpoint that is refusing auth (fed by the Director's synth
  // failures): still a gap — issue #97's reopen path.
  readonly voiceFailing?: () => boolean
  // The saved config behind that URL, re-read the same way: what the run wires
  // its voice from once the conversation is over (issue #96).
  readonly voiceConfig: () => VoiceConfig | null
  // The endpoint the run is speaking through (env and flags layered over the
  // file), for the tools that must reach the LIVE one rather than the saved
  // one. Optional: a bare target has only its file.
  readonly effectiveVoice?: () => VoiceConfig | null
}

export type SetupProbes = {
  music: (binaries: { ytdlp: string; ffmpeg: string }) => Promise<PreflightResult>
  ytdlpFresh: (binary: string) => Promise<PreflightResult>
  bun: (binary: string) => Promise<PreflightResult>
}

const DEFAULT_PROBES: SetupProbes = {
  music: preflightMusic,
  ytdlpFresh: (binary) => preflightYtdlpFreshness(binary),
  bun: preflightBun,
}

// The deterministic half (master §7 pillar 1 — local probes, 0 tokens). Nothing
// the session does not want is probed at all: --no-music costs no yt-dlp search.
export async function detectGaps(
  targets: SetupTargets,
  probes: Partial<SetupProbes> = {},
): Promise<Gap[]> {
  const probe = { ...DEFAULT_PROBES, ...probes }
  const [music, bun] = await Promise.all([
    targets.wantsMusic
      ? probe.music({ ytdlp: targets.ytdlp, ffmpeg: targets.ffmpeg })
      : Promise.resolve({ ok: true, reason: '' }),
    targets.wantsBun ? probe.bun(targets.bunCmd) : Promise.resolve({ ok: true, reason: '' }),
  ])
  // Freshness rides BEHIND a working music pair: a broken install is the
  // music gap's business (its repair is an install, not an upgrade), and the
  // version of a missing binary is not a fact.
  const fresh =
    targets.wantsMusic && music.ok
      ? await probe.ytdlpFresh(targets.ytdlp)
      : { ok: true, reason: '' }
  const gaps: Gap[] = []
  if (!music.ok) gaps.push({ kind: 'music', reason: music.reason })
  if (!fresh.ok) gaps.push({ kind: 'ytdlp', reason: fresh.reason })
  if (!bun.ok) gaps.push({ kind: 'bun', reason: bun.reason })
  if (targets.wantsVoice) {
    if (targets.voiceUrl().trim() === '') {
      gaps.push({ kind: 'voice', reason: 'no endpoint configured' })
    } else if (targets.voiceFailing?.() === true) {
      gaps.push({ kind: 'voice', reason: 'the configured endpoint is failing auth' })
    }
  }
  return gaps
}

// What the rest of the app wires itself from afterwards. One field per gap the
// offer covers — an explicit entry reports completion off ALL of them, so a
// gap missing here would silently read as "done".
export type SetupOutcome = {
  readonly musicOk: boolean
  // Freshness reports separately from musicOk: a stale binary still plays
  // (never degrading), but an explicit `--setup` must not claim completion
  // over a staleness gap it just re-detected.
  readonly ytdlpFresh: boolean
  readonly bunOk: boolean
  readonly voiceOk: boolean
}

export type SetupRun = {
  host: Host
  guide: GuideCapable
  targets: SetupTargets
  // Absent = nothing to remember by (a stub session): the offer still opens,
  // it just cannot be silenced across boots.
  ledger?: SetupLedger | undefined
  probes?: Partial<SetupProbes>
  // Prove a pasted endpoint by synthesizing one real line through it.
  validateVoice?: (config: VoiceConfig) => Promise<void>
  // An explicit entry (--setup / --setup-music): always converse, never consult
  // or write the standing decline.
  explicit?: boolean
  // Fired by a typed /quit mid-conversation; reads decline through instantly.
  quit?: QuitLatch
}

const PLAIN_ENGLISH: Record<GapKind, string> = {
  music: 'music needs yt-dlp and ffmpeg, so the program is talk-only for now',
  ytdlp: 'yt-dlp is getting stale, so fetching songs (Bilibili first) may fail until it is upgraded',
  bun: 'the terminal interface needs bun, so this is the plain text version',
  voice: 'the voice endpoint is missing or failing, so lines are shown instead of spoken',
}

const READY: Record<GapKind, string> = {
  music: 'yt-dlp and ffmpeg are working',
  ytdlp: 'yt-dlp is current',
  bun: 'the terminal front-end runtime is ready',
  voice: 'the voice endpoint is configured',
}

// The pre-broadcast checklist card (spec 10 §3.2-B spotlight): summary, ready
// rows ('ok '), gap rows ('-- ', each a consequence, not a stack trace), then
// the y/N — diagnosis and invitation share one ask, so the modal shows them
// as one card and the plain host prints the same text. ASCII-only markers:
// ambiguous-width glyphs shift box borders on some terminals.
export function setupOfferText(targets: SetupTargets, gaps: Gap[], explicit = false): string {
  const has = (kind: GapKind): boolean => gaps.some((gap) => gap.kind === kind)
  const named = gaps.map((gap) => PLAIN_ENGLISH[gap.kind]).join('; ')
  // The name column is padded so the card reads as a checklist table (ref B3).
  const NAME_COL = 6
  const rows: string[] = [`ok ${'brain'.padEnd(NAME_COL)} - claude is on the air`]
  const wanted: [GapKind, boolean][] = [
    ['music', targets.wantsMusic],
    ['bun', targets.wantsBun],
    ['voice', targets.wantsVoice],
  ]
  for (const [kind, wants] of wanted) {
    if (wants && !has(kind)) rows.push(`ok ${kind.padEnd(NAME_COL)} - ${READY[kind]}`)
  }
  for (const gap of gaps) rows.push(`-- ${gap.kind.padEnd(NAME_COL)} - ${PLAIN_ENGLISH[gap.kind]}`)
  // One option per line, each visibly a choice ('>> ' rows, spec 10 §3.2-B):
  // Enter is never the silent default, and each answer's real cost is written
  // on it. An explicit entry (`make setup`) carries no boot-persistence — its
  // card must not promise any (skipping records nothing there), so it offers
  // exactly the two answers it honors.
  // The y is an authorization, not the first of many confirms (spec 03-03
  // §3), and its row says what it buys: murmur runs the fixes itself and
  // comes back only at substantive forks.
  const YES_ROW = ">> y - fix them now (I'll run the fixes, and check with you at real choices)"
  const options = explicit
    ? [YES_ROW, '>> Enter - skip for now']
    : [
        YES_ROW,
        ">> Enter - not now (I'll offer again next boot)",
        ">> n - don't ask again (murmur --setup reopens this)",
      ]
  return [`a couple of things aren't set up on this machine: ${named}.`, ...rows, ...options].join(
    '\n',
  )
}

// One verdict shared by `make setup` and the /setup recall: complete means
// every surface this session WANTS is ok.
export function setupComplete(targets: SetupTargets, outcome: SetupOutcome): boolean {
  return (
    (!targets.wantsMusic || (outcome.musicOk && outcome.ytdlpFresh)) &&
    (!targets.wantsBun || outcome.bunOk) &&
    (!targets.wantsVoice || outcome.voiceOk)
  )
}

function outcomeFrom(targets: SetupTargets, gaps: Gap[]): SetupOutcome {
  const has = (kind: GapKind): boolean => gaps.some((g) => g.kind === kind)
  return {
    musicOk: targets.wantsMusic && !has('music'),
    ytdlpFresh: targets.wantsMusic && !has('ytdlp'),
    bunOk: targets.wantsBun && !has('bun'),
    voiceOk: targets.wantsVoice && !has('voice'),
  }
}

// The startup onboarding phase (spec 03-03 §7.1 point 3). The radio ALWAYS
// launches; this is what stops a degraded launch from being a passive one. When
// the deterministic probes find gaps, murmur names them in plain language and
// opens a real conversation — the guide investigates, narrates, applies, and
// verifies, asking only at substantive forks. Declining is the only thing that makes later boots
// quiet, and it costs exactly one info line thereafter.
export async function runSetup(run: SetupRun): Promise<SetupOutcome> {
  const { host, targets } = run
  // A caller without a latch (the explicit CLI entries) still gets one: a
  // typed /quit inside the conversation ends it the same way everywhere.
  const quit = run.quit ?? quitLatch()
  const explicit = run.explicit === true
  // The Esc router (spec 10 §3.4, the conversation-partner boundary): what a
  // keypress means depends on where the flow stands, and Esc NEVER kills the
  // session — that is /quit's job.
  //   before the y  -> "not now": the pending offer read answers '' through
  //                    the pulse; mid-probe (no read pending) the latch below
  //                    carries the answer to the post-probe check
  //   guide waiting -> hand back: the reply read answers '' (same as a typed /done)
  //   guide working -> cut the TURN: query.interrupt() via the live session
  //                    handle, plus the pulse for an in-turn read (the secret
  //                    paste) and the abort flag for its tool
  // Armed for the whole flow, opening probes included (a live network search
  // taking real seconds); the finally hands the seam back.
  const esc = escPulse()
  const offerEsc = quitLatch()
  const flow: SetupFlow = {
    waiting: false,
    turnAborted: false,
    escEpoch: 0,
    consented: false,
    done: false,
    session: null,
  }
  host.onInterrupt?.(() => {
    if (quit.requested) return
    if (!flow.consented || flow.done) {
      // Before the y — or after the conversation closed (the re-probe): a
      // "not now" for the offer, noise otherwise.
      offerEsc.fire()
      esc.fire()
      return
    }
    if (flow.waiting) {
      esc.fire()
      return
    }
    flow.turnAborted = true
    flow.escEpoch++
    esc.fire()
    void flow.session?.interruptTurn()
    host.info('stopped — the setup guide is waiting for you', 'flow')
  })
  try {
    // The probes take real seconds: say so first, so the front-end has a
    // loading signal instead of a silent stall.
    host.info('checking the gear on this machine...')
    const gaps = await detectGaps(targets, run.probes ?? {})
    if (quit.requested) return outcomeFrom(targets, gaps)
    if (offerEsc.requested) {
      host.info("not now, then — I'll offer again next boot; `murmur --setup` any time.")
      return outcomeFrom(targets, gaps)
    }
    // The boot path stays quiet on a clean machine. An explicit entry (make
    // setup, the /setup recall) is the listener walking in on purpose, and
    // usually to CHANGE something that already works — the timbre most of all,
    // which the guide itself tells them they can settle later. Answering that
    // with one line and a closed door is the door this whole surface exists to
    // open, so the conversation runs; there is simply nothing broken in it.
    // A run that wants no voice at all has no tool to offer and nothing to
    // change, so it keeps the one-line answer.
    if (gaps.length === 0 && !(explicit && targets.wantsVoice)) {
      if (explicit) host.info('everything checks out — nothing to fix.')
      return outcomeFrom(targets, gaps)
    }

    const named = gaps.map((gap) => PLAIN_ENGLISH[gap.kind]).join('; ')

    // A standing decline: one line, no question, no re-nagging (§7.1 point 3).
    if (!explicit && run.ledger?.recentEvents('setup', 1).includes(SETUP_DECLINED) === true) {
      host.info(`${named}. Run \`murmur --setup\` whenever you want to sort that out.`)
      return outcomeFrom(targets, gaps)
    }

    // The offer and the guide both read the keyboard; make sure the reader is
    // up (idempotent — the Director starts it too).
    host.start()
    return await runSetupFlow(run, quit, esc, flow, gaps, explicit)
  } finally {
    host.onInterrupt?.(null)
    // The abnormal exits (a /quit, a thrown guide) still hand the floor back.
    if (flow.consented && !flow.done) host.setMode?.('radio')
  }
}

type SetupFlow = ConversationFlow & {
  // Monotonic count of turn-cutting Escs: never reset, so a tool call in
  // flight can watch for "a cut landed since I began" (armAbort) even after
  // the next turn resets `turnAborted`.
  escEpoch: number
  consented: boolean
  done: boolean
  session: GuideSession | null
}

async function runSetupFlow(
  run: SetupRun,
  quit: QuitLatch,
  esc: EscPulse,
  flow: SetupFlow,
  gaps: Gap[],
  explicit: boolean,
): Promise<SetupOutcome> {
  const { host, guide, targets } = run
  const read = lineReader(host, quit, esc)
  // Probe detail (the raw reason) is diagnostics, not card copy: the guide
  // gets it via its prompt, the dev log keeps it for humans.
  for (const gap of gaps) host.debug?.(`gap ${gap.kind}: ${gap.reason}`)
  // Nothing to fix and the listener came here themselves: the y would be a
  // consent to repairs that do not exist. Opening the conversation IS the
  // answer to `/setup` on a healthy machine.
  if (gaps.length > 0) {
    ask(host, setupOfferText(targets, gaps, explicit), 'consent')

    const answer = await read()
    if (!isYes(answer)) {
      // Leaving is not answering (codex review): a /quit mid-offer must not
      // become a standing decline that silences every later boot. An Esc lands
      // in the "not now" branch below — the same non-answer a bare Enter is.
      if (quit.requested) return outcomeFrom(targets, gaps)
      // Only the boot-time offer records the standing answer — and only for an
      // EXPLICIT no. Enter reads as the default-confirm to half the world, and
      // an unrecognized answer is "not now", never "never again". Backing out
      // of an explicit `make setup` is not "stop asking me" either.
      if (!explicit && isNo(answer)) {
        run.ledger?.recordEvent('setup', SETUP_DECLINED)
        host.info("no problem — I won't ask again. `murmur --setup` reopens this any time.")
      } else if (explicit) {
        host.info('skipped setup.')
      } else {
        host.info("not now, then — I'll offer again next boot; `murmur --setup` any time.")
      }
      return outcomeFrom(targets, gaps)
    }
  }

  // The floor is taken — by the y, or by an explicit entry with nothing to
  // repair, where walking in WAS the consent. The setup guide holds it until
  // the conversation ends; the front-end paints the boundary (spec 10 §3.4).
  flow.consented = true
  host.setMode?.('guide')
  // The first turn starts working immediately — the gap report is already on
  // screen and the model is being called. Every later turn's sign is flipped
  // by cliConversation, which is where the keyboard changes hands.
  host.setBusy?.(true)

  // Tool uses whose OUTPUT must not be echoed (and thereby dev-logged).
  const secretUses = new Set<string>()
  // The voice tools ride the TARGET, not the gap. A listener who reopens setup
  // is usually there to change something that already works — above all the
  // timbre, which the guide itself invites them to pick later — and gating on
  // "the endpoint is missing" left that invitation with no way to be taken up.
  // They stay closure-scoped to one config path either way, so a session that
  // has nothing to fix simply never calls them.
  const tools = targets.wantsVoice
    ? [
        writeVoiceConfigTool({
          home: targets.home,
          validate: run.validateVoice ?? ((config) => validateEndpoint(config)),
          // A cut turn or a /quit while the tool holds the floor (the paste
          // prompt, the probe synth): abort instead of persisting on a
          // declined read. Armed per call — the epoch survives the next
          // turn's flag reset.
          armAbort: () => {
            const since = flow.escEpoch
            return () => flow.escEpoch > since || quit.requested
          },
          // The secret's own channel: murmur asks, the user types, the tool
          // keeps it. It never becomes a message, so it never reaches the API
          // or the session transcript the SDK keeps (spec 03-03 §7.2).
          promptSecret: async (label) => {
            ask(host, `paste your ${label} and press enter (murmur reads it directly):`, 'question')
            // This read waits on the listener leaving for a browser, creating
            // a key and coming back — minutes, not seconds. The sign has to
            // say the keyboard is theirs, and never echo what they paste.
            host.setBusy?.(false)
            try {
              return await read({ echo: false })
            } finally {
              host.setBusy?.(true)
            }
          },
          // The URL is public knowledge; the key is not. Print only this.
          onWritten: (config) => host.info(`voice endpoint saved: ${config.ttsUrl}`),
        }),
        // The listener's own recording, cloned into a hosted voice. It reads
        // the key from the config the tool above wrote, so the guide can
        // finish the whole voice setup — timbre included — with the
        // credential never entering the conversation.
        createVoiceTool({
          home: targets.home,
          endpoint: () => targets.effectiveVoice?.() ?? targets.voiceConfig(),
          expandPath: expandUser,
          armAbort: () => {
            const since = flow.escEpoch
            return () => flow.escEpoch > since || quit.requested
          },
          onCreated: ({ referenceId, title }) =>
            host.info(`voice created and pinned: ${title} (${referenceId})`),
        }),
      ]
    : []

  // Whatever the session dies of — the SDK iterator throwing its interrupted
  // turn's error result (seen live on the Esc-Esc shape), a subprocess crash —
  // the radio still launches (spec 03-03): absorb, say so once, re-probe.
  try {
    await guide.runGuide({
    // Nothing to repair means nothing was authorized: the visit persona asks
    // before it touches anything, where the repair persona is pre-authorized.
    systemPrompt: gaps.length === 0 ? VISIT_PERSONA : GUIDE_PERSONA,
    prompt: buildSetupPrompt({
      gaps,
      ytdlp: targets.ytdlp,
      ffmpeg: targets.ffmpeg,
      bunCmd: targets.bunCmd,
    }),
    model: GUIDE_MODEL,
    maxTurns: GUIDE_MAX_TURNS,
    canUseTool: cliPermission(host, quit, () => flow.turnAborted),
    interrupt: quit.seen,
    onSession: (session) => (flow.session = session),
    ...(tools.length > 0 && { tools }),
    onText: (text) => host.info(text),
    // What the agent is doing, visibly: the command before it runs, the tail
    // of its output after — an authorized install must never run in silence.
    // A secret-hinting use gets its result withheld instead of echoed: info
    // lines mirror into the dev log, and the guard is a tripwire, not a
    // sandbox — something it missed on the way in must not be persisted on
    // the way out.
    onToolUse: (name, detail, id) => {
      if (SECRET_PATH.test(detail) || SECRET_NAME.test(detail)) secretUses.add(id)
      host.info(`-> [${name}] ${detail}`)
    },
    onToolResult: (output, isError, id) =>
      host.info(
        secretUses.has(id)
          ? '  (output withheld: may hold a credential)'
          : formatToolResult(output, isError),
      ),
    nextUserInput: cliConversation(host, read, quit, flow),
    })
  } catch (err) {
    host.debug?.(`guide session error: ${String(err)}`)
    host.info('the setup conversation ended unexpectedly; the radio goes on.', 'flow')
  }

  // The conversation is over: an Esc from here on has nothing to cut, and
  // the floor goes back NOW — the closing re-probe takes seconds, and a face
  // still reading "talking to the setup guide" would queue lines for the
  // wrong partner.
  flow.done = true
  flow.session = null
  host.setMode?.('radio')
  // The closing re-probe below is the engine's own work, not a turn the
  // listener is waiting on a partner for: the sign goes out with the floor.
  host.setBusy?.(false)

  // Leaving mid-conversation: the app is shutting down, so the gaps we knew
  // ARE the outcome — a re-probe (a live network search) and a closing verdict
  // would make the exit wait on work nobody will see.
  if (quit.requested) return outcomeFrom(targets, gaps)

  // Re-probe rather than believe the conversation: "the assistant said it
  // installed yt-dlp" is not the same fact as "yt-dlp works" (CLAUDE.md).
  const left = await detectGaps(targets, run.probes ?? {})
  if (quit.requested) return outcomeFrom(targets, left)
  if (left.length === 0) host.info('all set — everything is working now.')
  else host.info(`still not working: ${left.map((gap) => gap.kind).join(', ')}.`)
  return outcomeFrom(targets, left)
}

// The real validation: one synth through the pasted endpoint. A clip that comes
// back is the only proof that matters, and it costs one short line. It speaks
// with the WHOLE config — hosted fish.audio rejects a call without its key and
// `model` header, so a URL-only probe could only ever fail there (issue #96).
export async function validateEndpoint(
  config: VoiceConfig,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const voice = new HostedVoice({
    baseUrl: config.ttsUrl,
    ...(config.model !== undefined && { model: config.model }),
    ...(config.referenceId !== undefined && { referenceId: config.referenceId }),
    ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
    ...(config.seed !== undefined && { seed: config.seed }),
    ...(fetchImpl !== undefined && { fetch: fetchImpl }),
  })
  try {
    await voice.synthesize(VOICE_PROBE_LINE)
  } finally {
    await voice.close()
  }
}
