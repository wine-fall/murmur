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
  voice: 'hosted',
  tuiPet: true,
}

const home = () => mkdtempSync(join(tmpdir(), 'murmur-settings-'))
const fileIn = (dir: string) => join(dir, 'settings.json')

function store(over: {
  path?: string
  initial?: Partial<Settings>
  touched?: Partial<Settings>
  derived?: 'stub' | 'hosted'
  log?: (message: string) => void
}) {
  return new SettingsStore({
    path: over.path ?? fileIn(home()),
    initial: { ...BASE, ...over.initial },
    touched: over.touched ?? {},
    derivedVoice: () => over.derived ?? 'hosted',
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
        voice: 'stub', // fine
        musicEveryN: 3, // fine
        somethingElse: true, // unknown -> dropped silently
      }),
    )
    const logged: string[] = []
    expect(readSettingsFile(path, (m) => logged.push(m))).toEqual({
      voice: 'stub',
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

  it('muting writes voice: stub; unmuting deletes the key and re-derives', () => {
    const path = fileIn(home())
    const s = store({ path, derived: 'hosted' })
    s.set({ voice: 'stub' })
    expect(s.current().voice).toBe('stub')
    expect(readSettingsFile(path)).toEqual({ voice: 'stub' })
    s.set({ voice: null })
    expect(s.current().voice).toBe('hosted')
    expect(readSettingsFile(path)).toEqual({})
  })

  it('unmuting with no endpoint derives stub (silence stays honest)', () => {
    const s = store({ derived: 'stub', initial: { voice: 'stub' } })
    s.set({ voice: null })
    expect(s.current().voice).toBe('stub')
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
