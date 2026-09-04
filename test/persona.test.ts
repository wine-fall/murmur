import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadPersona, personaLanguage, personaLine, renderPersona } from '../src/persona.ts'
import { DEFAULT_PERSONA_PATH } from '../src/prompts.ts'

describe('loadPersona', () => {
  it('loads and trims the bundled seed', () => {
    const persona = loadPersona(DEFAULT_PERSONA_PATH, 'English')
    expect(persona).toContain('murmur')
    expect(persona.startsWith('#')).toBe(true)
  })

  it('rejects a missing file with a clear error', () => {
    expect(() => loadPersona('/no/such/persona.md', 'English')).toThrow(/not found/)
  })

  it('rejects an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-test-'))
    const path = join(dir, 'empty.md')
    writeFileSync(path, '   \n')
    expect(() => loadPersona(path, 'English')).toThrow(/empty/)
  })
})

// spec 06 §3.2: the bundled seed hardcodes no language. It names one slot,
// filled with the language decided for this install — English unless the
// machine's locale says otherwise.
describe('renderPersona', () => {
  it('fills every language slot', () => {
    expect(renderPersona('speak {{language}}; only {{language}}.', 'Japanese')).toBe(
      'speak Japanese; only Japanese.',
    )
  })

  it('leaves a persona that names its own language alone', () => {
    const written = 'You are a host. Always speak in French.'
    expect(renderPersona(written, 'Japanese')).toBe(written)
  })

  it('ships the bundled seed with a slot and no hardcoded language', () => {
    const seed = loadPersona(DEFAULT_PERSONA_PATH, 'Japanese')
    expect(seed).toContain('Japanese')
    expect(seed).not.toContain('{{')
  })

  it('defaults that seed to English', () => {
    expect(loadPersona(DEFAULT_PERSONA_PATH, 'English')).toMatch(/speak in English/i)
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

// spec 13 §3.5: the spoken language lives in the persona's own words once the
// install is past its first run — the machine locale may have changed since.
describe('personaLanguage', () => {
  it('reads the language the persona says it speaks', () => {
    expect(personaLanguage('# x\n- **Always speak in Chinese (Mandarin).** Natural and spoken.')).toBe(
      'Chinese (Mandarin)',
    )
    expect(personaLanguage('You are Ame. Speak in Japanese, softly.')).toBe('Japanese')
  })

  it('is undefined when the persona never names one, and a manner is not a language', () => {
    expect(personaLanguage('You are the host. Keep it warm.')).toBeUndefined()
    expect(personaLanguage('Speak in a warm tone, never rushed.')).toBeUndefined()
    expect(personaLanguage(renderPersona('speak in {{language}}', 'English'))).toBe('English')
  })
})
