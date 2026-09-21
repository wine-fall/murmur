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
// The anti-repeat half of policy rule 8, named because code reads it: the
// deterministic refusal in submit_pick is armed only while this sentence is
// still in the policy in force (spec 03-01 §2.3). A listener who rewrites
// the policy without it welcomes repeats, and the code must not overrule them.
export const NO_REPEATS_RULE = 'never play something the context lists as recently played'

export const DEFAULT_MUSIC_POLICY = `1. Read the room before the record. The persona and the turns above say more
   than any genre label does: the hour, what the listener keeps circling back
   to, whether they want company or cover.

2. Name the frame, then the song. Decide what you are reaching for — a
   language, a decade, a texture, a place, a scene — and make it one the last
   few picks did not already use. A frame you had to think about is worth more
   than one that arrived on its own.

3. Do not choose out of memory. The songs that come to mind first are the ones
   that come to mind first for everyone, every time; that is how a radio ends
   up playing six artists forever. Reach from the frame instead of from the
   name: the scene it belongs to, the year, the label, who they played with,
   what the listener already keeps — and search for that.

4. Then ask which of theirs. A fresh artist and their one famous single is the
   same habit wearing a new coat. Reach past the one song of theirs everybody
   knows — an album track, the second single, the one that fits this hour.

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
   them, and ${NO_REPEATS_RULE}.`

export const MUSIC_POLICY_HEADER = 'Policy:'

// Search with taste in hand (spec 14 §3.3), rendered only when a digest rides
// the situation. The block is the listener's shape, not a shelf to pull from:
// measured over 68 airs, a radio handed the kept titles played them back (19
// of 68) or reached for the same artists' best-known ten (31 of 68). §3.10
// withholds the titles; this paragraph says what to do with what is left.
export const TASTE_GUIDANCE = `With taste in hand: the block "What the listener keeps" below is the shape of
what they already have — the artists they return to, the playlists they made,
what has been on lately. Those are anchors, not requests. A radio that plays
what someone already keeps is a shuffle button with a voice; your half of this
is the rest of the map — the record beside the one they keep, the labelmate,
the scene, the year, the country, the singer that artist learned from. Reach
out from the anchors, never back to them.
Search wherever the song is likeliest to be FOUND — NetEase
and QQ Music for Chinese-catalogue depth, Bilibili and YouTube as well.
Where a pick PLAYS from is decided after submit_pick, so choose the best song,
not the best source. In the announce, say where a pick came from only when it is theirs
("one you've kept"), never otherwise.`

// What the `channels` catalogue IS (spec 14 §2.9), rendered only while the
// pool holds something. This sentence is about WHERE TO LOOK and nothing else:
// the curated list is a search source, never a statement about the listener —
// what they like comes from their own accounts, and from nowhere else.
export const CHANNELS_GUIDANCE = `The channels catalogue searches recent uploads from a curated list of music
channels — good for something new, a cover, or a recent release that a plain
search would bury.`

export function buildFindMusicInstruction(
  policy: string = DEFAULT_MUSIC_POLICY,
  opts: { taste?: boolean; channels?: boolean } = {},
): string {
  const taste = opts.taste === true ? `\n\n${TASTE_GUIDANCE}` : ''
  const channels = opts.channels === true ? `\n\n${CHANNELS_GUIDANCE}` : ''
  return `${FIND_MUSIC_CONTRACT}\n\n${MUSIC_POLICY_HEADER}\n${policy.trim()}${taste}${channels}`
}

export const FIND_MUSIC_INSTRUCTION = buildFindMusicInstruction()

// The volatile situation block (spec 03-02 §1 #9): the session's recent turns
// plus the Director's intent. Recently-played songs arrive with the spec-05
// ledger; an empty list renders nothing. This block states FACTS only — what
// to do about a recently-played song is a taste rule, so it lives in the
// replaceable policy (spec 03-01 §2.3), never here where a listener who
// welcomes repeats could not overrule it.
// `taste` is the rendered digest (spec 14 §2.3): appended under its own
// heading with the one instruction the spec adds; '' renders nothing.
// `daily` is the daily lane's own block (spec 14 3.10): the platforms' picks
// of the day, kept apart from the taste block because it is not what the
// listener keeps. '' renders nothing.
export function buildMusicSituation(recent: readonly Turn[], avoid: readonly string[] = [], taste = '', daily = ''): string {
  const turns = recent.map((t) => `- ${t.role === 'radio' ? 'You' : 'Listener'}: ${t.text}`).join('\n')
  const avoidBlock =
    avoid.length === 0
      ? ''
      : `\nRecently played:\n${avoid.map((song) => `- ${song}`).join('\n')}\n`
  const tasteBlock =
    taste === ''
      ? ''
      : `\n${taste}\nPrefer what fits the moment; the listener's kept music is a strong prior, not a playlist to replay.\n`
  const dailyBlock = daily === '' ? '' : `\n${daily}\n`
  return (
    `Recent on-air turns:\n${turns || '- (the program just started)'}\n${avoidBlock}${tasteBlock}${dailyBlock}` +
    'Intent: a music break in the program. Pick something that fits the mood and\n' +
    "subjects of the conversation above (or the persona's taste if it is quiet)."
  )
}
