// Centralized prompt text (DESIGN §0): every prompt murmur sends to the Brain
// lives here, in English. The radio's output language is set inside the
// persona seed (it instructs Chinese speech), so English scaffolding still
// yields a Chinese-speaking radio.
//
// Spec-01 builders only; later phases add profile/covered-topics/scene blocks
// (specs 04/05) when their data exists.

import { fileURLToPath } from 'node:url'

import type { ContextPack, SeedAnswer, Turn } from './contracts.ts'

// The bundled static persona seed (L0). Spec 06 will generate/evolve personas
// at runtime; this is only the default.
export const DEFAULT_PERSONA_PATH = fileURLToPath(
  new URL('./prompts/persona-seed.md', import.meta.url),
)

// Output discipline appended to every Brain call: the result is fed straight
// to TTS, so it must be clean spoken text with no markup or stage directions.
const OUTPUT_RULES =
  'Output only the words you say out loud — nothing else. Keep it short and ' +
  'spoken, one small beat of radio (a few sentences, not a monologue). No ' +
  'prefixes, speaker labels, quotation marks, or stage directions.'

// Per-scene mood cue threaded into the self-initiated talk prompts (spec 04
// §3.4). A scene with no entry here (or undefined) simply gets no cue, so an
// unknown bucket degrades silently.
const SCENE_GUIDANCE: Record<string, string> = {
  morning: "It's morning where they are — meet it with a gentle, just-waking warmth.",
  afternoon: "It's the afternoon — an easy, unhurried mid-day company.",
  evening: "It's the evening — the day winding down, warm and settling.",
  'late-night': "It's late at night — keep it hushed and intimate, the small-hours mood.",
}

function sceneLine(ctx: ContextPack): string {
  const cue = SCENE_GUIDANCE[ctx.scene ?? '']
  return cue === undefined ? '' : `\n${cue}`
}

// Presence cue (spec 07 §2.2). Written so the host adjusts its MANNER and never
// narrates the sensing — the listener is kept company, not observed. An absent
// or unmapped value renders nothing.
export const ACTIVITY_GUIDANCE: Record<string, string> = {
  engaged: "They're right here with you — you can be warm and responsive, talking with someone, not at them.",
  present: "They're around but quiet — companionable, unhurried, nothing that demands an answer.",
  away: 'The room is quiet — keep it low and unhurried, the way you would with someone half-asleep in the next room.',
}

// Per-call intents the Director asks the prompt to carry (spec 07 §3.4/§3.5).
// Local policy decides WHETHER; the model writes WHAT. An unknown key renders
// nothing, so a cue this build does not know degrades to an ordinary beat.
export const CUE_GUIDANCE: Record<string, string> = {
  'anchor:morning':
    'This beat opens their day: a good-morning, in your own voice, that meets ' +
    'them where the morning actually is — not a greeting formula.',
  'anchor:midday':
    'This beat lands in the middle of their day: a short check-in over the ' +
    'hump, the kind you offer someone mid-shift.',
  'anchor:night':
    'This beat closes the day: a good-night that lets it settle, quiet and ' +
    'unhurried, asking nothing of them.',
  invite:
    'End ONE of these beats by turning to the listener — something small and ' +
    'genuinely curious that grows out of what you were just saying, and mark ' +
    'that beat with `invite: true`. Ask because you want to know, not because ' +
    'you need an answer: no pressing, no "are you there", nothing needy.',
  'slide-back':
    'You turned to them a little while ago and nobody answered. Move on ' +
    'gracefully: pick the program back up, do not repeat the question, and do ' +
    'not remark on the silence.',
}

function pacingLines(ctx: ContextPack): string {
  const activity = ACTIVITY_GUIDANCE[ctx.activity ?? '']
  const cue = CUE_GUIDANCE[ctx.cue ?? '']
  return `${activity === undefined ? '' : `\n${activity}`}${cue === undefined ? '' : `\n${cue}`}`
}

// The tier-① listener profile as a leading stable block (spec 05 §3.5): it
// precedes the volatile transcript so persona + profile form the cache-friendly
// stable prefix (master §7 pillar 4). Empty -> nothing (degrade silently).
function profileBlock(ctx: ContextPack): string {
  const profile = ctx.profile?.trim()
  return profile ? `(What you know about the listener)\n${profile}\n\n` : ''
}

