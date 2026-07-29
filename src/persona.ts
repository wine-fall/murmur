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

export function loadPersona(path: string): string {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    throw new Error(`persona seed file not found: ${path}`)
  }
  const text = raw.trim()
  if (!text) throw new Error(`persona seed file is empty: ${path}`)
  return text
}
