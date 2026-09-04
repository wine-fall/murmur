// The settings layer (spec 12 §2.1/§2.4): per-key salvage on read, atomic
// write, and the engine-owned store that is the single mutation path.

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Settings } from '../src/ipc.ts'
import { readSettingsFile, SettingsStore, writeSettingsFile } from '../src/settings.ts'

const BASE: Settings = {
  anchorsEnabled: true,
  musicEnabled: true,
  cadenceMode: 'every_n',
  musicEveryN: 2,
  gapSeconds: 2,
  recentWindow: 12,
  muted: false,
  tuiPet: true,
  rwtEnabled: true,
}

const home = () => mkdtempSync(join(tmpdir(), 'murmur-settings-'))
const fileIn = (dir: string) => join(dir, 'settings.json')

function store(over: {
  path?: string
  initial?: Partial<Settings>
  touched?: Partial<Settings>
  log?: (message: string) => void
}) {
  return new SettingsStore({
    path: over.path ?? fileIn(home()),
    initial: { ...BASE, ...over.initial },
    touched: over.touched ?? {},
    ...(over.log !== undefined && { log: over.log }),
  })
}

describe('the settings file (spec 12 §2.1)', () => {
  it('reads back what it wrote, atomically (no temp file left)', () => {
    const path = fileIn(home())
    writeSettingsFile(path, { musicEnabled: false, gapSeconds: 3.5 })
    expect(readSettingsFile(path)).toEqual({ musicEnabled: false, gapSeconds: 3.5 })
    const names = readdirSync(join(path, '..'))
    expect(names).toEqual(['settings.json'])
  })

  it('a missing file reads as empty', () => {
    expect(readSettingsFile(fileIn(home()))).toEqual({})
  })

  it('an unparseable file reads as empty, with one log line', () => {
    const path = fileIn(home())
    writeFileSync(path, '{not json')
    const logged: string[] = []
    expect(readSettingsFile(path, (m) => logged.push(m))).toEqual({})
    expect(logged.length).toBe(1)
  })

  it('salvages per key: a broken key is dropped alone, siblings survive', () => {
    const path = fileIn(home())
    writeFileSync(
      path,
      JSON.stringify({
        gapSeconds: -5, // broken (negative)
        recentWindow: 'many', // broken (not a number)
        muted: true, // fine
        musicEveryN: 3, // fine
        somethingElse: true, // unknown -> dropped silently
      }),
    )
    const logged: string[] = []
    expect(readSettingsFile(path, (m) => logged.push(m))).toEqual({
      muted: true,
      musicEveryN: 3,
    })
    expect(logged.length).toBe(2) // one line per broken key
  })

  it('creates the parent directory at the write site', () => {
    const path = join(home(), 'deeper', 'settings.json')
    writeSettingsFile(path, { tuiPet: false })
    expect(readSettingsFile(path)).toEqual({ tuiPet: false })
  })
})

describe('SettingsStore (spec 12 §2.4)', () => {
  it('starts from the merged config, not the file', () => {
    const s = store({ initial: { gapSeconds: 7 }, touched: { gapSeconds: 3 } })
    expect(s.current().gapSeconds).toBe(7) // a flag beat the file at boot
  })

  it('set applies live, persists, and notifies — in that order', () => {
    const path = fileIn(home())
    const seen: Settings[] = []
    const s = store({ path })
    s.onChange((next) => seen.push(next))
    expect(s.set({ musicEnabled: false })).toBe(true)
    expect(s.current().musicEnabled).toBe(false)
    expect(readSettingsFile(path)).toEqual({ musicEnabled: false })
    expect(seen.length).toBe(1)
    expect(seen[0]!.musicEnabled).toBe(false)
  })

  it('an unrelated set never rewrites keys the user has not touched', () => {
    const path = fileIn(home())
    const s = store({ path, touched: { gapSeconds: 3 } })
    s.set({ tuiPet: false })
    expect(readSettingsFile(path)).toEqual({ gapSeconds: 3, tuiPet: false })
  })

  it('mute is a plain persisted boolean, both ways', () => {
    const path = fileIn(home())
    const s = store({ path })
    s.set({ muted: true })
    expect(s.current().muted).toBe(true)
    expect(readSettingsFile(path)).toEqual({ muted: true })
    s.set({ muted: false })
    expect(s.current().muted).toBe(false)
    expect(readSettingsFile(path)).toEqual({ muted: false })
  })

  it('an invalid patch is a no-op reported false', () => {
    const path = fileIn(home())
    const s = store({ path })
    const before = s.current()
    expect(s.set({ gapSeconds: -1 })).toBe(false)
    expect(s.set({})).toBe(false)
    expect(s.current()).toEqual(before)
    expect(existsSync(path)).toBe(false) // nothing was ever written
  })
})

// spec 12 §3.9: the one optional knob. Absent means "the user never said" and
// the persona decides — so setting it must be reversible all the way back to
// absent, not merely to some default.
describe('the language override (spec 12 §3.9)', () => {
  it('round-trips through the file like any other key', () => {
    const path = fileIn(home())
    writeSettingsFile(path, { language: 'Japanese' })
    expect(readSettingsFile(path)).toEqual({ language: 'Japanese' })
  })

  it('salvages a file whose language is unusable, keeping the good keys', () => {
    const path = fileIn(home())
    writeFileSync(path, JSON.stringify({ language: 'x\ny', muted: true }))
    expect(readSettingsFile(path)).toEqual({ muted: true })
  })

  it('starts absent and applies as a plain set', () => {
    const s = store({})
    expect(s.current().language).toBeUndefined()
    expect(s.set({ language: 'Traditional Chinese' })).toBe(true)
    expect(s.current().language).toBe('Traditional Chinese')
  })

  it('an empty string clears the override rather than storing a blank', () => {
    const path = fileIn(home())
    const s = store({ path, initial: { language: 'Japanese' }, touched: { language: 'Japanese' } })
    expect(s.set({ language: '' })).toBe(true)
    expect(s.current().language).toBeUndefined()
    // Cleared on disk too: a stale key would resurrect the override next boot.
    expect(readSettingsFile(path).language).toBeUndefined()
  })

  it('clearing an override that was never set is still a no-op set, not a crash', () => {
    const s = store({})
    expect(s.set({ language: '' })).toBe(true)
    expect(s.current().language).toBeUndefined()
  })

  it('refuses a value that is not a language name', () => {
    const s = store({})
    expect(s.set({ language: 'a'.repeat(60) })).toBe(false)
    expect(s.set({ language: 'Japanese\nand also English' })).toBe(false)
    expect(s.current().language).toBeUndefined()
  })
})
