// The program prompts (spec 15): the planning call that prepares a program,
// and the per-point beat prompt that says it. The host plans in its own voice
// (the host system prompt), so the outline is already in the language and
// manner the air will use.

import type { ProgramCue } from '../contracts.ts'
import { PROGRAMS, type ProgramId } from '../programs/catalogue.ts'

// What each program is, for the planner. Whole-shape descriptions, not rules.
export const PROGRAM_BRIEFS: Readonly<Record<ProgramId, string>> = {
  puzzle:
    'Philosophy, led by a QUESTION a thoughtful person actually asks — why must ' +
    'people work at all, say. Bring in several thinkers, Chinese (Confucius, ' +
    'Mencius, Laozi, Zhuangzi and the rest) and Western or from other ' +
    'traditions, agreeing or contrasting. Talk about each thinker\'s LIFE and let ' +
    'the life explain the view. Tie the question to present reality — ' +
    'geopolitics, the economy, the divides between generations and places — and ' +
    'to this listener. Present-day facts come ONLY from the real-world items ' +
    'below; long-run trends may come from what you know, never presented as the ' +
    'latest data. If no item fits, talk about trends only — never force the news ' +
    'in. The subject is the question; name the thinker or thinkers who lead the ' +
    'program in `leads`.',
  today:
    'Commentary on the real-world items below, two or three of them: for each, ' +
    'name the thing — the title, who, where, when — say what happened and what ' +
    'you make of it. Not a newsreader\'s rundown, not a "here is the news" ' +
    'frame — a host who has read the story and has a view. The subject is a ' +
    'short label for the set.',
  record:
    'One artist or one album. The outline walks through it a track at a time: ' +
    'each point is one track, named in `track` (artist and title exactly as ' +
    'released), with what to say around it — the story, the sound, why it ' +
    'matters. The program plays these tracks, in this order. The subject is the ' +
    'artist.',
  poem:
    'One poem or one passage of prose. The first point carries the full text, ' +
    'verbatim, in its original language, to be read on the air; the points after ' +
    'it are your reading of it, a layer each — the words, the image, the life ' +
    'behind it, what it does to a reader now. This is where feeling lives on ' +
    'this station. The subject is the author and the work, written ' +
    '"author·work".',
  origin:
    'Where one thing, word or custom comes from: its history, the turns it ' +
    'took, the people in it, what it means now. The subject is one canonical ' +
    'noun — the thing itself.',
}

// One line per program for the request tool (spec 15 §2.8), so the reply turn
// can map a listener's free text to a program.
export const PROGRAM_PITCH: Readonly<Record<ProgramId, string>> = {
  puzzle: 'philosophy, one question through several thinkers and their lives',
  today: 'commentary on two or three things that happened in the world',
  record: 'one artist or album, played and talked through track by track',
  poem: 'a poem or passage read in the original, then read closely',
  origin: 'where a thing, a word or a custom comes from',
}

export type PlanPromptInput = {
  readonly id: ProgramId
  readonly today: string
  // The program's frozen name on this air (spec 15 §2.2); absent the first time.
  readonly name?: string
  // Labels of this category's subjects still in cooldown.
  readonly avoid: readonly string[]
  // A subject the listener asked for: it bypasses the cooldown.
  readonly subject?: string
  // The profile's (About the listener) section; '' = none.
  readonly about: string
  // The taste digest; only the record program reads it.
  readonly taste: string
  // Real-world items: the material for `today`, the reality tie-in for `puzzle`.
  readonly items: readonly { readonly title: string; readonly gist: string }[]
}

function nameLine(input: PlanPromptInput): string {
  if (input.name !== undefined) {
    return `This program's name on your air is ${input.name} — return exactly that as \`name\`.`
  }
  const title = PROGRAMS[input.id].title
  return (
    `Return \`name\`: the English title "${title}" rendered literally into the language ` +
    'you speak on the air, written the way a program title is written in that ' +
    'language, title marks included if it uses them. It becomes the fixed name of ' +
    'this program.'
  )
}

