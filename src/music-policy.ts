// The listener's music policy (spec 03-01 §2.3): the taste half of the pick
// instruction, as a file they own at $MURMUR_HOME/music-policy.md.
//
// Read fresh on every pick rather than watched or cached — a pick already
// costs seconds of network, so one small read is free, and an edit reaches the
// next pick with no restart and no reload command. Next PICK, not always next
// song: the Director chooses ahead of the boundary (spec 04 look-ahead), so an
// edit made after a pick was already primed lands on the song after it. An absent, empty, or
// unreadable file is simply the built-in policy: the radio plays exactly as it
// did before the file existed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { DEFAULT_MUSIC_POLICY } from './prompts.ts'

// The file explains itself in HTML comments so its own instructions never
// reach the model as policy; everything else is the listener's text.
const COMMENTS = /<!--[\s\S]*?-->/g

const TEMPLATE = `<!--
murmur music policy.

This is the half of the pick instruction that is yours. murmur re-reads it
every time it goes looking for a song, so an edit takes effect on its own --
no restart, no reload. It chooses a song shortly before it needs one, so an
edit reaches the next song, or the one after if that choice was already made.
Delete the file to go back to the default below. Anything inside an HTML
comment (like this) is stripped before the text reaches the brain, so notes to
yourself are free.

What you are writing is taste and method: what to reach for, what to avoid,
how to look. What you cannot change from here is the mechanism -- murmur
always searches, judges, and commits to one track with a spoken intro.

The tools your policy can direct:
  search_music   find candidates by query (it executes your words literally)
  similar_music  what real listeners play alongside an artist or track
  top_tracks     what they actually play the most BY an artist
The last two exist only when MURMUR_LASTFM_API_KEY is set; without it, say
what you want in words and let search do the rest.

Rewrite freely. Some things worth saying: a language or region to favour, a
decade to live in, artists you never want to hear again, how far off your
usual taste to wander, what a weeknight should sound like versus a Sunday.
-->

${DEFAULT_MUSIC_POLICY}
`

export function parseMusicPolicy(text: string): string | undefined {
  const body = text.replace(COMMENTS, '').trim()
  return body === '' ? undefined : body
}

export function readMusicPolicy(path: string): string | undefined {
  try {
    return parseMusicPolicy(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

// Seeded once at boot, because a policy the listener never sees is one they
// can never edit. `wx` makes "already there" a normal outcome, so their own
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
