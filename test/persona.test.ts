import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadPersona, personaLine } from '../src/persona.ts'
import { DEFAULT_PERSONA_PATH } from '../src/prompts.ts'

describe('loadPersona', () => {
  it('loads and trims the bundled seed', () => {
    const persona = loadPersona(DEFAULT_PERSONA_PATH)
    expect(persona).toContain('murmur')
    expect(persona.startsWith('#')).toBe(true)
  })

  it('rejects a missing file with a clear error', () => {
    expect(() => loadPersona('/no/such/persona.md')).toThrow(/not found/)
  })

  it('rejects an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-test-'))
    const path = join(dir, 'empty.md')
    writeFileSync(path, '   \n')
    expect(() => loadPersona(path)).toThrow(/empty/)
  })
})

// spec 10 §3.2-D: the identity the status strip (and the plain banner) shows.
// It shares one line with the scene and the presence state, so it has to be a
// NAME — the seed's heading carries the name plus the file's own business.
describe('personaLine', () => {
  it('takes the name out of the seed heading, dropping the authoring detail', () => {
    expect(personaLine('# murmur \u2014 persona seed (L0 static)\n\nYou are the host.')).toBe('murmur')
    expect(personaLine('# murmur (L0 static)')).toBe('murmur')
    expect(personaLine('## a night host - the quiet one')).toBe('a night host')
  })

  it('keeps a plain first line, capped so it cannot crowd out the strip', () => {
    expect(personaLine('a night host who talks to one person')).toBe(
      'a night host who talks to one person',
    )
    const long = personaLine(`x${'y'.repeat(200)}`)
    expect(long.length).toBeLessThanOrEqual(48)
    expect(long.endsWith('\u2026')).toBe(true)
  })

  it('never renders nothing', () => {
    expect(personaLine('   ')).toBe('(empty)')
    expect(personaLine('#')).toBe('(empty)')
  })
})
