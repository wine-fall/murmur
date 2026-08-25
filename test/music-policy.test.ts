// The listener's music policy (spec 03-01 §2.3): the taste half of the pick
// instruction as a file they own, read fresh per pick and seeded once so it is
// discoverable.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseMusicPolicy, readMusicPolicy, seedMusicPolicy } from '../src/music-policy.ts'
import { DEFAULT_MUSIC_POLICY } from '../src/prompts.ts'

const home = () => mkdtempSync(join(tmpdir(), 'murmur-policy-'))
const fileIn = (dir: string) => join(dir, 'music-policy.md')

describe('parseMusicPolicy', () => {
  it("keeps the listener text and drops the file's own explanation", () => {
    const text = '<!-- edit me freely;\n     re-read every pick -->\n\n## my taste\n- more cantopop\n'
    expect(parseMusicPolicy(text)).toBe('## my taste\n- more cantopop')
  })

  it('treats a file that is only explanation, or blank, as no policy', () => {
    expect(parseMusicPolicy('<!-- nothing but this -->\n\n')).toBeUndefined()
    expect(parseMusicPolicy('   \n\n')).toBeUndefined()
  })
})

describe('readMusicPolicy', () => {
  it('reads the file when it is there', () => {
    const dir = home()
    writeFileSync(fileIn(dir), '- only cantopop\n', 'utf-8')
    expect(readMusicPolicy(fileIn(dir))).toBe('- only cantopop')
  })

  // A missing policy is the shipped default, not a boot failure: the radio
  // must play the same as it did before the file existed.
  it('degrades to no policy when the file is absent or unreadable', () => {
    expect(readMusicPolicy(fileIn(home()))).toBeUndefined()
    expect(readMusicPolicy(home())).toBeUndefined() // a directory, not a file
  })
})

describe('seedMusicPolicy', () => {
  it('writes a template carrying the built-in policy, so the file is editable', () => {
    const dir = home()
    expect(seedMusicPolicy(fileIn(dir))).toBe(true)
    const text = readFileSync(fileIn(dir), 'utf-8')
    expect(text).toContain(DEFAULT_MUSIC_POLICY)
    // The explanation rides in a comment, so the seeded file parses back to
    // exactly the built-in policy -- seeding changes nothing about the picks.
    expect(parseMusicPolicy(text)).toBe(DEFAULT_MUSIC_POLICY)
  })

  it('never overwrites what the listener wrote', () => {
    const dir = home()
    writeFileSync(fileIn(dir), '- mine\n', 'utf-8')
    expect(seedMusicPolicy(fileIn(dir))).toBe(false)
    expect(readMusicPolicy(fileIn(dir))).toBe('- mine')
  })

  it('reports failure instead of throwing when the home cannot be written', () => {
    const dir = home()
    writeFileSync(join(dir, 'blocker'), 'not a directory\n', 'utf-8')
    expect(seedMusicPolicy(join(dir, 'blocker', 'music-policy.md'))).toBe(false)
  })
})
