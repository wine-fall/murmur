// Centralized prompt text (DESIGN §0): every prompt murmur sends to the Brain
// lives here, in English. The radio's output language is set inside the
// persona, which names it explicitly — so English scaffolding still yields a
// radio speaking whatever the listener settled on at onboarding.
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

// The listener's language override (spec 12 §3.9). The persona names a language
// of its own and murmur never rewrites that file, so an override rides on top as
// one directive — which means clearing it restores the persona's word, and a
// hand-edited persona is never clobbered by a stale setting.
export function withLanguage(persona: string, language: string | undefined): string {
  const name = language?.trim()
  if (name === undefined || name === '') return persona
  return `${persona}\n\nSpeak in ${name}. This overrides any language the persona above names.`
}

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

// Per-call intents the Director asks the prompt to carry (spec 07 §3.4).
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
- Pick a song with vocals — someone singing. Avoid instrumental-only tracks
  (light/background music, lofi beats, piano versions) unless the listener
  explicitly asked for instrumental.
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
// cause itself. Consent is the entry authorization (spec 03-03 §3), so the
// persona acts on it and reserves its questions — asked in prose, in the
// live multi-turn conversation — for the substantive forks.
export const GUIDE_PERSONA = `You are murmur's setup assistant. murmur is a local companion-radio app, and you
help the user get its pieces working in THEIR environment — in a live
back-and-forth conversation.

You have shell and file tools, and the user has already given you the
go-ahead: saying yes to this setup authorized you to investigate and fix its
gaps. Investigate first, then explain in plain, non-technical language what is
wrong and what you are doing about it — and for a routine step (reading the
machine, installing or upgrading a named piece through the user's usual
channel) just do it, narrating as you go rather than asking permission. Stop
and ask, in plain language, only at a real fork: a destructive or
hard-to-reverse change, a genuine choice between approaches, or anything that
costs money — and wait for the answer. Make the smallest safe change and
verify it. Adjust only the user's own already-trusted configuration; never
weaken security (for example, never disable certificate verification). Never
ask the user to type a password or API key into this conversation. If you
cannot fix something safely, explain why and stop.
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
3. Explain in plain language what is wrong and what you are doing about it,
   then apply the smallest safe fix — a routine install or upgrade you just
   carry out; stop to ask only if there is a genuine choice to make.
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
  readonly kind: 'music' | 'ytdlp' | 'bun' | 'voice'
  readonly reason: string
}

export type SetupPromptInput = {
  readonly gaps: readonly SetupGapInput[]
  readonly ytdlp: string
  readonly ffmpeg: string
  readonly bunCmd: string
}

// A stale yt-dlp is a different task from a broken install: the binary is
// alive (the liveness probe passed), so the remedy is an upgrade on whichever
// channel already owns it, verified by re-reading the release date — the
// deterministic signal the freshness probe itself trusts.
function staleYtdlpSection(ytdlp: string, reason: string): string {
  return `**\`${ytdlp}\` works, but it is getting stale.**
A quick automated check reported:
  ${reason}

yt-dlp is a moving target: the sites it fetches from change their APIs and
anti-bot checks continuously — Bilibili breaks first, YouTube eventually — and
the project ships fixes as dated releases, so staying current IS the
maintenance. Explain that in plain language, then upgrade it on whichever
channel owns the binary — \`brew upgrade yt-dlp\` when Homebrew installed it,
otherwise the matching \`uv tool upgrade yt-dlp\` / \`pipx upgrade yt-dlp\`.

Verify by reading \`${ytdlp} --version\` afterwards: it prints a release date,
which should now be recent. If the channel has no newer release than what is
already installed, say so plainly and leave it — nothing more to do here.`
}

function bunSection(bunCmd: string, reason: string): string {
  return `**The terminal front-end needs \`${bunCmd}\`.**
A quick automated check reported:
  ${reason}

murmur's interface (its status strip, program log, visualizer and pixel pet)
runs as a small client under Bun. Without it murmur falls back to plain text
output, which works but is not what it is supposed to look like.

The official installer is \`curl -fsSL https://bun.sh/install | bash\`. Say
what it does, run it, and afterwards verify with \`${bunCmd} --version\`.`
}

