// The listener's music notes (spec 03-01 §2.3): a file they own, ADDED to the
// built-in policy, read fresh per pick and seeded once so it is discoverable.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseMusicNotes, readMusicNotes, RETIRED_MUSIC_POLICIES, seedMusicPolicy } from '../src/music/music-policy.ts'
import { buildFindMusicInstruction, DEFAULT_MUSIC_POLICY, FIND_MUSIC_INSTRUCTION, LISTENER_NOTES_HEADER } from '../src/prompts/music.ts'

const home = () => mkdtempSync(join(tmpdir(), 'murmur-policy-'))
const fileIn = (dir: string) => join(dir, 'music-policy.md')
const withFile = (text: string): string => {
  const path = fileIn(home())
  writeFileSync(path, text, 'utf-8')
  return path
}

// Every text a seeded file could hold verbatim: the shipped default today and
// each one it replaced.
const EVERY_DEFAULT = [DEFAULT_MUSIC_POLICY, ...RETIRED_MUSIC_POLICIES]

describe('parseMusicNotes', () => {
  it("keeps the listener text and drops the file's own explanation", () => {
    const text = '<!-- edit me freely;\n     re-read every pick -->\n\n## my taste\n- more cantopop\n'
    expect(parseMusicNotes(text)).toBe('## my taste\n- more cantopop')
  })

  it('treats a file that is only explanation, or blank, as no notes', () => {
    expect(parseMusicNotes('<!-- nothing but this -->\n\n')).toBeUndefined()
    expect(parseMusicNotes('   \n\n')).toBeUndefined()
    expect(parseMusicNotes('')).toBeUndefined()
  })

  // A file seeded before the policy was code-owned holds a full copy of the
  // default of its day. That copy is not the listener speaking, and kept as
  // notes it would outrank the current default with the rules it replaced.
  it('reads a copy of any shipped default as no notes', () => {
    expect(RETIRED_MUSIC_POLICIES.length).toBeGreaterThan(0)
    for (const policy of EVERY_DEFAULT) {
      expect(parseMusicNotes(`<!-- the old explanation -->\n\n${policy}\n`)).toBeUndefined()
    }
  })

  it('still recognises the copy after an editor reflowed its whitespace', () => {
    for (const policy of EVERY_DEFAULT) {
      expect(parseMusicNotes(policy.replace(/\n {3}/g, '\r\n      ').replace(/ /g, '  '))).toBeUndefined()
    }
  })

  // The seeded file invited editing in place, so the likeliest real note is a
  // line added around the old copy: the line is theirs, the copy is not.
  it('keeps what the listener added around an old copy, and only that', () => {
    for (const policy of EVERY_DEFAULT) {
      const text = `- Mostly songs from coastal towns.\n\n${policy}\n\n- Nothing longer than six minutes.\n`
      expect(parseMusicNotes(text)).toBe('- Mostly songs from coastal towns.\n\n- Nothing longer than six minutes.')
    }
  })

  // An old copy the listener rewrote inside is their policy now; murmur cannot
  // tell which half they meant, so it keeps the whole text as theirs.
  it('keeps an edited copy whole', () => {
    const edited = RETIRED_MUSIC_POLICIES[0]!.replace('Read the room before the record.', 'Read the room twice.')
    expect(parseMusicNotes(edited)).toBe(edited.trim())
  })
})

describe('readMusicNotes', () => {
  it('reads the notes when the file is there', () => {
    expect(readMusicNotes(withFile('- only cantopop\n'))).toBe('- only cantopop')
  })

  // A missing file is the shipped default, not a boot failure.
  it('degrades to no notes when the file is absent or unreadable', () => {
    expect(readMusicNotes(fileIn(home()))).toBeUndefined()
    expect(readMusicNotes(home())).toBeUndefined() // a directory, not a file
  })
})