// A single volatile "recently covered — don't repeat" cue from the tier-③
// ledger (spec 05 §3.5). Ledger-backed and cross-day, so it holds even when the
// transcript is empty (the issue-#44 cold-open case). Empty -> nothing.
function coveredLine(ctx: ContextPack): string {
  if (ctx.coveredTopics === undefined || ctx.coveredTopics.length === 0) return ''
  return `\n(Recently covered — don't repeat these: ${ctx.coveredTopics.join(', ')})`
}

// Render recent turns as a transcript. The host's own prior lines are "You";
// the listener's lines are "Listener".
function renderTranscript(ctx: ContextPack, dropTrailingUser?: string): string {
  let turns = [...ctx.recent]
  const last = turns.at(-1)
  if (dropTrailingUser !== undefined && last?.role === 'user' && last.text === dropTrailingUser) {
    turns = turns.slice(0, -1)
  }
  return turns
    .map((t) => `${t.role === 'radio' ? 'You' : 'Listener'}: ${t.text}`)
    .join('\n')
}

// Prompt for a single self-initiated talk segment (the fallback path when the
// batched tool call degrades — spec 04 §3.2).
export function buildNextTalkPrompt(ctx: ContextPack): string {
  const transcript = renderTranscript(ctx)
  const head = transcript
    ? `(The program so far)\n${transcript}\n\nNow continue — say your next beat.`
    : 'The program is just starting. Open naturally with your first beat.'
  return `${profileBlock(ctx)}${head}${coveredLine(ctx)}${sceneLine(ctx)}${pacingLines(ctx)}\n${OUTPUT_RULES}`
}

// Prompt for the next `count` self-initiated beats in one call. The beats come
// back via the emit_talk_beats tool (structured output — see talk-tools.ts),
// so the shape lives in that tool's schema, not here.
export function buildNextTalksPrompt(ctx: ContextPack, count: number): string {
  const transcript = renderTranscript(ctx)
  const head = transcript
    ? `(The program so far)\n${transcript}\n\nNow continue — say your next ${count} beats.`
    : `The program is just starting. Open naturally with your first ${count} beats.`
  return (
    `${profileBlock(ctx)}${head}${coveredLine(ctx)}${sceneLine(ctx)}${pacingLines(ctx)}\n` +
    'Each beat is one small stretch of radio (a few sentences, spoken aloud — ' +
    'no markup, labels, or stage directions). Return ' +
    `all ${count} beats in order by calling the emit_talk_beats tool.`
  )
}

// --- music discovery (spec 03-01 §2.3/§2.5) ------------------------------- //

// Header prefixing the volatile context block in the music task turn.
export const MUSIC_CONTEXT_HEADER = 'Current context for choosing music:\n'

// The selection heuristics live in the task instruction (not scattered in code,
// and not a formal SDK skill for now). English scaffolding; the listener's
// language and taste come from the persona.
export const FIND_MUSIC_INSTRUCTION = `Choose ONE piece of music to play next on a personal radio.

Use the search_music tool to find candidates, judge them against the persona and
the context below, then call submit_pick with the single best track and a short
reason.

Guidance:
- Prefer official audio / studio versions; avoid hour-long loops, low-quality
  re-uploads, and live or cover versions unless they clearly fit the moment.
- Match the listener's taste and language as expressed by the persona.
- Do not repeat something already noted as recently played.
- If your pick fails to resolve, pick another candidate and submit again.
- In submit_pick, also pass the track's title and artist (from the candidate),
  and write \`announce\`: ONE short spoken line introducing the track, in the
  persona's voice and language — like a radio DJ's "up next". No quotes around
  it, no markdown; it will be read aloud over the song's opening.`

// The volatile situation block (spec 03-02 §1 #9): the session's recent turns
// plus the Director's intent. Recently-played songs to avoid arrive with the
// spec-05 ledger; an empty list renders nothing.
export function buildMusicSituation(recent: readonly Turn[], avoid: readonly string[] = []): string {
  const turns = recent.map((t) => `- ${t.role === 'radio' ? 'You' : 'Listener'}: ${t.text}`).join('\n')
  const avoidBlock =
    avoid.length === 0
      ? ''
      : `\nRecently played -- do not repeat these:\n${avoid.map((song) => `- ${song}`).join('\n')}\n`
  return (
    `Recent on-air turns:\n${turns || '- (the program just started)'}\n${avoidBlock}` +
    'Intent: a music break in the program. Pick something that fits the mood and\n' +
    "subjects of the conversation above (or the persona's taste if it is quiet)."
  )
}

