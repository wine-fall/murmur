// The host's default output language (spec 06 §3.2). Nothing in the source
// picks a language: the default follows the machine the listener is on, and
// English is the floor when it says nothing.
//
// Read ONCE, at boot, and threaded into the first run. There is no watcher —
// the persona written at onboarding is the standing authority afterwards, and
// murmur never rewrites it (spec 06 §2.2).

export const DEFAULT_LANGUAGE = 'English'

// POSIX precedence for the message locale: LC_ALL overrides the category,
// which overrides LANG.
const LOCALE_ENV = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const

// The two locales that mean "no locale" rather than a language.
const NEUTRAL = new Set(['C', 'POSIX'])

// glibc spells a script choice as a locale modifier, and dropping it seeds the
// wrong writing system — the same harm as zh_TW collapsing into zh_CN. Only
// the modifiers that name a script belong here; the rest (@euro, @valencia)
// say nothing about how the language is written.
const SCRIPT_MODIFIER: Record<string, string> = {
  latin: 'Latn',
  cyrillic: 'Cyrl',
  devanagari: 'Deva',
}

// The region a POSIX locale carries is noise in a persona line ("Japanese
// (Japan)"), but the SCRIPT it implies is not: zh_TW and zh_CN differ in a way
// the host must honour. So name the language, and reach for the script only
// where it departs from that language's own default — which is exactly the
// Traditional/Simplified split and nothing else.
function nameFor(names: Intl.DisplayNames, tag: string, chosenScript?: string): string | undefined {
  const locale = new Intl.Locale(tag)
  const plain = names.of(locale.language)
  // An unnameable language comes back as the subtag itself.
  if (plain === undefined || plain === locale.language) return undefined
  const script = chosenScript ?? locale.maximize().script
  const usual = new Intl.Locale(locale.language).maximize().script
  if (script === undefined || script === usual) return plain
  return names.of(`${locale.language}-${script}`) ?? plain
}

export function detectLanguage(env: NodeJS.ProcessEnv = process.env): string {
  const names = new Intl.DisplayNames(['en'], { type: 'language' })
  for (const key of LOCALE_ENV) {
    const raw = env[key]?.trim()
    // Unset or empty is not an answer; anything else IS one, and under POSIX
    // it overrides every variable below it — including when it says "C".
    if (raw === undefined || raw === '') continue
    // "sr_RS.UTF-8@latin" -> tag "sr-RS", modifier "latin"
    const [head = '', modifier] = raw.split('@')
    const tag = head.split('.')[0]!.replace('_', '-')
    if (tag === '' || NEUTRAL.has(tag)) return DEFAULT_LANGUAGE
    try {
      return nameFor(names, tag, modifier === undefined ? undefined : SCRIPT_MODIFIER[modifier])
        ?? DEFAULT_LANGUAGE
    } catch {
      return DEFAULT_LANGUAGE // not a well-formed tag
    }
  }
  return DEFAULT_LANGUAGE
}
