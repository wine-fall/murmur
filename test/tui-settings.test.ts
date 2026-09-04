// The settings pane's pure logic (spec 12 §3.5/§3.6): exactly eight items,
// intent labels only, gear presets with an honest custom position, steppers
// with pane-enforced ranges. Rendering stays untested (spec 10 §3.9); this is
// the state machine the client renders.

import { describe, expect, it } from 'vitest'

import { LANGUAGE_MAX, type Settings, type SettingsSnapshot } from '../src/ipc.ts'
import { adjust, gearOf, languagePatch, paneFacts, paneItems } from '../tui/src/settings-pane.ts'

const VALUES: Settings = {
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

const snap = (
  values: Partial<Settings> = {},
  over: Partial<Omit<SettingsSnapshot, 'values'>> = {},
): SettingsSnapshot => ({
  values: { ...VALUES, ...values },
  home: '/home/me/.murmur',
  voiceConfigured: true,
  musicAvailable: true,
  ...over,
})

describe('paneItems', () => {
  it('lists exactly the eight writable intents, in a fixed order', () => {
    const keys = paneItems(snap()).map((item) => item.key)
    expect(keys).toEqual(['anchors', 'music', 'gear', 'gap', 'voice', 'language', 'pet', 'window'])
  })

  it('never leaks a field name or mode name into a label or value', () => {
    const rendered = paneItems(snap({ cadenceMode: 'random' }))
      .flatMap((item) => [item.label, item.value])
      .join(' ')
    for (const leak of ['every_n', 'random', 'brain', 'cadenceMode', 'musicEveryN', 'recentWindow', 'gapSeconds', 'anchorsEnabled', 'tuiPet']) {
      expect(rendered).not.toContain(leak)
    }
  })

  it('the sound toggle never greys — the mute is the output gain, not an endpoint feature', () => {
    const sound = (s: SettingsSnapshot) => paneItems(s).find((i) => i.key === 'voice')!
    expect(sound(snap()).enabled).toBe(true)
    expect(sound(snap({}, { voiceConfigured: false })).enabled).toBe(true)
    expect(sound(snap({ muted: true })).value).toBe('muted')
  })

  it('greys music when unavailable, and the gear whenever music is off or unavailable', () => {
    const of = (s: SettingsSnapshot, key: string) => paneItems(s).find((i) => i.key === key)!
    expect(of(snap({}, { musicAvailable: false }), 'music').enabled).toBe(false)
    expect(of(snap({}, { musicAvailable: false }), 'gear').enabled).toBe(false)
    expect(of(snap({ musicEnabled: false }), 'gear').enabled).toBe(false)
    expect(of(snap(), 'gear').enabled).toBe(true)
  })

  it('puts only the memory span in the advanced group', () => {
    const advanced = paneItems(snap()).filter((i) => i.advanced)
    expect(advanced.map((i) => i.key)).toEqual(['window'])
  })
})

describe('gearOf', () => {
  it('names the three presets and everything else custom', () => {
    expect(gearOf({ ...VALUES, musicEveryN: 1 })).toBe('more music')
    expect(gearOf({ ...VALUES, musicEveryN: 2 })).toBe('balanced')
    expect(gearOf({ ...VALUES, musicEveryN: 4 })).toBe('more talk')
    expect(gearOf({ ...VALUES, musicEveryN: 7 })).toBe('custom')
    expect(gearOf({ ...VALUES, cadenceMode: 'random' })).toBe('custom')
    expect(gearOf({ ...VALUES, cadenceMode: 'brain' })).toBe('custom')
  })
})

describe('adjust', () => {
  it('flips the toggles', () => {
    expect(adjust(snap(), 'anchors', 1)).toEqual({ anchorsEnabled: false })
    expect(adjust(snap({ anchorsEnabled: false }), 'anchors', 1)).toEqual({ anchorsEnabled: true })
    expect(adjust(snap(), 'music', 1)).toEqual({ musicEnabled: false })
    expect(adjust(snap(), 'pet', 1)).toEqual({ tuiPet: false })
  })

  it('the sound toggle flips the mute boolean', () => {
    expect(adjust(snap(), 'voice', 1)).toEqual({ muted: true })
    expect(adjust(snap({ muted: true }), 'voice', 1)).toEqual({ muted: false })
  })

  it('walks the gear presets without wrapping, writing both underlying knobs', () => {
    expect(adjust(snap(), 'gear', -1)).toEqual({ cadenceMode: 'every_n', musicEveryN: 1 })
    expect(adjust(snap(), 'gear', 1)).toEqual({ cadenceMode: 'every_n', musicEveryN: 4 })
    expect(adjust(snap({ musicEveryN: 1 }), 'gear', -1)).toBeNull() // already at the end
    expect(adjust(snap({ musicEveryN: 4 }), 'gear', 1)).toBeNull()
  })

  it('any gear press from custom lands on balanced (selecting overwrites)', () => {
    expect(adjust(snap({ cadenceMode: 'random' }), 'gear', 1)).toEqual({
      cadenceMode: 'every_n',
      musicEveryN: 2,
    })
  })

  it('steps the numbers within the pane ranges and stops at the bounds', () => {
    expect(adjust(snap(), 'gap', 1)).toEqual({ gapSeconds: 2.5 })
    expect(adjust(snap({ gapSeconds: 0 }), 'gap', -1)).toBeNull()
    expect(adjust(snap({ gapSeconds: 10 }), 'gap', 1)).toBeNull()
    expect(adjust(snap(), 'window', 1)).toEqual({ recentWindow: 14 })
    expect(adjust(snap({ recentWindow: 4 }), 'window', -1)).toBeNull()
    expect(adjust(snap({ recentWindow: 48 }), 'window', 1)).toBeNull()
  })

  it('clamps an off-grid hand-edited value back onto the range', () => {
    expect(adjust(snap({ gapSeconds: 9.8 }), 'gap', 1)).toEqual({ gapSeconds: 10 })
    expect(adjust(snap({ recentWindow: 47 }), 'window', 1)).toEqual({ recentWindow: 48 })
  })

  it('a greyed item adjusts to nothing', () => {
    expect(adjust(snap({ musicEnabled: false }), 'gear', 1)).toBeNull()
    expect(adjust(snap({}, { musicAvailable: false }), 'music', 1)).toBeNull()
  })
})

describe('paneFacts', () => {
  it('shows the home and the endpoint status — a fact, never the endpoint', () => {
    const facts = paneFacts(snap()).map((f) => `${f.label}: ${f.value}`)
    expect(facts.some((f) => f.includes('/home/me/.murmur'))).toBe(true)
    expect(facts.join(' ')).toContain('configured')
    const bare = paneFacts(snap({}, { voiceConfigured: false }))
    expect(bare.map((f) => f.value).join(' ')).toContain('not configured')
  })
})

// spec 12 §3.9: the one item a keypress cannot step through, because a language
// is free text. It reads its value honestly (the persona's own word when the
// listener never set an override) and edits by typing, not by arrowing.
describe('the language item (spec 12 §3.9)', () => {
  const item = (values: Partial<Settings> = {}) =>
    paneItems(snap(values)).find((i) => i.key === 'language')!

  it("says whose word it is when there is no override", () => {
    expect(item().value).toMatch(/persona/i)
    expect(item({ language: 'Japanese' }).value).toBe('Japanese')
  })

  it('is an edit, not a stepper — arrowing it changes nothing', () => {
    expect(adjust(snap(), 'language', 1)).toBeNull()
    expect(adjust(snap({ language: 'Japanese' }), 'language', -1)).toBeNull()
  })

  it('turns typed text into a patch, and empty into a clear', () => {
    expect(languagePatch('  Japanese  ')).toEqual({ language: 'Japanese' })
    expect(languagePatch('')).toEqual({ language: '' })
    expect(languagePatch('   ')).toEqual({ language: '' })
  })

  it('refuses text the engine would reject anyway, rather than sending it', () => {
    expect(languagePatch('x'.repeat(LANGUAGE_MAX + 1))).toBeNull()
  })
})