// --- cadence (spec 03-02 §2.3, brain mode only) --------------------------- //

export const CADENCE_INSTRUCTION = `You are pacing a personal radio program. Decide what the NEXT segment should
be: more talk, or a piece of music.

Think like a radio host: talk builds connection, music gives the listener room
to breathe. Avoid long talk-only stretches and avoid wall-to-wall music.

Call choose_segment exactly once with your decision.`

export const CADENCE_STATE_HEADER = 'Current program state:\n'

// --- guide harness (spec 03-03) ------------------------------------------- //

// Shapes the native Claude Code agent into a careful setup assistant. Behavior
// only — never the specific remedy; the agent diagnoses the (often uncertain)
// cause itself. Consent is enforced by the per-action permission gate
// (canUseTool), and the persona ALSO asks in prose: the TS guide is a real
// multi-turn conversation, so "ask, then wait for the go-ahead" is meaningful.
export const GUIDE_PERSONA = `You are murmur's setup assistant. murmur is a local companion-radio app, and you
help the user get its pieces working in THEIR environment — in a live
back-and-forth conversation.

You have shell and file tools. Investigate first, then explain in plain,
non-technical language what is wrong and the fix you propose. ALWAYS ask the user
to confirm before you make any change, and WAIT for their go-ahead — do not
change anything until they agree. When there is a real choice (e.g. a quick fix
vs a more permanent one), lay out the options and let them pick. Once they
confirm, carry it out: make the smallest safe change and verify it. Adjust only
the user's own already-trusted configuration; never weaken security (for example,
never disable certificate verification). If you cannot fix it safely, explain why
and stop.
`

export type FixMusicPromptInput = {
  readonly ytdlp: string
  readonly ffmpeg: string
  readonly reason?: string
}

// High-level task: diagnose (cause unknown) and repair the music dependencies.
// Deliberately does NOT prescribe the fix — but it DOES state a channel
// preference (spec 03-03 §7.1): Homebrew is the same channel ffmpeg comes from,
// so a machine ends up with one package manager owning both binaries instead of
// a brew/uv split that nobody remembers how to upgrade.
export function buildFixMusicPrompt({ ytdlp, ffmpeg, reason = '' }: FixMusicPromptInput): string {
  const finding = reason ? `\nA quick automated check just reported:\n  ${reason}\n` : ''
  return `murmur's music depends on TWO external binaries: \`${ytdlp}\` (fetches tracks) and
\`${ffmpeg}\` (decodes audio). One or both may be missing or broken in this
environment.
${finding}
Please:

1. Check each of them (e.g. a trivial \`${ytdlp}\` search; \`${ffmpeg} -version\`).
2. For whichever is not working, figure out WHY — "not installed at all" is a
   perfectly common cause.
3. Explain in plain language what is wrong and the fix you propose, then ASK me
   to confirm before changing anything and WAIT for my go-ahead. Once I agree,
   apply the smallest safe fix.
   For a MISSING binary, prefer the user's own package manager — on macOS that
   is Homebrew (\`brew install yt-dlp\` / \`brew install ffmpeg\`), which keeps
   both binaries on ONE upgrade path. Only if Homebrew is unavailable or cannot
   provide it, fall back to a Python-tool installer (uv tool / pipx) for
   yt-dlp.
4. Verify BOTH now work.
`
}

// --- conversational onboarding (spec 03-03 §7) ---------------------------- //

// One gap the deterministic probes found, in the shape the prompt renders.
export type SetupGapInput = {
  readonly kind: 'music' | 'bun' | 'voice'
  readonly reason: string
}

export type SetupPromptInput = {
  readonly gaps: readonly SetupGapInput[]
  readonly ytdlp: string
  readonly ffmpeg: string
  readonly bunCmd: string
}

function bunSection(bunCmd: string, reason: string): string {
  return `**The terminal front-end needs \`${bunCmd}\`.**
A quick automated check reported:
  ${reason}

murmur's interface (its status strip, program log, visualizer and pixel pet)
runs as a small client under Bun. Without it murmur falls back to plain text
output, which works but is not what it is supposed to look like.

The official installer is \`curl -fsSL https://bun.sh/install | bash\`. Explain
what it does, ask before running it, and afterwards verify with
\`${bunCmd} --version\`.`
}

