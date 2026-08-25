// The listener's music policy (spec 03-01 §2.3): the taste half of the pick
// instruction, as a file they own at $MURMUR_HOME/music-policy.md.
//
// Read fresh on every pick rather than watched or cached — a pick already
// costs seconds of network, so one small read is free, and an edit lands on
// the next song with no restart and no reload command. An absent, empty, or
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

This is the taste half of the instruction murmur gives the brain when it goes
looking for the next song. Edit it however you like -- it is re-read before
every pick, so a change lands on the next song. No restart, no reload.

Delete the file to go back to the defaults below. Text in HTML comments (like
this) is stripped, so notes to yourself cost nothing.

How murmur picks a track never changes here: that half lives in the code.
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
