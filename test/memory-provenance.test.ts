// The fold's output contract (spec 05-01 §3.3): a fact carries the listener
// lines it was learned from, the code owns the date, a malformed fold is
// refused whole, and a profile written before the contract is migrated out of
// the prompts rather than trusted.

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PersistentMemoryStore, srcId, validateFold } from '../src/memory/memory.ts'
import { PROFILE_CHAR_CAP, PROFILE_LINE_CAP } from '../src/prompts/profile.ts'
import { aboutSection } from '../src/prompts/talk.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'murmur-prov-'))
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000

function clock(start: number) {
  let t = start
  return { now: () => t, advance: (s: number) => (t += s) }
}

const HEADERS = ['(About the listener)', '', '(Relationship & style)'] as const
// The two labelled sections the contract requires, with the given facts under
// the first. A `[src hand]` line here would be refused on purpose: only the
// code writes that citation.
const shaped = (...facts: string[]) =>
  ['(About the listener)', ...facts, '', '(Relationship & style)'].join('\n')

// A store with one host line and one admitted listener line on the backlog.
function loaded(path: string, now: () => number) {
  const store = new PersistentMemoryStore({ dir: path, now, compactEvery: 1 })
  store.record({ role: 'radio', text: 'the light outside the window has gone amber' })
  store.record({ role: 'user', text: 'the desk faces the window now, it changed the room' })
  return store
}

const bytes = (path: string) => (existsSync(path) ? readFileSync(path) : null)

describe('fold citations (spec 05-01 §3.3, P0-1)', () => {
  it('accepts a fact citing a listener line and dates it from that line', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    const store = loaded(path, c.now)
    const slice = store.compactionSlice()
    const listener = slice.turns.filter((t) => t.cite !== undefined)
    expect(listener).toHaveLength(1)

    // The clock moves on: the date must come from the cited line, not from now.
    c.advance(10 * 86400)
    expect(
      store.applyCompaction(shaped(`- The desk faces the window [src ${listener[0]!.cite}]`), slice.throughTs),
    ).toBe(true)
    expect(store.profile()).toContain('- The desk faces the window [src ')
    expect(store.profile()).toContain('[seen 2026-09-05]')
    expect(store.profile()).not.toContain('[seen 2026-09-15]')
  })

  it('refuses the whole fold when a line cites a timestamp outside the slice', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    const store = loaded(path, c.now)
    const slice = store.compactionSlice()
    const before = { profile: bytes(join(path, 'profile.md')), meta: bytes(join(path, 'meta.json')) }

    expect(store.applyCompaction(shaped('- Invented a fact [src 1700000000000]'), slice.throughTs)).toBe(
      false,
    )
    expect(bytes(join(path, 'profile.md'))).toEqual(before.profile)
    expect(bytes(join(path, 'meta.json'))).toEqual(before.meta)
    expect(store.profile()).toBe('')
    // The watermark did not move: the same turns are still owed to the next fold.
    expect(store.compactionSlice().turns.filter((t) => t.cite !== undefined)).toHaveLength(1)
  })

  // The poisoned-fold case the audit found on the real install: the radio's own
  // monologue folded in as if the listener had said it.
  it('refuses a fold that cites a host line', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    const store = new PersistentMemoryStore({ dir: path, now: c.now, compactEvery: 1 })
    store.record({ role: 'radio', text: 'the light outside the window has gone amber' })
    store.record({ role: 'user', text: 'play something else, this one is too bright' })
    const slice = store.compactionSlice()
    const hostTs = srcId(at('2026-09-05'))

    expect(
      store.applyCompaction(
        shaped(`- Moved by the light outside the window [src ${hostTs}]`),
        slice.throughTs,
      ),
    ).toBe(false)
    expect(store.profile()).toBe('')
    expect(existsSync(join(path, 'profile.md'))).toBe(false)
  })

  it('refuses a fact line with no citation at all', () => {
    const c = clock(at('2026-09-05'))
    const store = loaded(dir(), c.now)
    const slice = store.compactionSlice()
    expect(store.applyCompaction(shaped('- A fact from nowhere'), slice.throughTs)).toBe(false)
  })

  it('carries an untouched line over verbatim, keeping its own date', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    const kept = '- Name they go by: Z [src bootstrap] [seen 2026-06-01] [stable]'
    writeFileSync(join(path, 'profile.md'), shaped(kept))
    writeFileSync(join(path, 'meta.json'), JSON.stringify({ compacted_through: 0, profile_schema: 1 }))
    const store = loaded(path, c.now)
    const slice = store.compactionSlice()
    const cite = slice.turns.find((t) => t.cite !== undefined)!.cite

    // The model returns the kept line with a DIFFERENT date on it (b).
    const tampered = '- Name they go by: Z [src bootstrap] [seen 2026-09-05] [stable]'
    expect(
      store.applyCompaction(shaped(tampered, `- The desk faces the window [src ${cite}]`), slice.throughTs),
    ).toBe(true)
    expect(store.profile()).toContain('- Name they go by: Z [src bootstrap] [seen 2026-06-01] [stable]')
    expect(store.profile()).not.toContain('Name they go by: Z [src bootstrap] [seen 2026-09-05]')
  })
})

