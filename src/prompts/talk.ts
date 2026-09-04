// The self-initiated talk beats (spec 01 §3.2, spec 04): the ContextPack
// renderers every persona-voiced prompt shares (profile, clock/scene, music
// status, transcript), the beat-shaped grounding rules, and the next-beat(s)
// builders. reply.ts reuses the shared renderers for the typed-line turns.

import type { ContextPack } from '../contracts.ts'

// Output discipline appended to every Brain call: the result is fed straight
// to TTS, so it must be clean spoken text with no markup or stage directions.
export const OUTPUT_RULES =
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

// The clock is bearings, not a line (spec 04 bugfix): the host knows the hour
// the way a person in the room does, and a person in the room does not read
// the date out. Every path that shows the clock says so — with the one
// exception a reply turn needs, a listener asking outright.
const CLOCK_USAGE =
  'That is your bearings, not a line to say: mention the hour or the day only ' +
  'when it genuinely lands in what you are already talking about, or when the ' +
  'listener asks you outright — never as an announcement, a time-check, or a ' +
  'way to open.'

function sceneLine(ctx: ContextPack): string {
  const time = ctx.time === undefined ? '' : `\nThe clock reads ${ctx.time}. ${CLOCK_USAGE}`
  const cue = SCENE_GUIDANCE[ctx.scene ?? '']
  return `${time}${cue === undefined ? '' : `\n${cue}`}`
}

// The program's real music status (spec 04 bugfix): stated as fact so the beat
// speaks from what the radio is actually doing, never an imagined program.
// Absent renders nothing (music not wired).
function musicLine(ctx: ContextPack): string {
  const music = ctx.music
  if (music === undefined) return ''
  switch (music.kind) {
    case 'playing':
      return `\n(On the air: "${music.track}" is playing right now.)`
    case 'quiet':
      return music.lastTrack === undefined
        ? '\n(No music is playing right now.)'
        : `\n(No music is playing; the last song was "${music.lastTrack}".)`
    case 'picking':
      return '\n(No music is playing; the program is quietly looking for the next track.)'
    case 'pickFailed':
      return '\n(No music is playing; the last search for a track came up empty, so it stays talk for now.)'
  }
}

// The live program facts a reply turn stands on (spec 04 bugfix): the same
// clock and music status the talk builders render, minus the beat-shaped red
// lines — the steer prompt has its own reply rules. Empty when neither fact
// is present.
export function statusBlock(ctx: ContextPack): string {
  const lines = `${sceneLine(ctx)}${musicLine(ctx)}`
  return lines === '' ? '' : `(Right now)${lines}\n\n`
}

// Anti-fabrication red lines for the self-initiated beats (spec 04 bugfix):
// the observed failure was a buffered beat inventing a whole program — songs
// announced that never played, kettle sounds heard, an afternoon narrated to
// its end in five real minutes.
const GROUNDING_RULES =
  'Stay true to the program state above. The program introduces each track ' +
  'itself when one actually starts, so never announce, promise, or narrate ' +
  'finding, choosing, or starting a song yourself. Never claim to hear ' +
  "sounds from the listener's side. Your beat may go to air a few minutes " +
  'after this moment: never narrate time passing.'

// Split out of the rules above because ONE beat must not carry it: the coda is
// written to air exactly as the song it can see is ending (spec 04 §3.3), so
// forbidding anything that turns false when the music ends would forbid the
// only thing that beat is for.
export const MUSIC_OUTLASTS_RULE =
  'Say nothing that turns false when the music above ends or changes.'

// The cue naming that beat. Exported so the Director and the prompt agree on
// one spelling.
export const CODA_CUE = 'coda'

function groundingRules(ctx: ContextPack): string {
  return ctx.cue === CODA_CUE ? GROUNDING_RULES : `${GROUNDING_RULES} ${MUSIC_OUTLASTS_RULE}`
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
  // spec 04 §3.3: the way OUT of a song. Permission, not an assignment — a
  // beat that must review every track would be the "up next" formula again,
  // wearing the other end of the song.
  [CODA_CUE]:
    'This beat goes out as the song above is ending, or just after it has. You ' +
    'may answer the song, say why it followed the stretch of talk before it, ' +
    'or say nothing about it at all and simply carry on. Introducing or ' +
    'reviewing the track is not the job: mention it only where it comes ' +
    'naturally, and never in a formula.',
}

