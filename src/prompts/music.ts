// The music pick task (spec 03-01 §2.3/§2.5): the code-owned contract half,
// the listener-replaceable taste half, and the volatile situation block.

import type { Turn } from '../contracts.ts'

// Header prefixing the volatile context block in the music task turn.
export const MUSIC_CONTEXT_HEADER = 'Current context for choosing music:\n'

// The pick task's instruction, in two halves (spec 03-01 §2.3). English
// scaffolding; the listener's language and taste come from the persona.
//
// The CONTRACT half is code-owned: how the task ends, and what `submit_pick`
// must carry. A listener policy that forgot to ask for an announce would
// otherwise put a track on the air with no intro.
// What the announce IS, in one sentence — the single source for both places the
// model is told: the contract below, and the submit_pick schema's `announce`
// parameter (src/music/music-tools.ts). A tool's parameter description is a runtime
// instruction read at exactly the moment the field is filled, so it must not be
// a second, drifting copy.
export const ANNOUNCE_FIELD_DESCRIPTION =
  'what you say on air as this track comes in: two to four sentences, around ' +
  'ten to twenty seconds spoken, in the persona\'s voice and language, picking ' +
  'up the line that was on air as this song was chosen where it leaves a thread'

export const FIND_MUSIC_CONTRACT = `Choose ONE piece of music to play next on a personal radio.

Use the search_music tool to find candidates, judge them against the persona,
the policy below, and the context, then call submit_pick with the single best
track and a short reason.

- If your pick fails to resolve, pick another candidate and submit again.
- In submit_pick, also pass the track's title and artist (from the candidate),
  and write \`announce\`: ${ANNOUNCE_FIELD_DESCRIPTION}.
  It is read aloud over the song's opening, so write only the words: no quotes
  around it, no markdown.
- If that line leaves no thread to pick up, simply bring the song in. Say
  something about the track itself only where it comes naturally — a sentence
  or two — never a title/artist/year rundown, and never an "up next" formula.`


// The TASTE half — everything a listener may replace wholesale by writing
// $MURMUR_HOME/music-policy.md (spec 03-01 §2.3). Written as a playbook rather
// than a list of bans: the failure it exists to prevent is not picking a BAD
// song, it is picking the same handful of obvious ones forever, and a ban list
// cannot say what to do instead.
export const DEFAULT_MUSIC_POLICY = `1. Read the room before the record. The persona and the turns above say more
   than any genre label does: the hour, what the listener keeps circling back
   to, whether they want company or cover.

2. Name the frame, then the song. Decide what you are reaching for — a
   language, a decade, a texture, a place, a scene — and make it one the last
   few picks did not already use. A frame you had to think about is worth more
   than one that arrived on its own.

3. Do not choose out of memory. The songs that come to mind first are the ones
   that come to mind first for everyone, every time; that is how a radio ends
   up playing six artists forever. Where similar_music is available, seed it
   with an artist or track that fits the frame and treat what it returns —
   real co-listening data — as the field to choose from.

4. Then ask which of theirs. A fresh artist and their one famous single is the
   same habit wearing a new coat. Where top_tracks is available it says what
   people actually play by an artist; read a few names down it rather than
   stopping at the top. Where it is not, reach past the one song of theirs
   everybody knows.

5. Search for the specific thing. "<artist> <title>" finds a record; a mood
   phrase finds whatever is popular. search_music executes exactly what you
   type — it does not know what you meant.

6. Judge what comes back. Prefer official audio and studio versions. Skip
   hour-long loops, low-quality re-uploads, and live or cover versions unless
   that take is clearly the right one for this moment.

7. Someone has to be singing. Not ambient, not a solo-piano rearrangement,
   not lofi beats, not a soundtrack cue — however well any of them would suit
   the hour — unless the listener asked for instrumental. A room with a voice
   in it is the whole point of a radio.

8. Stay inside the listener's language and taste as the persona describes
   them, and never play something the context lists as recently played.`

export const MUSIC_POLICY_HEADER = 'Policy:'

export function buildFindMusicInstruction(policy: string = DEFAULT_MUSIC_POLICY): string {
  return `${FIND_MUSIC_CONTRACT}\n\n${MUSIC_POLICY_HEADER}\n${policy.trim()}`
}

export const FIND_MUSIC_INSTRUCTION = buildFindMusicInstruction()

// The volatile situation block (spec 03-02 §1 #9): the session's recent turns
// plus the Director's intent. Recently-played songs arrive with the spec-05
// ledger; an empty list renders nothing. This block states FACTS only — what
// to do about a recently-played song is a taste rule, so it lives in the
// replaceable policy (spec 03-01 §2.3), never here where a listener who
// welcomes repeats could not overrule it.
export function buildMusicSituation(recent: readonly Turn[], avoid: readonly string[] = []): string {
  const turns = recent.map((t) => `- ${t.role === 'radio' ? 'You' : 'Listener'}: ${t.text}`).join('\n')
  const avoidBlock =
    avoid.length === 0
      ? ''
      : `\nRecently played:\n${avoid.map((song) => `- ${song}`).join('\n')}\n`
  return (
    `Recent on-air turns:\n${turns || '- (the program just started)'}\n${avoidBlock}` +
    'Intent: a music break in the program. Pick something that fits the mood and\n' +
    "subjects of the conversation above (or the persona's taste if it is quiet)."
  )
}
