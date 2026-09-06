// The real-world-topics fetch task (spec 13 §3.3/§3.4): a researcher's system
// prompt, the built-in taste half, and the code-owned contract half.

import type { FetchTopicsRequest } from '../contracts.ts'

// A researcher, never the persona: the gists are handed to the host later as
// material, so nothing here may speak in the host's voice.
export const RWT_FETCH_SYSTEM_PROMPT =
  'You gather real-world material for a radio host: a few things that ' +
  'actually happened, each told briefly enough that a friend could mention ' +
  'it in passing without reading from a screen.'

export const RWT_POLICY_HEADER = 'What to look for:'

// The TASTE half — what to look for and how to weight it. Built in: the
// per-listener half of the taste is the profile, not a file (spec 13 §3.4).
export const DEFAULT_RWT_POLICY = `1. Four kinds of thing: news, tech, entertainment, sports. Mix them; do not
   let one kind take the whole batch.

2. Mostly what is happening where the listener is, some of what the whole
   world is talking about. Local first, international as the fallback, never
   the other way round.

3. Prefer the human-scale angle of a big story over the headline: what it is
   like for the people in it, not the number in the title.

4. Nothing that needs a screen to make sense of — no charts, no tables, no
   "as shown below". Nothing that is only a figure.

5. Something a host would actually bring up on air: a release, a match, a
   small strange thing that happened, a thing people are arguing about. Skip
   what is merely important.

6. Keep the hard nouns. A title, a name, a place, a date, a number that
   matters — those are what make a thing real when it is said aloud. A gist
   with them scrubbed out is mood, not material.`

// The CONTRACT half — code-owned: language, region, freshness, dedupe,
// privacy, and how the task ends. Nothing the listener says can loosen these.
export function buildFetchTopicsPrompt(req: FetchTopicsRequest): string {
  // The listener's half of the taste, with the line the code owns: their
  // interests steer the search; they themselves are never its subject.
  const follows = req.follows.trim()
    ? `(What the listener follows)\n${req.follows.trim()}\n` +
      'Lean the search toward these. Search for what they follow, never for ' +
      'them, and never for anything that identifies them.\n\n'
    : ''
  const avoid =
    req.avoid.length === 0
      ? ''
      : `\nAlready in the pool — find something else:\n${req.avoid.map((t) => `- ${t}`).join('\n')}\n`
  return (
    `Write every title and every gist in ${req.language}. The listener is in the ${req.timezone} ` +
    'timezone; weight what matters there, international as the fallback.\n' +
    `Today is ${req.today}. Only things from today or yesterday — nothing older, ` +
    'nothing undated.\n' +
    'Nothing about private individuals, and nothing that identifies a person ' +
    'who is not a public figure.\n' +
    `${avoid}\n` +
    'Use WebSearch to find candidates, then call submit_topics ONCE with three ' +
    'to eight items. Each item: a one-line title, a gist of two to three spoken ' +
    'sentences a friend could say from memory (no URLs, no outlet names, no ' +
    'quotes), and its kind. Calling submit_topics ends the task.\n\n' +
    `${follows}${RWT_POLICY_HEADER}\n${DEFAULT_RWT_POLICY}`
  )
}
