// The listener's music notes (spec 03-01 §2.3): their own words, ADDED to the
// code-owned default policy, as a file they own at $MURMUR_HOME/music-policy.md.
//
// Read fresh on every pick rather than watched or cached — a pick already
// costs seconds of network, so one small read is free, and an edit reaches the
// next pick with no restart and no reload command. Next PICK, not always next
// song: the Director chooses ahead of the boundary (spec 04 look-ahead), so an
// edit made after a pick was already primed lands on the song after it. An
// absent, empty, or unreadable file is no notes: the default policy alone.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { DEFAULT_MUSIC_POLICY } from '../prompts/music.ts'

// The file explains itself in HTML comments so its own instructions never
// reach the model; everything else is the listener's text.
const COMMENTS = /<!--[\s\S]*?-->/g

const TEMPLATE = `<!--
murmur music notes.

Whatever you write here is ADDED to murmur's built-in music policy -- the
rules it already follows to find a song -- and anything in it outranks those
rules where the two disagree. Leave it empty and murmur picks on its own.

Some things worth saying: a language or region to favour, a decade to live
in, artists you never want to hear, how far off your usual taste to wander,
what a weeknight should sound like versus a Sunday.

murmur re-reads this file every time it goes looking for a song, so an edit
takes effect on its own -- no restart, no reload. It chooses a song shortly
before it needs one, so an edit reaches the next song, or the one after if
that choice was already made. Anything inside an HTML comment (like this) is
never read, so notes to yourself are free.

What you cannot change from here is the mechanism: murmur always searches,
judges, and commits to one track with a spoken intro, and never plays a song
it has just played.
-->
`

// Every default policy a released murmur seeded into a listener's file,
// frozen verbatim. Before the policy was code-owned the seed wrote a full copy
// of the default of its day and never rewrote it; read as notes, that copy
// would outrank the current default with the very rules it replaced. So a copy
// of one of these, or of today's default, is not the listener speaking and is
// dropped when the file is read. The seed now holds no copy, so this list
// never grows.
export const RETIRED_MUSIC_POLICIES: readonly string[] = [
  // #148, first released in v0.1.2: seeded from 2026-08-26.
  `1. Read the room before the record. The persona and the turns above say more
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
   them, and never play something the context lists as recently played.`,
  // #230, first released in v0.3.0 (#277 named its last clause without
  // changing the text): seeded from 2026-09-14 until the seed stopped
  // copying the policy.
  `1. Read the room before the record. The persona and the turns above say more
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
   them, and never play something the context lists as recently played.`,
]

// A shipped default as the listener's editor may have left it: the same words
// in the same order, any whitespace between them.
const SEEDED_COPIES = [DEFAULT_MUSIC_POLICY, ...RETIRED_MUSIC_POLICIES].map(
  (policy) => new RegExp(policy.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')),
)

// The listener's own words in the file: comments stripped, and a seeded copy
// of a default dropped, so a line they added around that copy survives as
// theirs. A copy they rewrote inside no longer matches and is kept whole.
// The gap a dropped copy leaves closes to one blank line.
export function parseMusicNotes(text: string): string | undefined {
  const rest = SEEDED_COPIES.reduce((left, copy) => left.replace(copy, ''), text.replace(COMMENTS, ''))
  const notes = rest.replace(/\n\s*\n\s*\n/g, '\n\n').trim()
  return notes === '' ? undefined : notes
}

export function readMusicNotes(path: string): string | undefined {
  try {
    return parseMusicNotes(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

// Seeded once at boot, because a file the listener never sees is one they can
// never write in. `wx` makes "already there" a normal outcome, so their own
// text is never overwritten. Returns whether this call wrote the file.
export function seedMusicPolicy(path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, TEMPLATE, { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch {
    return false
  }
}
