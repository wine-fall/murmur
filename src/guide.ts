// Wire the guide harness into murmur's Host (spec 03-03), and run the
// conversational onboarding built on it (§7).
//
// The deterministic probes decide whether to engage; when they do, the guide
// runs with its ask/answer routed through the Host — the agent's text prints as
// it streams (onText), each pre-action permission request is printed and
// answered from the same stdin the Director uses (canUseTool), and the user's
// natural-language replies flow back (nextUserInput). We only route the SDK's
// prompts; the SDK owns the ask/execute semantics.
//
// The posture the onboarding slice adds: murmur assumes the user has Claude
// Code, so a gap is never a wall. The radio launches degraded and then OFFERS
// to fix itself by talking. runSetup is that offer — once per boot, actively,
// covering every gap in one conversation.

import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

import { toolDetail } from './brain.ts'
import type { GuideCapable, LedgerKind } from './contracts.ts'
import { ask, type Host } from './host.ts'
import { HostedVoice } from './hosted-voice.ts'
import { buildSetupPrompt, GUIDE_PERSONA } from './prompts.ts'
import {
  preflightBun,
  preflightMusic,
  preflightYtdlpFreshness,
  type PreflightResult,
} from './startup.ts'
import { type VoiceConfig, VOICE_PROBE_LINE, writeVoiceConfigTool } from './voice-config.ts'

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
export type ReadLine = () => Promise<string>

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

export function lineReader(host: Host, quit: QuitLatch): ReadLine {
  const eof: Promise<string> = host.eof?.().then(() => '') ?? new Promise<string>(() => {})
  let chain: Promise<unknown> = Promise.resolve()
  return () => {
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
        if (line.trim() === QUIT) {
          quit.fire()
          return ''
        }
        return line
      })
      return Promise.race([take, eof, quit.seen]).finally(() => (settled = true))
    })
    chain = read
    return read
  }
}

// Builtins that can only look, never touch. Write/Edit stay out on purpose.
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep'])

// Where credentials live (spec 03-03 §7.2: voice.json holds the api key,
// .env* the remote-voice creds). A "read" of these puts a secret into the SDK
// transcript, so it is never auto-allowed, whatever the tool (codex review).
const SECRET_BEARING = /\.env|voice\.json/i

