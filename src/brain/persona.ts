// Static persona loader (spec 01 §3.1). A missing or empty persona seed is a
// startup error, not a silent empty prompt.

import { readFileSync } from 'node:fs'

// The short label that stands for the persona wherever there is room for one:
// the plain host's banner, and the TUI's status strip (spec 10 §3.2-D). The
// seed is a markdown document whose heading is exactly this name, dressed up
// with authoring detail ("# murmur - persona seed (L0 static)") that belongs to
// the file, not to the host. Take the name, drop the file's business, and keep
// it short enough to sit in a strip beside the scene and the presence state.
const LABEL_MAX = 48

export function personaLine(persona: string): string {
  const first = persona.split('\n').find((line) => line.trim() !== '')
  if (first === undefined) return '(empty)'
  const label = first
    .trim()
    .replace(/^#+\s*/, '')
    .split(/\s+[-\u2014\u2013]\s+|\s*[(\uFF08]/)[0]!
    .trim()
  if (label === '') return '(empty)'
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1).trimEnd()}\u2026` : label
}

// The bundled seed names no language of its own (spec 06 §3.2): it carries this
// slot, filled with the language decided for the install. A generated or
// hand-written persona states its language outright and has no slot, so filling
// one is a no-op there.
const LANGUAGE_SLOT = /\{\{language\}\}/g

export function renderPersona(text: string, language: string): string {
  return text.replace(LANGUAGE_SLOT, language)
}

export function loadPersona(path: string, language: string): string {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    throw new Error(`persona seed file not found: ${path}`)
  }
  const text = raw.trim()
  if (!text) throw new Error(`persona seed file is empty: ${path}`)
  return renderPersona(text, language)
}

// The language the persona says it speaks (spec 13 §3.5). Once past the first
// run the persona is the record — the machine locale that seeded it may have
// changed since — and it states its language in a sentence, not a field:
// "Always speak in Chinese (Mandarin)." / "Speak in Japanese, softly." The
// first such clause, up to the sentence's end. A language is a proper noun,
// so the capture must open with a capital: "speak in a warm tone" is manner,
// not language. Undefined when the persona never says — a generated persona
// is written in the listener's language and does not name it in English.
const SPEAKS_IN = /\b[Ss]peak(?:s|ing)? in ([A-Z][^.,;\n*]*)/

export function personaLanguage(persona: string): string | undefined {
  const name = SPEAKS_IN.exec(persona)?.[1]?.trim()
  return name ? name : undefined
}