describe('fold output validation (spec 05-01 §3.3, P0-2)', () => {
  const c = clock(at('2026-09-05'))
  const cited = (path: string) => {
    const store = loaded(path, c.now)
    const slice = store.compactionSlice()
    return { store, slice, cite: slice.turns.find((t) => t.cite !== undefined)!.cite }
  }

  it('refuses a preamble, a missing section header, an over-cap profile and an over-long line', () => {
    for (const build of [
      (cite: number) => `Here is the updated profile:\n\n${shaped(`- A fact [src ${cite}]`)}`,
      (cite: number) => `(About the listener)\n- A fact [src ${cite}]`,
      (cite: number) => shaped(`- ${'a'.repeat(PROFILE_CHAR_CAP + 100)} [src ${cite}]`),
      (cite: number) => shaped(`- ${'b'.repeat(PROFILE_LINE_CAP + 1)} [src ${cite}]`),
    ]) {
      const path = dir()
      const { store, slice, cite } = cited(path)
      const before = { profile: bytes(join(path, 'profile.md')), meta: bytes(join(path, 'meta.json')) }
      expect(store.applyCompaction(build(cite!), slice.throughTs)).toBe(false)
      expect(bytes(join(path, 'profile.md'))).toEqual(before.profile)
      expect(bytes(join(path, 'meta.json'))).toEqual(before.meta)
    }
  })

  it('refuses a fact line that is not a bullet', () => {
    const path = dir()
    const { store, slice, cite } = cited(path)
    expect(store.applyCompaction(shaped(`The desk faces the window [src ${cite}]`), slice.throughTs)).toBe(
      false,
    )
  })

  it('validateFold names both section headers as required', () => {
    const allowed = new Set([srcId(at('2026-09-05'))])
    const ok = validateFold(shaped(`- A fact [src ${srcId(at('2026-09-05'))}]`), allowed, '')
    expect(ok.ok).toBe(true)
    expect(validateFold(HEADERS.join('\n'), allowed, '').ok).toBe(true)
  })
})