// The read-only shapes the guide's diagnosis actually uses. Whole-segment
// anchors rather than command heads where the head alone is not enough:
// `yt-dlp --version` reads, `yt-dlp <url>` downloads.
const READONLY_SEGMENT = [
  /^which(\s|$)/,
  /^type\s/,
  /^command -v\s/,
  /^ls(\s|$)/,
  /^echo(\s|$)/,
  /^printf\s/,
  /^pwd$/,
  /^uname(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^wc(\s|$)/,
  /^yt-dlp --version$/,
  /^ffmpeg -version$/,
  /^bun --version$/,
  /^node --version$/,
  // `brew outdated` is NOT here: default Homebrew auto-updates its own
  // metadata before answering it, which mutates state (codex review).
  /^brew (info|list|config|doctor|--version|--prefix)(\s|$)/,
  /^uv (--version$|tool list)/,
  /^pipx (list|--version)/,
]

// A conservative classifier: is this Bash command incapable of changing the
// machine? Redirects and backticks disqualify outright; the rest is split at
// every separator (;, &&, ||, |, &, newline) AND around $(...) so each
// executable segment is judged on its own — one unknown head poisons the
// whole command. False negatives just fall back to asking; a false positive
// would execute silently, so every rule leans strict.
export function isReadOnlyCommand(command: string): boolean {
  if (/[><`]/.test(command)) return false
  // Parameter/env expansion can surface a credential into the transcript
  // (`echo $MURMUR_TTS_API_KEY`), so `$` is allowed only as `$?` or a `$(...)`
  // whose inner command is judged like any other segment (codex review).
  if (/\$(?![?(])/.test(command)) return false
  if (SECRET_BEARING.test(command)) return false
  const segments = command
    .split(/\|\||&&|[;&|\n]|\$\(|\)/)
    .map((piece) => piece.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter((piece) => piece !== '')
  if (segments.length === 0) return false
  return segments.every((segment) => READONLY_SEGMENT.some((rule) => rule.test(segment)))
}

// Ask the user via the CLI Host before each tool the guide wants to run, and
// return the SDK's allow/deny result. Anything but an explicit yes denies.
// One carve-out (spec 03-03 §7.1): the card's 'y' already covered LOOKING, so
// pure reads flow without another ask and the per-action consent lands on the
// CHANGES — a wall of y/N for `which` and `--version` buries the one confirm
// that matters. The dev log keeps a record of what was auto-allowed.
export function cliPermission(host: Host, read: ReadLine, quit: QuitLatch): CanUseTool {
  return async (toolName, input) => {
    // A user who is leaving gets no consent card: deny outright so the
    // session winds down instead of parking a question nobody will answer.
    if (quit.requested) return { behavior: 'deny', message: 'user quit' }
    const detail = toolDetail(input)
    if (
      (READONLY_TOOLS.has(toolName) && !SECRET_BEARING.test(JSON.stringify(input))) ||
      (toolName === 'Bash' && typeof input.command === 'string' && isReadOnlyCommand(input.command))
    ) {
      host.debug?.(`guide auto-allowed read-only [${toolName}]: ${detail}`)
      return { behavior: 'allow' }
    }
    // One self-contained ask: a docked "allow?" with the command left behind
    // in the log would ask the user to approve something they cannot see.
    ask(host, `setup assistant wants to run [${toolName}]: ${detail}\nallow? [y/N]`, 'consent')
    if (isYes(await read())) return { behavior: 'allow' }
    return { behavior: 'deny', message: 'user declined' }
  }
}

// Read the user's next natural-language reply from the CLI Host. An empty
// line or /done|/quit|q ends the conversation (returns null).
export function cliConversation(
  host: Host,
  read: ReadLine,
  quit: QuitLatch,
): () => Promise<string | null> {
  return async () => {
    if (quit.requested) return null
    ask(host, 'your reply (natural language; empty or /done to finish):', 'question')
    const line = (await read()).trim()
    return END.has(line.toLowerCase()) ? null : line
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
  // The saved config behind that URL, re-read the same way: what the run wires
  // its voice from once the conversation is over (issue #96).
  readonly voiceConfig: () => VoiceConfig | null
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
  if (targets.wantsVoice && targets.voiceUrl().trim() === '') {
    gaps.push({ kind: 'voice', reason: 'no endpoint configured' })
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
  voice: 'there is no voice endpoint yet, so lines are shown instead of spoken',
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
  const options = explicit
    ? ['>> y - fix them now', '>> Enter - skip for now']
    : [
        '>> y - fix them now',
        ">> Enter - not now (I'll offer again next boot)",
        ">> n - don't ask again (make setup reopens this)",
      ]
  return [`a couple of things aren't set up on this machine: ${named}.`, ...rows, ...options].join(
    '\n',
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
// opens a real conversation — the guide investigates, proposes, asks per action,
// applies, and verifies. Declining is the only thing that makes later boots
// quiet, and it costs exactly one info line thereafter.
export async function runSetup(run: SetupRun): Promise<SetupOutcome> {
  const { host, guide, targets } = run
  // A caller without a latch (the explicit CLI entries) still gets one: a
  // typed /quit inside the conversation ends it the same way everywhere.
  const quit = run.quit ?? quitLatch()
  const explicit = run.explicit === true
  // The probes take real seconds (yt-dlp is a live network search): say so
  // first, so the front-end has a loading signal instead of a silent stall.
  host.info('checking the gear on this machine...')
  const gaps = await detectGaps(targets, run.probes ?? {})
  if (gaps.length === 0) return outcomeFrom(targets, gaps)

  const named = gaps.map((gap) => PLAIN_ENGLISH[gap.kind]).join('; ')

  // A standing decline: one line, no question, no re-nagging (§7.1 point 3).
  if (!explicit && run.ledger?.recentEvents('setup', 1).includes(SETUP_DECLINED) === true) {
    host.info(`${named}. Run \`make setup\` whenever you want to sort that out.`)
    return outcomeFrom(targets, gaps)
  }

  // The offer and the guide both read the keyboard; make sure the reader is up
  // (idempotent — the Director starts it too).
  host.start()
  const read = lineReader(host, quit)
  // Probe detail (the raw reason) is diagnostics, not card copy: the guide
  // gets it via its prompt, the dev log keeps it for humans.
  for (const gap of gaps) host.debug?.(`gap ${gap.kind}: ${gap.reason}`)
  ask(host, setupOfferText(targets, gaps, explicit), 'consent')

  const answer = await read()
  if (!isYes(answer)) {
    // Leaving is not answering (codex review): a /quit mid-offer must not
    // become a standing decline that silences every later boot.
    if (quit.requested) return outcomeFrom(targets, gaps)
    // Only the boot-time offer records the standing answer — and only for an
    // EXPLICIT no. Enter reads as the default-confirm to half the world, and
    // an unrecognized answer is "not now", never "never again". Backing out
    // of an explicit `make setup` is not "stop asking me" either.
    if (!explicit && isNo(answer)) {
      run.ledger?.recordEvent('setup', SETUP_DECLINED)
      host.info("no problem — I won't ask again. `make setup` reopens this any time.")
    } else if (explicit) {
      host.info('skipped setup.')
    } else {
      host.info("not now, then — I'll offer again next boot; `make setup` any time.")
    }
    return outcomeFrom(targets, gaps)
  }

  // Tool uses whose OUTPUT must not be echoed (and thereby dev-logged).
  const secretUses = new Set<string>()
  const wantsVoice = gaps.some((gap) => gap.kind === 'voice')
  const tools = wantsVoice
    ? [
        writeVoiceConfigTool({
          home: targets.home,
          validate: run.validateVoice ?? ((config) => validateEndpoint(config)),
          // The secret's own channel: murmur asks, the user types, the tool
          // keeps it. It never becomes a message, so it never reaches the API
          // or the session transcript the SDK keeps (spec 03-03 §7.2).
          promptSecret: async (label) => {
            ask(host, `paste your ${label} and press enter (murmur reads it directly):`, 'question')
            return await read()
          },
          // The URL is public knowledge; the key is not. Print only this.
          onWritten: (config) => host.info(`voice endpoint saved: ${config.ttsUrl}`),
        }),
      ]
    : []

  await guide.runGuide({
    systemPrompt: GUIDE_PERSONA,
    prompt: buildSetupPrompt({
      gaps,
      ytdlp: targets.ytdlp,
      ffmpeg: targets.ffmpeg,
      bunCmd: targets.bunCmd,
    }),
    model: GUIDE_MODEL,
    maxTurns: GUIDE_MAX_TURNS,
    canUseTool: cliPermission(host, read, quit),
    interrupt: quit.seen,
    ...(tools.length > 0 && { tools }),
    onText: (text) => host.info(text),
    // What the agent is doing, visibly: the command before it runs, the tail
    // of its output after — a consented install must never run in silence.
    // One exception: a secret-bearing tool use the user approved BY HAND is
    // outside the auto-allow guard, and info lines mirror into the dev log —
    // so its result is withheld rather than persisted (codex review).
    onToolUse: (name, detail, id) => {
      if (SECRET_BEARING.test(detail)) secretUses.add(id)
      host.info(`-> [${name}] ${detail}`)
    },
    onToolResult: (output, isError, id) =>
      host.info(
        secretUses.has(id)
          ? '  (output withheld: may hold a credential)'
          : formatToolResult(output, isError),
      ),
    nextUserInput: cliConversation(host, read, quit),
  })

  // Leaving mid-conversation: the app is shutting down, so the gaps we knew
  // ARE the outcome — a re-probe (a live network search) and a closing verdict
  // would make the exit wait on work nobody will see.
  if (quit.requested) return outcomeFrom(targets, gaps)

  // Re-probe rather than believe the conversation: "the assistant said it
  // installed yt-dlp" is not the same fact as "yt-dlp works" (CLAUDE.md).
  const left = await detectGaps(targets, run.probes ?? {})
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