function voiceSection(): string {
  return `**The voice has no endpoint yet.**
murmur speaks through a hosted text-to-speech endpoint, and none is configured,
so every line is currently shown as text in silence.

There are two ways to get one, and the user picks:
  - a fish.audio account, which gives them an API key and a hosted endpoint URL;
  - a self-hosted fish-speech server, which gives them a URL of their own.

Explain both in plain language, then ask them to paste the endpoint URL. When
they do, call the \`write_voice_config\` tool with it. That tool proves the
endpoint by synthesizing ONE real line through it before saving anything, so a
wrong or dead URL saves nothing — if it comes back with an error, explain what
the error means and let them correct it.

Do NOT write \`.env\` or any other file for this, and do not ask them to. The
\`write_voice_config\` tool is the only supported way to set the endpoint.`
}

// The whole onboarding surface as ONE conversation (spec 03-03 §7.1): the gaps
// the deterministic probes actually found, each with its findings as evidence.
// The remedy is still never prescribed — only the install CHANNEL preference is.
export function buildSetupPrompt({ gaps, ytdlp, ffmpeg, bunCmd }: SetupPromptInput): string {
  const sections = gaps.map((gap) => {
    switch (gap.kind) {
      case 'music':
        return buildFixMusicPrompt({ ytdlp, ffmpeg, reason: gap.reason })
      case 'bun':
        return bunSection(bunCmd, gap.reason)
      case 'voice':
        return voiceSection()
    }
  })
  const plural = gaps.length === 1 ? 'one piece' : `${String(gaps.length)} pieces`
  return `murmur is running, but ${plural} of its setup is incomplete on this machine.
Work through them WITH the user, one at a time, in the order below. For each
one: investigate, explain in plain language, propose the fix, ask, wait for the
go-ahead, apply the smallest safe change, and verify it actually works.

The user does not have to touch a shell themselves — you have the tools. They
may also decline any individual piece; if they do, move on to the next without
arguing.

${sections.join('\n\n---\n\n')}

When every piece is either fixed or explicitly skipped, say so in one short
sentence and stop.
`
}

// --- compaction (spec 05 §3.6) -------------------------------------------- //

// Hard cap on the profile the model returns — keeps the pack's stable prefix
// small (master §7 pillar 4). By-feel tunable (spec 05 §6).
export const PROFILE_CHAR_CAP = 1500

// A neutral system framing (not the persona) keeps the fold as bookkeeping,
// not the host speaking.
export const COMPACTION_SYSTEM_PROMPT =
  'You maintain a concise long-term profile of a radio listener.'

// The shape of the profile file, shared by the two writers of it: compaction
// (spec 05 §3.6, extended by spec 06 slice C) and the one-shot bootstrap (spec
// 06 slice B). Both produce the SAME two sections so the first compaction
// merges into a bootstrapped profile instead of fighting it.
const PROFILE_SHAPE = `The profile has exactly two labelled sections, in this order:

(About the listener)
Identity, stable preferences, recurring topics and interests, standing context
worth remembering across sessions.

(Relationship & style)
What tone lands with this listener, how they talk back, running jokes, moments
worth calling back to, subjects to handle lightly. This section is
OBSERVATIONAL, not directive: it records what has actually worked, and it never
states who the host is — the persona owns that.`

const COMPACTION_INSTRUCTION = `You maintain a long-term listener profile for a personal companion radio. Fold
the durable facts from the recent transcript into the existing profile.

${PROFILE_SHAPE}

Drop: ephemera, one-off small talk, anything transient. Merge — do not simply
append; rewrite the profile so it stays coherent and non-repetitive.

Return ONLY the updated profile text, both sections under their labels, in the
listener's own language, under ${PROFILE_CHAR_CAP} characters total. No preamble
or commentary.
`

// The compaction turn: current profile + the recent transcript to fold.
export function buildCompactionPrompt(profile: string, transcript: readonly Turn[]): string {
  const current = profile.trim() || '(no profile yet)'
  const lines = transcript.map((t) => `${t.role}: ${t.text}`).join('\n') || '(nothing)'
  return (
    `${COMPACTION_INSTRUCTION}\n` +
    `(Current profile)\n${current}\n\n` +
    `(Recent transcript to fold in)\n${lines}`
  )
}