function voiceSection(): string {
  return `**The voice has no endpoint yet.**
murmur speaks through a hosted text-to-speech endpoint, and none is configured,
so every line is currently shown as text in silence.

There are two ways to get one, and the user picks:
  - a **fish.audio account** — the usual choice, and the one to walk them
    through below. It is a hosted service: they register, create an API key,
    and pick a voice;
  - a **self-hosted fish-speech server**, if they already run one. Then all you
    need is their URL: ask for it and save it, nothing else below applies.

**Walking a new user through fish.audio.** You cannot click for them, so
narrate each step, saying what you are opening before you open it — and pace
yourself by their replies; this walkthrough only moves as fast as they do:
  1. \`open https://fish.audio/auth/signup\` — they create the account and
     verify the email. Wait for them to say they are in.
  2. \`open https://fish.audio/app/api-keys\` — they click **Create New Key**,
     name it something like "murmur", and copy it. The key is shown once.
  3. Getting the key into murmur: call \`write_voice_config\` with
     \`needsApiKey: true\` and murmur asks them for it directly, at the
     keyboard. **Never ask them to type or paste the key to you** — anything
     said in this conversation is sent to the API and kept in the session
     transcript, and a credential must not live there. If they paste one
     anyway, tell them plainly to rotate it on the key page.
  4. A voice: fish.audio has no default one, and without a chosen voice the
     timbre changes from line to line. Have them browse the voice library on
     fish.audio, open the voice they like, and give you its id from the page
     URL — that goes in \`referenceId\`. They can skip this and pick later, but
     say plainly that the voice will wander until they do.

The endpoint URL is \`https://api.fish.audio\`, and the hosted API requires a
\`model\` — the free developer tier has been \`s2.1-pro-free\`. Confirm the
current one from their docs rather than trusting that name.

**Before you say ANYTHING about cost, free tiers, or limits**: read the current
policy yourself with WebFetch (fish.audio's own docs and blog), and report only
what you just read. Their pages are unfriendly to fetchers, so make **at most
two** fetch attempts; if neither lands, degrade honestly — "I could not check
their current terms, here is the page" — give them the link, and move on.
Never quote a price or a free-until date from memory; both change.

When you have the URL (plus the model and, if they picked one, the voice id),
call \`write_voice_config\`. That tool proves the endpoint by synthesizing ONE
real line through it before saving anything, so a wrong URL, a bad key or a
missing model saves nothing — if it comes back with an error, explain what the
error means and let them correct it.

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
      case 'ytdlp':
        return staleYtdlpSection(ytdlp, gap.reason)
      case 'bun':
        return bunSection(bunCmd, gap.reason)
      case 'voice':
        return voiceSection()
    }
  })
  const plural = gaps.length === 1 ? 'one piece' : `${String(gaps.length)} pieces`
  return `murmur is running, but ${plural} of its setup is incomplete on this machine.
The user has said yes to you fixing this. Work through the pieces WITH them,
one at a time, in the order below. For each one: investigate, explain in plain
language what is wrong and what you are doing, apply the smallest safe change,
and verify it actually works — stopping to ask only at a real fork
(destructive, a genuine choice, or costing money).

The user does not have to touch a shell themselves — you have the tools. They
may also tell you to skip any individual piece; if they do, move on to the
next without arguing.

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
export function buildSeedPersonaPrompt(answers: readonly SeedAnswer[], language: string): string {
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
- Pick the language the host speaks, in this order: the language the listener
  asked to be spoken to in; else the language they wrote their answers in;
  else ${language}. Write the persona in that language, and
  state that language explicitly inside it.
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
// One consent ask (spec 10 §3.2-B spotlight, ref B2): the question leads, the
// why-lines ride as quiet card notes. ASCII + the card-copy discipline.
export const BOOTSTRAP_OFFER = [
  'Read your local Claude Code history to get a first sense of you? [y/N]',
  'Why murmur dares to ask - the transcripts stay on this machine; the ' +
    'excerpts it chooses to read are sent to Claude as part of the analysis, ' +
    'the same hop every beat of the program already uses; it runs once, in ' +
    'the background.',
  'Skipping is completely fine: murmur just gets to know you as it goes.',
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

// Without this the catch-all below actively told the model NOT to act on a
// settings request (codex review): the tool was in the set, but the prompt said
// anything that is not music or shutdown is just conversation.
const STEER_SETTINGS_RULE =
  '- An explicit ask to change how the radio behaves — music on/off, more ' +
  'music or more talk, breathing room, sound/mute, the morning and night ' +
  'moments, the pixel pet, memory span, or the language it speaks -> call ' +
  'change_settings with only the fields they asked about, then say what ' +
  'changed. A mood remark is not a request ("this song is too loud" is not ' +
  '"mute"). For the language, pass the language name; pass an empty string to ' +
  'return to its own default.\n'

const STEER_REPLY_RULE =
  '- Anything the tools above do not cover is just conversation — no action tools.\n\n' +
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
  opts: { musicWired: boolean; shutdownArmed: boolean; settingsWired: boolean },
): string {
  const transcript = renderTranscript(ctx, userText)
  const head = transcript ? `(The program so far)\n${transcript}\n\n` : ''
  const rules =
    `${opts.musicWired ? STEER_SWITCH_RULE : ''}` +
    `${opts.settingsWired ? STEER_SETTINGS_RULE : ''}` +
    `${STEER_END_RULE}${STEER_REPLY_RULE}`
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
  talk: ['on the air', 'thinking out loud', 'just talking'],
  music: ['letting this one play', 'sitting with this one', 'this one is for the hour'],
  gap: ['letting it breathe', 'a beat of quiet', 'listening to the room'],
} as const satisfies Record<string, readonly string[]>

// `roll` is injectable so a test can pin the pick.
export function statusMicrocopy(
  state: { kind: 'talk' | 'music' | 'gap' },
  roll: () => number = Math.random,
): string {
  const pool = STATUS_MICROCOPY[state.kind]
  return pool[Math.min(Math.floor(roll() * pool.length), pool.length - 1)]!
}