function subjectLine(input: PlanPromptInput): string {
  if (input.subject !== undefined) return `The listener asked for this subject: ${input.subject}. Plan it.`
  if (input.avoid.length === 0) return 'Choose the subject yourself.'
  return `These subjects were done recently; choose a different one: ${input.avoid.join('; ')}.`
}

function itemsBlock(input: PlanPromptInput): string {
  if (input.id !== 'today' && input.id !== 'puzzle') return ''
  if (input.items.length === 0) return '\n(Real-world items)\nNone today.\n'
  return `\n(Real-world items)\n${input.items.map((i) => `- ${i.title} — ${i.gist}`).join('\n')}\n`
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  const shape = PROGRAMS[input.id]
  const about = input.about.trim() === '' ? '' : `\n(What you know about the listener)\n${input.about.trim()}\n`
  const taste =
    input.id === 'record' && input.taste.trim() !== '' ? `\n(What the listener keeps)\n${input.taste.trim()}\n` : ''
  return (
    `Prepare your next program: "${shape.title}". Today is ${input.today}.\n\n` +
    `${PROGRAM_BRIEFS[input.id]}\n` +
    about +
    taste +
    itemsBlock(input) +
    `\n${subjectLine(input)}\n` +
    `\nIt runs about ${shape.targetMin} minutes, as an outline of ${shape.points} points; ` +
    `each point is said in ${shape.beats[0]}-${shape.beats[1]} short beats, with a song after it.\n` +
    'Write your angle — your way into the subject — and the points. Each point\'s ' +
    '`content` is the material you bring to the air, not a summary of it: the ' +
    'original text, the key facts, the people, the sources, your argument. Mark ' +
    'every fact and quotation with its source. Quote verbatim only what you are ' +
    'certain of; otherwise paraphrase and say that you are paraphrasing. Check ' +
    'every fact before you hand the plan over. Write it in the language you speak ' +
    'on the air, quotations in their original language.\n' +
    `${nameLine(input)}\n` +
    'Hand the plan over by calling submit_plan.'
  )
}

// The program and the point in front of the host (spec 15 §2.5). The outline
// is shown whole so a point knows what it is not — what came before was said,
// what comes after is still to come — and the notes are the material this
// point is said from.
export function programBlock(cue: ProgramCue, anchorLine: string | undefined): string {
  const outline = cue.outline
    .map((title, i) => `${i + 1}. ${title}${i < cue.index ? ' (said)' : i === cue.index ? '  <- now' : ''}`)
    .join('\n')
  const flags = [
    cue.opening === true
      ? 'This point opens the program: name it and today\'s subject in your own words — a different way every time, never a formula.'
      : undefined,
    cue.opening === true && anchorLine !== undefined ? `It also falls at a time-of-day moment: ${anchorLine} Fold that into the opening in a line.` : undefined,
    cue.closing === true
      ? 'This point ends the program: bring it to a close and name the program as you leave it, in your own words.'
      : undefined,
    cue.resumed === true
      ? 'The program was cut off earlier and picks up again now: one line on where you left off, then carry on.'
      : undefined,
    cue.returning === true ? 'You have just answered the listener; come back to this point.' : undefined,
    cue.afterSong === true
      ? 'Your first beat goes out as the song on the air ends: come out of it and back to the program. The beats after it air once the song is over.'
      : undefined,
  ].filter((line): line is string => line !== undefined)
  return (
    `(Your program: ${cue.name} — today: ${cue.subject})\n` +
    `Your angle: ${cue.angle}\n` +
    `(The outline)\n${outline}\n` +
    `(Your notes for this point: ${cue.point.title})\n${cue.point.content}\n` +
    (flags.length === 0 ? '' : `\n${flags.join('\n')}\n`) +
    `\nSay this point in ${cue.beats[0]}-${cue.beats[1]} beats, from your notes, carrying on from what is ` +
    'already on the air. Never say again what you have already said.'
  )
}