// --- first run (spec 06) --------------------------------------------------- //

// Hard cap on the generated persona: it is the stable, cached prefix of every
// later Brain call (master §7 pillar 4). By-feel tunable (spec 06 §6).
export const PERSONA_CHAR_CAP = 1200

// Below this a "persona" is degenerate — a refusal, an apology, one stray line.
// Treated as a generation failure, so the bundled seed is used instead (§3.3).
export const PERSONA_MIN_CHARS = 120

// What each question must elicit is fixed by spec 06 §3.2; only the wording
// lives here. Asked in this order, each answerable in one line.
export const SEED_QUESTIONS = [
  "Who's listening? What should I call you, and what do your days usually look " +
    'like — work or study, and the hours you keep?',
  'What do you want on the air? Company while you work, someone to think out ' +
    'loud with, late-night talk, mostly music — whatever you picture.',
  'How do you like to be talked to? Dry, warm, chatty, quiet — and which ' +
    'language should I speak?',
] as const

export const FIRST_RUN_INTRO =
  "This is murmur's first run, so it has no voice yet. Three short questions " +
  'shape the host you will be listening to — answer in a line each, or press ' +
  'Enter to skip any of them.'

// Neutral framing (not a persona): this call writes a character, it does not
// speak as one.
export const SEED_PERSONA_SYSTEM_PROMPT =
  'You write the character prompt for the host of a personal companion radio.'

// Fold the onboarding answers into a complete standalone persona — the same
// shape a hand-written seed has, so spec 01's loader cannot tell them apart.
export function buildSeedPersonaPrompt(answers: readonly SeedAnswer[]): string {
  const said = answers
    .filter((a) => a.answer.trim() !== '')
    .map((a) => `Q: ${a.question}\nA: ${a.answer.trim()}`)
    .join('\n\n')
  return `A new listener just answered a few questions about the radio host they want.
Write that host's character as a complete, standalone system prompt, addressed
to the host as "you".

(What they said)
${said}

Rules:
- Write the host's CHARACTER — who it is, how it speaks, how it keeps company.
  It is not a summary of the answers and never mentions this questionnaire.
- Write it in the language the listener asked to be spoken to in, and state
  that language explicitly inside the persona.
- Keep it time-neutral. The host is not a late-night host, a morning host, or
  a host for any season — not even when the listener says what hours they keep.
  Their hours are context about THEM; the host meets them at any hour, and the
  moment is supplied per beat elsewhere.
- Do not invent biography the answers do not support. Where they said nothing,
  stay open rather than guessing.
- Under ${PERSONA_CHAR_CAP} characters.

Return ONLY the persona text. No preamble, no commentary, no code fences.
`
}

// The slice-B offer (spec 06 §3.4). Stated plainly: what is read, what crosses
// the already-sanctioned Claude hop, and that skipping costs nothing.
export const BOOTSTRAP_OFFER = [
  'One optional shortcut: murmur can read your local Claude Code history to ' +
    'get a first sense of who you are, so it does not start from nothing.',
  'The transcripts stay on this machine, but the excerpts it chooses to read ' +
    'are sent to Claude as part of the analysis — the same hop every beat of ' +
    'the program already uses. It runs once, in the background.',
  'Skipping is completely fine: murmur just gets to know you as it goes. ' +
    'Read your Claude Code history? [y/N]',
] as const

export const BOOTSTRAP_PROFILE_SYSTEM_PROMPT =
  'You build a concise long-term profile of a radio listener from their own ' +
  'working notes and transcripts.'

export const BOOTSTRAP_PROFILE_INSTRUCTION = `Build the FIRST listener profile for a personal companion radio, from the
listener's own Claude Code history on this machine.

Use list_sessions to see what is there, read_session to read the ones that look
most telling (the newest and the largest are usually the richest), and
read_instructions for their global instructions file if it exists. Read a
handful — enough for a picture, not an audit. Then call submit_profile once.

${PROFILE_SHAPE}

Record durable signal: the domains they work in, the tools and languages they
use, how they phrase things, the problems that keep coming back, the hours they
keep. EXCLUDE secrets, credentials, tokens, employer-confidential detail, and
anything that reads as surveillance rather than acquaintance — this is a radio
host getting acquainted, not a dossier.

Write it in the listener's own language, under ${PROFILE_CHAR_CAP} characters
total, and pass it to submit_profile as plain text.`