function pacingLines(ctx: ContextPack): string {
  const activity = ACTIVITY_GUIDANCE[ctx.activity ?? '']
  const cue = CUE_GUIDANCE[ctx.cue ?? '']
  return `${activity === undefined ? '' : `\n${activity}`}${cue === undefined ? '' : `\n${cue}`}`
}

// The tier-① listener profile as a leading stable block (spec 05 §3.5): it
// precedes the volatile transcript so persona + profile form the cache-friendly
// stable prefix (master §7 pillar 4). Empty -> nothing (degrade silently).
//
// A fact line ends in the fading ledger's bookkeeping — `[seen YYYY-MM-DD]`,
// `[stable]` (spec 05-01 §3.3, src/memory/memory.ts). It is the file's business, not
// the host's: the prompt carries the fact without its tags. Anchored to the
// line end, so the same words inside a fact stay what the listener said.
const PROFILE_TAGS = /(?:[ \t]*\[(?:seen \d{4}-\d{2}-\d{2}|stable)\])+[ \t]*$/gm

export function profileBlock(ctx: ContextPack): string {
  const profile = ctx.profile?.replaceAll(PROFILE_TAGS, '').trim()
  return profile ? `(What you know about the listener)\n${profile}\n\n` : ''
}

// The profile's first section alone, tags stripped (spec 13 §3.4): what the
// listener follows is a search term, how they like to be spoken to is not.
// A profile without the labelled section (PROFILE_SHAPE) yields nothing —
// the conservative reading, since the text leaves for a search task.
const ABOUT_HEADER = '(About the listener)'
const STYLE_HEADER = '(Relationship & style)'

export function aboutSection(profile: string): string {
  const start = profile.indexOf(ABOUT_HEADER)
  if (start === -1) return ''
  const body = profile.slice(start + ABOUT_HEADER.length)
  const end = body.indexOf(STYLE_HEADER)
  return (end === -1 ? body : body.slice(0, end)).replaceAll(PROFILE_TAGS, '').trim()
}

// A single volatile "recently covered — don't repeat" cue from the tier-③
// ledger (spec 05 §3.5). Ledger-backed and cross-day, so it holds even when the
// transcript is empty (the issue-#44 cold-open case). Empty -> nothing.
function coveredLine(ctx: ContextPack): string {
  if (ctx.coveredTopics === undefined || ctx.coveredTopics.length === 0) return ''
  return `\n(Recently covered — don't repeat these: ${ctx.coveredTopics.join(', ')})`
}

// One real-world item on the desk for this stretch (spec 13 §2.5). A host
// names the thing — the title, who, where, when — says what happened and what
// they make of it, and carries on; what a host does NOT do is switch into a
// newsreader's rundown. The line draws on register, never on content: an item
// with its names scrubbed out is the cozy-imagery attractor (#44) wearing a
// fig leaf. The anchor beats and the coda have a job of their own and never
// carry one, even if a pack arrives with it. Absent -> nothing.
function rwtLine(ctx: ContextPack): string {
  const rwt = ctx.rwt
  if (rwt === undefined) return ''
  const cue = ctx.cue ?? ''
  if (cue === CODA_CUE || cue.startsWith('anchor:')) return ''
  return (
    `\n(On the desk for this stretch, from today: ${rwt.title} — ${rwt.gist})\n` +
    'Bring it in the way a host does: name the thing — the title, who, where, ' +
    'when — say what happened in a sentence or two and what you make of it, ' +
    'then carry on. One item, in your own voice. Not a newsreader\'s rundown, ' +
    'not a "here is the news" frame, not a list.'
  )
}

// Render recent turns as a transcript. The host's own prior lines are "You";
// the listener's lines are "Listener".
export function renderTranscript(ctx: ContextPack, dropTrailingUser?: string): string {
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
  return `${profileBlock(ctx)}${head}${coveredLine(ctx)}${sceneLine(ctx)}${musicLine(ctx)}${pacingLines(ctx)}${rwtLine(ctx)}\n${groundingRules(ctx)}\n${OUTPUT_RULES}`
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
    `${profileBlock(ctx)}${head}${coveredLine(ctx)}${sceneLine(ctx)}${musicLine(ctx)}${pacingLines(ctx)}${rwtLine(ctx)}\n` +
    `${groundingRules(ctx)}\n` +
    'Each beat is one small stretch of radio (a few sentences, spoken aloud — ' +
    'no markup, labels, or stage directions). Return ' +
    `all ${count} beats in order by calling the emit_talk_beats tool.`
  )
}
