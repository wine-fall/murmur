// The persona prompts (spec 01 §3.1, spec 06): the bundled seed's location, the
// listener's language override, and the first-run seed-persona generation.
// Every prompt murmur sends to the Brain lives under src/prompts/ (DESIGN §0),
// in English; the radio's output language is set inside the persona.

import { fileURLToPath } from 'node:url'

import type { SeedAnswer } from '../contracts.ts'

// The bundled static persona seed (L0). Spec 06 will generate/evolve personas
// at runtime; this is only the default.
export const DEFAULT_PERSONA_PATH = fileURLToPath(
  new URL('./persona-seed.md', import.meta.url),
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