// Prompt for an in-persona reply to a typed user line. Carries the profile
// block too (spec 05 §3.5): a direct reply is exactly where cross-session
// listener facts should shape what the host says back.
export function buildRespondPrompt(userText: string, ctx: ContextPack): string {
  const transcript = renderTranscript(ctx, userText)
  const head = transcript ? `(The program so far)\n${transcript}\n\n` : ''
  return (
    `${profileBlock(ctx)}${head}The listener just said to you: "${userText}"\n` +
    `Respond in character, then ease back into the program.\n${OUTPUT_RULES}`
  )
}

// --- the steer task (spec 11 §2.2) ----------------------------------------- //

// The reply turn's instruction: decide whether the listener's words ask the
// program to DO something, act with the tools, then answer. Bullets are gated
// on the wired capabilities so the model is never offered an action the
// program cannot perform.
const STEER_SWITCH_RULE =
  '- Different or next music, skip this song, or a specific style/artist/mood ' +
  'request -> call switch_music FIRST (put the stated style, artist, or mood ' +
  'in `hint`). In the reply: acknowledge, cover the wait, and never name or ' +
  'promise a specific track — the next one introduces itself when it airs.\n'

const STEER_END_RULE =
  '- An explicit ask to stop or close the radio -> call end_broadcast and ' +
  'follow its status. Never call it for a mood remark (tired is not a request).\n'

const STEER_REPLY_RULE =
  '- Anything else is just conversation — no action tools.\n\n' +
  'Always finish by calling submit_reply with your spoken reply, in character, ' +
  'easing back into the program.'

// Rides the prompt only while the Director's armed flag is set (spec 11 §2.1):
// the model must know it is in the confirm leg of the two-phase shutdown.
export const STEER_ARMED_NOTE =
  'Shutdown is ARMED: last turn you asked the listener to confirm closing the ' +
  'radio. If this turn confirms it, call end_broadcast again to close; if it ' +
  'does not, do NOT call end_broadcast and just carry on (it disarms on its own).'

export function buildSteerPrompt(
  userText: string,
  ctx: ContextPack,
  opts: { musicWired: boolean; shutdownArmed: boolean },
): string {
  const transcript = renderTranscript(ctx, userText)
  const head = transcript ? `(The program so far)\n${transcript}\n\n` : ''
  const rules = `${opts.musicWired ? STEER_SWITCH_RULE : ''}${STEER_END_RULE}${STEER_REPLY_RULE}`
  const armed = opts.shutdownArmed ? `\n\n${STEER_ARMED_NOTE}` : ''
  return (
    `${profileBlock(ctx)}${head}The listener just said to you: "${userText}"\n\n` +
    `Decide whether their words ask the program to DO something; act with the ` +
    `tools if so, then answer them.\n${rules}${armed}`
  )
}

// --- status microcopy (spec 10 §3.7.4) ------------------------------------- //

// What the front-end's status strip says the program is doing — in the DJ's own
// words, never a loader's ("finding something for this hour…", not "loading").
// A fixed local pool: the chrome is authored text, so it costs zero tokens
// (master §7 pillar 6) and never waits on a model.
//
// It lives here, with every other line murmur speaks, rather than in the TUI:
// the front-end renders the persona's voice, it does not write it. That is why
// the picked line travels on the wire's `state` message.
export const STATUS_MICROCOPY = {
  awaiting: [
    'turning to you — say anything',
    'your turn, whenever you like',
    'the mic is yours',
  ],
  talk: ['on the air', 'thinking out loud', 'just talking'],
  music: ['letting this one play', 'sitting with this one', 'this one is for the hour'],
  gap: ['letting it breathe', 'a beat of quiet', 'listening to the room'],
} as const satisfies Record<string, readonly string[]>

// An open invite is the one thing the strip must say out loud, whatever segment
// is on air (§3.2-A) — a listener who missed the spoken turn-to-you can still
// see it. `roll` is injectable so a test can pin the pick.
export function statusMicrocopy(
  state: { kind: 'talk' | 'music' | 'gap'; awaitingReply: boolean },
  roll: () => number = Math.random,
): string {
  const pool = STATUS_MICROCOPY[state.awaitingReply ? 'awaiting' : state.kind]
  return pool[Math.min(Math.floor(roll() * pool.length), pool.length - 1)]!
}
