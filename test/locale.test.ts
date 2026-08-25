import { describe, expect, it } from 'vitest'

import { DEFAULT_LANGUAGE, detectLanguage } from '../src/locale.ts'

// spec 06 §3.2: the host's DEFAULT output language, read once from the machine
// the listener is on. English is the floor, not a preference.
describe('detectLanguage', () => {
  it('falls back to English when the environment says nothing', () => {
    expect(DEFAULT_LANGUAGE).toBe('English')
    expect(detectLanguage({})).toBe('English')
  })

  // The region is noise in a persona line; the script the region implies is
  // not, so zh_TW and zh_CN must not collapse into one another.
  it('names the language of a POSIX locale, dropping the region', () => {
    expect(detectLanguage({ LANG: 'ja_JP.UTF-8' })).toBe('Japanese')
    expect(detectLanguage({ LANG: 'en_US.UTF-8' })).toBe('English')
    expect(detectLanguage({ LANG: 'pt_BR.UTF-8' })).toBe('Portuguese')
  })

  it('keeps the script where it carries the written form', () => {
    expect(detectLanguage({ LANG: 'zh_CN.UTF-8' })).toBe('Chinese')
    expect(detectLanguage({ LANG: 'zh_TW.UTF-8' })).toBe('Traditional Chinese')
    expect(detectLanguage({ LANG: 'zh_HK.UTF-8' })).toBe('Traditional Chinese')
  })

  it('reads a bare BCP-47 tag too', () => {
    expect(detectLanguage({ LANG: 'fr' })).toBe('French')
  })

  it('honours POSIX precedence: LC_ALL over LC_MESSAGES over LANG', () => {
    expect(detectLanguage({ LC_ALL: 'ja_JP.UTF-8', LC_MESSAGES: 'fr_FR', LANG: 'de_DE' })).toBe(
      'Japanese',
    )
    expect(detectLanguage({ LC_MESSAGES: 'fr_FR', LANG: 'de_DE' })).toBe('French')
  })

  // The first variable that is SET is the answer, whatever it says (codex
  // review): a set LC_ALL overrides LANG under POSIX, so falling through to a
  // lower-priority variable would ignore what the listener actually asked for.
  it('lets a neutral locale win when it is the authoritative one', () => {
    expect(detectLanguage({ LC_ALL: 'C', LANG: 'ja_JP.UTF-8' })).toBe('English')
    expect(detectLanguage({ LC_MESSAGES: 'POSIX', LANG: 'fr_FR' })).toBe('English')
    expect(detectLanguage({ LANG: 'POSIX' })).toBe('English')
    // Unset and empty are not "set": they fall through.
    expect(detectLanguage({ LC_ALL: '', LANG: 'fr_FR' })).toBe('French')
  })

  it('degrades to English on a locale it cannot name', () => {
    expect(detectLanguage({ LANG: 'xx_YY.UTF-8' })).toBe('English')
    expect(detectLanguage({ LANG: '@@@' })).toBe('English')
    expect(detectLanguage({ LANG: '   ' })).toBe('English')
  })

  it('drops a modifier that says nothing about the script', () => {
    expect(detectLanguage({ LANG: 'de_DE.UTF-8@euro' })).toBe('German')
  })

  // glibc spells a script choice as a modifier, and it is the same wrong-script
  // harm as zh_TW collapsing into zh_CN (codex review).
  it('keeps the script a modifier selects', () => {
    expect(detectLanguage({ LANG: 'sr_RS.UTF-8@latin' })).toBe('Serbian (Latin)')
    expect(detectLanguage({ LANG: 'uz_UZ.UTF-8@cyrillic' })).toBe('Uzbek (Cyrillic)')
    // Already the language's default script: no need to say it twice.
    expect(detectLanguage({ LANG: 'sr_RS.UTF-8@cyrillic' })).toBe('Serbian')
  })
})
