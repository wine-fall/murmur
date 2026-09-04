// The listener profile's two writers (spec 05 §3.6 compaction, spec 06 slice B
// bootstrap): one PROFILE_SHAPE so the first fold merges into a bootstrapped
// profile instead of fighting it.

import type { Turn } from '../contracts.ts'

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
the durable facts from the exchange below into the existing profile.

The exchange is labelled: \`listener:\` is the person, \`host:\` is the radio. Derive
facts ONLY from the listener's lines. A \`host:\` line is there for context — it is
the radio talking to itself, and nothing in it is a fact about the listener.

${PROFILE_SHAPE}

Every fact is one line, and ends with the date it was last confirmed:

- Stopped drinking coffee; prefers tea [seen 2026-09-01]
- Name they go by: Z; speaks Chinese [seen 2026-07-20] [stable]

Rules for the lines:
- A fact the listener confirms again gets TODAY's date, stated below.
- A newer statement that contradicts an older fact REPLACES it — keep the newer
  line, drop the old one; never keep both.
- A one-off request ("play something else") is not a preference unless it recurs.
- Mark identity facts — name, language, where they live, what they do — [stable].
- Keep the existing date on a fact this exchange did not touch.

Drop: ephemera, one-off small talk, anything transient. Merge — do not simply
append; rewrite the profile so it stays coherent and non-repetitive.

Return ONLY the updated profile text, both sections under their labels, in the
listener's own language, under ${PROFILE_CHAR_CAP} characters total. No preamble
or commentary.
`

// The compaction turn: current profile + the listener-only slice to fold
// (spec 05-01 §3.1). `host:`/`listener:` rather than the role names, so the
// prompt's one-half rule and the line labels are the same word.
// `today` is stated outright: the fold runs under a neutral system prompt with
// no clock, and a model left to guess copies the year in the example — which
// `stampDates` then preserves, because the tag is syntactically valid.
export function buildCompactionPrompt(
  profile: string,
  transcript: readonly Turn[],
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const current = profile.trim() || '(no profile yet)'
  const lines =
    transcript.map((t) => `${t.role === 'radio' ? 'host' : 'listener'}: ${t.text}`).join('\n') ||
    '(nothing)'
  return (
    `${COMPACTION_INSTRUCTION}\n` +
    `(Today is ${today}.)\n\n` +
    `(Current profile)\n${current}\n\n` +
    `(Recent transcript to fold in)\n${lines}`
  )
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
