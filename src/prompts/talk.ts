// The self-initiated talk beats (spec 01 §3.2, spec 04): the ContextPack
// renderers every persona-voiced prompt shares (profile, clock/scene, music
// status, transcript), the beat-shaped grounding rules, and the next-beat(s)
// builders. reply.ts reuses the shared renderers for the typed-line turns.

import type { ContextPack, ProgramCue } from '../contracts.ts'
import type { StockRequest } from '../support/stock.ts'
import { ABOUT_HEADER, PROFILE_TAGS, STYLE_HEADER } from './profile.ts'
import { programBlock } from './program.ts'

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
    case 'switching':
      return music.track === undefined
        ? '\n(No music is playing; the listener asked for a different song and the ' +
            'next one has not been found yet — do not say it has been changed.)'
        : `\n(On the air: "${music.track}" is still playing. The listener asked for a ` +
            'different song and the next one has not been found yet — do not say it has ' +
            'been changed; if it comes up at all, you are still looking.)'
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

// A program point written as a song ends (spec 15 §2.10) is the coda's heir:
// its first beat answers the song, so the outlast rule cannot bind it either.
function groundingRules(ctx: ContextPack): string {
  const answersSong = ctx.cue === CODA_CUE || ctx.program?.afterSong === true
  return answersSong ? GROUNDING_RULES : `${GROUNDING_RULES} ${MUSIC_OUTLASTS_RULE}`
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

export function profileBlock(ctx: Partial<ContextPack>): string {
  const profile = ctx.profile?.replaceAll(PROFILE_TAGS, '').trim()
  return profile ? `(What you know about the listener)\n${profile}\n\n` : ''
}

// The taste digest (spec 14 §2.3) as a second stable block behind the profile:
// what the listener keeps on their own platforms, handed over as something the
// host KNOWS — never a list to recite, never a reason to bring a song up.
export function tasteBlock(ctx: ContextPack): string {
  const taste = ctx.taste?.trim()
  if (!taste) return ''
  return (
    `(What the listener keeps — background you know, not something to recite)\n${taste}\n` +
    'Mention a kept song at most when the moment earns it.\n\n'
  )
}

// The profile's first section alone, tags stripped (spec 13 §3.4): what the
// listener follows is a search term, how they like to be spoken to is not.
// A profile without the labelled section (PROFILE_SHAPE) yields nothing —
// the conservative reading, since the text leaves for a search task.

export function aboutSection(profile: string): string {
  const start = profile.indexOf(ABOUT_HEADER)
  if (start === -1) return ''
  const body = profile.slice(start + ABOUT_HEADER.length)
  const end = body.indexOf(STYLE_HEADER)
  return (end === -1 ? body : body.slice(0, end)).replaceAll(PROFILE_TAGS, '').trim()
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

// The head of a prompt with no transcript behind it (spec 05 §3.4): a fact
// about when the program was last on and what it touched. The previous
// sitting's turns are deliberately NOT here — a transcript says "you were
// mid-sentence", and the host finishes the sentence. This states the return
// instead, and says nothing about whether to mention it: the host decides that
// the way a host does. The hour of the return comes from the clock line every
// prompt already carries, so there is no second clock here.
export function openingBlock(ctx: ContextPack): string {
  const last = ctx.lastOnAir
  if (last === undefined) return 'The program is starting now.'
  const topics = last.topics.length === 0 ? '' : ` — the talk touched on ${last.topics.join(', ')}`
  return `(Last on the air: ${last.when}${topics}.)\nThe program is coming back on now.`
}

// The head of a prompt that HAS a transcript behind it. Ordinarily the
// transcript is the whole head — the session has already opened. When the
// sitting opened on stock lines (spec 04 §3.6) the opening fact is still owed,
// so it is stated first and the stock lines are named as what has been said,
// which is what keeps the host from opening the program a second time.
function carryOn(ctx: ContextPack, transcript: string): string {
  if (ctx.opening !== true) return `(The program so far)\n${transcript}\n\nNow continue`
  return `${openingBlock(ctx)}\n\n(Already on the air, just now)\n${transcript}\n\nCarry on from there`
}

// Prompt for a single self-initiated talk segment (the fallback path when the
// batched tool call degrades — spec 04 §3.2).
export function buildNextTalkPrompt(ctx: ContextPack): string {
  if (ctx.program !== undefined) {
    return buildProgramBeatsPrompt(ctx, ctx.program, `Say only the next beat of this point.\n${OUTPUT_RULES}`)
  }
  const transcript = renderTranscript(ctx)
  const head = transcript
    ? `${carryOn(ctx, transcript)} — say your next beat.`
    : `${openingBlock(ctx)} Open naturally with your first beat.`
  return `${profileBlock(ctx)}${tasteBlock(ctx)}${head}${sceneLine(ctx)}${musicLine(ctx)}${pacingLines(ctx)}\n${groundingRules(ctx)}\n${OUTPUT_RULES}`
}

// One program point (spec 15 §2.5): the same stable blocks and program facts
// as a free beat, but the head is the program — its outline and this point's
// notes — instead of "carry on".
function buildProgramBeatsPrompt(ctx: ContextPack, program: ProgramCue, tail: string): string {
  const transcript = renderTranscript(ctx)
  const head = !transcript
    ? openingBlock(ctx)
    : ctx.opening === true
      ? `${openingBlock(ctx)}\n\n(Already on the air, just now)\n${transcript}`
      : `(The program so far)\n${transcript}`
  const activity = ACTIVITY_GUIDANCE[ctx.activity ?? '']
  return (
    `${profileBlock(ctx)}${tasteBlock(ctx)}${head}\n\n` +
    `${programBlock(program, program.anchor === undefined ? undefined : CUE_GUIDANCE[program.anchor])}` +
    `${sceneLine(ctx)}${musicLine(ctx)}${activity === undefined ? '' : `\n${activity}`}\n` +
    `${groundingRules(ctx)}\n${tail}`
  )
}

const PROGRAM_BEATS_TAIL =
  'Each beat is one small stretch of radio (a few sentences, spoken aloud — ' +
  'no markup, labels, or stage directions). Return them in order by calling ' +
  'the emit_talk_beats tool.'

// Prompt for the next `count` self-initiated beats in one call. The beats come
// back via the emit_talk_beats tool (structured output — see talk-tools.ts),
// so the shape lives in that tool's schema, not here.
export function buildNextTalksPrompt(ctx: ContextPack, count: number): string {
  if (ctx.program !== undefined) return buildProgramBeatsPrompt(ctx, ctx.program, PROGRAM_BEATS_TAIL)
  const transcript = renderTranscript(ctx)
  const head = transcript
    ? `${carryOn(ctx, transcript)} — say your next ${count} beats.`
    : `${openingBlock(ctx)} Open naturally with your first ${count} beats.`
  return (
    `${profileBlock(ctx)}${tasteBlock(ctx)}${head}${sceneLine(ctx)}${musicLine(ctx)}${pacingLines(ctx)}\n` +
    `${groundingRules(ctx)}\n` +
    'Each beat is one small stretch of radio (a few sentences, spoken aloud — ' +
    'no markup, labels, or stage directions). Return ' +
    `all ${count} beats in order by calling the emit_talk_beats tool.`
  )
}

// The stock lines (spec 04 §3.6): the opener set and the sign-off, generated
// ahead of time and played from disk. The prompt stands on persona and profile
// ALONE — no clock, no scene, no transcript, no music status — because a stock
// line airs at an hour and after a gap nobody can know when it is written.
export function buildStockLinesPrompt(req: StockRequest): string {
  const previous =
    req.previous.length === 0
      ? ''
      : `\n(Last time you said)\n${req.previous.join('\n')}\nSay something different this time.\n`
  const farewell = req.farewell
    ? `\nAlso write ONE sign-off: the line you say as the program goes off the air, ` +
      'in the same voice, under the same rules.\n'
    : ''
  return (
    `${profileBlock(req)}` +
    `These are lines you will say later, at a moment nobody can see from here.\n` +
    `Write ${req.count} opening beats — the way this program comes on the air.\n` +
    previous +
    farewell +
    '\nRules, because you cannot know when these will play:\n' +
    '- Nothing about the time of day, the date, or the season.\n' +
    '- Nothing about how long they have been away, or that they are back.\n' +
    '- Nothing about anything you have talked about with them, and nothing about ' +
    'music playing or about to play.\n' +
    '- Each beat stands alone and is a complete stopping point: the program may ' +
    'carry on right after any one of them, or not at all.\n' +
    '- Together the opening beats read as one stretch of radio, in order.\n' +
    `\n${OUTPUT_RULES}\n` +
    'Return them by calling the emit_stock_lines tool.'
  )
}