describe('legacy profile migration (spec 05-01 §3.3, P0-3)', () => {
  const legacy = [
    '(About the listener)',
    'Moved by the light outside the window, and by the passing of time. [seen 2026-09-03]',
    '',
    '(Relationship & style)',
    'Accepts open-ended company that needs no reply. [seen 2026-09-03]',
  ].join('\n')

  it('moves every uncited line to profile-faded.md and leaves the prompts empty', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    writeFileSync(join(path, 'profile.md'), legacy)
    writeFileSync(join(path, 'meta.json'), JSON.stringify({ compacted_through: 1788331027 }))

    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(store.profile()).toBe('')
    expect(aboutSection(store.profile())).toBe('')
    const faded = readFileSync(join(path, 'profile-faded.md'), 'utf-8')
    expect(faded).toContain('light outside the window')
    expect(faded).toContain('open-ended company')
    // Recall can still answer for what was migrated out.
    expect(store.recall('window', 5).length).toBeGreaterThan(0)
    // The watermark is untouched by a migration.
    expect(JSON.parse(readFileSync(join(path, 'meta.json'), 'utf-8')).compacted_through).toBe(1788331027)
  })

  it('runs once: an uncited line written after the migration is a hand edit', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    writeFileSync(join(path, 'profile.md'), legacy)
    new PersistentMemoryStore({ dir: path, now: c.now })

    writeFileSync(join(path, 'profile.md'), '(About the listener)\n- Prefers tea\n\n(Relationship & style)')
    const second = new PersistentMemoryStore({ dir: path, now: c.now })
    expect(second.profile()).toContain('- Prefers tea [src hand] [seen 2026-09-05]')
    expect(readFileSync(join(path, 'profile-faded.md'), 'utf-8')).not.toContain('Prefers tea')
  })

  it('a bootstrapped profile is written with its own citation', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    const store = new PersistentMemoryStore({ dir: path, now: c.now })
    store.writeProfile('(About the listener)\nShips TypeScript at night.\n\n(Relationship & style)\nTerse.')
    expect(store.profile()).toContain('Ships TypeScript at night. [src bootstrap] [seen 2026-09-05]')
    expect(aboutSection(store.profile())).toBe('Ships TypeScript at night.')
  })
})

describe('forget cascades to the facts it sourced (spec 05-01 §3.5, P0-1)', () => {
  it('drops a profile line whose only source row is erased, however it is worded', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    const store = new PersistentMemoryStore({ dir: path, now: c.now, compactEvery: 1 })
    store.record({ role: 'user', text: 'my friend Sarah moved to Lisbon last spring' })
    store.record({ role: 'user', text: 'the kettle whistles every morning at seven' })
    const slice = store.compactionSlice()
    const [sarah, kettle] = slice.turns.filter((t) => t.cite !== undefined)

    expect(
      store.applyCompaction(
        shaped(
          `- Has someone close who left for Portugal [src ${sarah!.cite}]`,
          `- A morning ritual with the stove [src ${kettle!.cite}]`,
        ),
        slice.throughTs,
      ),
    ).toBe(true)

    expect(store.forget('Sarah').rows).toBe(1)
    // The wording shares no words with the request, so only the citation can
    // carry the erasure through.
    expect(store.profile()).not.toContain('Portugal')
    expect(readFileSync(join(path, 'profile.md'), 'utf-8')).not.toContain('Portugal')
    // The fact sourced elsewhere stays.
    expect(store.profile()).toContain('A morning ritual with the stove')
  })
})

describe('faded file dedupe (audit P1-5)', () => {
  it('keeps one copy of a line that fades more than once', () => {
    const c = clock(at('2026-09-05'))
    const path = dir()
    const line = '- An ancient fact [src hand] [seen 2025-01-01]'
    writeFileSync(join(path, 'profile.md'), shaped(line))
    writeFileSync(join(path, 'meta.json'), JSON.stringify({ compacted_through: 0, profile_schema: 1 }))

    new PersistentMemoryStore({ dir: path, now: c.now })
    writeFileSync(join(path, 'profile.md'), shaped(line))
    new PersistentMemoryStore({ dir: path, now: c.now })

    const faded = readFileSync(join(path, 'profile-faded.md'), 'utf-8')
    expect(faded.split('\n').filter((l) => l.includes('An ancient fact'))).toHaveLength(1)
    expect(statSync(join(path, 'profile-faded.md')).size).toBeGreaterThan(0)
  })
})
