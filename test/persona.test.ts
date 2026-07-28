import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadPersona } from '../src/persona.ts'
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
