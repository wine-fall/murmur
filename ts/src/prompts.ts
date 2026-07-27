// Centralized prompt text (DESIGN §0): every prompt murmur sends to the Brain
// lives here, in English. The radio's output language is set inside the
// persona seed (it instructs Chinese speech), so English scaffolding still
// yields a Chinese-speaking radio.
//
// Spec-01 builders only; later phases add profile/covered-topics/scene blocks
// (specs 04/05) when their data exists.

import { fileURLToPath } from 'node:url'

import type { ContextPack, Turn } from './contracts.ts'

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
  return `${head}\n${OUTPUT_RULES}`
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
    `${head}\n` +
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

// Prompt for an in-persona reply to a typed user line.
export function buildRespondPrompt(userText: string, ctx: ContextPack): string {
  const transcript = renderTranscript(ctx, userText)
  const head = transcript ? `(The program so far)\n${transcript}\n\n` : ''
  return (
    `${head}The listener just said to you: "${userText}"\n` +
    `Respond in character, then ease back into the program.\n${OUTPUT_RULES}`
  )
}