// The composed instruction, end to end from the file on disk.
describe('the pick instruction a file produces', () => {
  const fromFile = (path: string) => buildFindMusicInstruction(readMusicNotes(path))

  it('is the built-in instruction exactly when the file holds no notes', () => {
    expect(fromFile(fileIn(home()))).toBe(FIND_MUSIC_INSTRUCTION)
    expect(fromFile(withFile(''))).toBe(FIND_MUSIC_INSTRUCTION)
    expect(fromFile(withFile('<!-- only an explanation -->\n'))).toBe(FIND_MUSIC_INSTRUCTION)
    for (const policy of EVERY_DEFAULT) {
      expect(fromFile(withFile(`<!-- seeded -->\n\n${policy}\n`))).toBe(FIND_MUSIC_INSTRUCTION)
    }
  })

  it('carries the built-in policy, then the notes under their own heading', () => {
    const notes = '- Favour songs sung in Portuguese this month.'
    const instruction = fromFile(withFile(`<!-- mine -->\n${notes}\n`))
    const policyAt = instruction.indexOf(DEFAULT_MUSIC_POLICY)
    const headerAt = instruction.indexOf(LISTENER_NOTES_HEADER)
    expect(policyAt).toBeGreaterThan(-1)
    expect(headerAt).toBeGreaterThan(policyAt)
    expect(instruction.indexOf(notes)).toBeGreaterThan(headerAt)
  })
})

describe('seedMusicPolicy', () => {
  // The seed is only an explanation: the policy itself is code-owned, so an
  // improvement to it reaches every install, and the file holds what the
  // listener adds.
  it('writes a template that is only an explanation, so it adds nothing', () => {
    const dir = home()
    expect(seedMusicPolicy(fileIn(dir))).toBe(true)
    const text = readFileSync(fileIn(dir), 'utf-8')
    expect(parseMusicNotes(text)).toBeUndefined()
    expect(text).not.toContain(DEFAULT_MUSIC_POLICY.slice(0, 40))
    expect(text).toMatch(/added to/i)
    expect(text).toMatch(/outranks/i)
  })

  // The seed is written with `wx` and never rewritten, so anything in it that
  // can go stale is stale forever on that listener's disk. Names that live in
  // the README belong in the README.
  it('does not hardcode configuration names that could drift', () => {
    const dir = home()
    seedMusicPolicy(fileIn(dir))
    expect(readFileSync(fileIn(dir), 'utf-8')).not.toMatch(/MURMUR_[A-Z_]+/)
  })

  // Same reason, one step further: a tool named here is a tool the listener
  // is invited to direct, and the file outlives the tool list.
  it('does not name a tool the pick task no longer has', () => {
    const dir = home()
    seedMusicPolicy(fileIn(dir))
    const text = readFileSync(fileIn(dir), 'utf-8')
    for (const gone of ['similar_music', 'top_tracks']) {
      expect(text).not.toContain(gone)
    }
  })

  it('never overwrites what the listener wrote', () => {
    const dir = home()
    writeFileSync(fileIn(dir), '- mine\n', 'utf-8')
    expect(seedMusicPolicy(fileIn(dir))).toBe(false)
    expect(readMusicNotes(fileIn(dir))).toBe('- mine')
  })

  // An install seeded with a full copy of an old default keeps its file
  // byte-for-byte: the copy is ignored when read, never rewritten on disk.
  it('leaves an old seeded copy on disk untouched', () => {
    const old = `<!-- the old explanation -->\n\n${RETIRED_MUSIC_POLICIES[0]!}\n`
    const path = withFile(old)
    expect(seedMusicPolicy(path)).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe(old)
  })

  it('reports failure instead of throwing when the home cannot be written', () => {
    const dir = home()
    writeFileSync(join(dir, 'blocker'), 'not a directory\n', 'utf-8')
    expect(seedMusicPolicy(join(dir, 'blocker', 'music-policy.md'))).toBe(false)
  })
})
