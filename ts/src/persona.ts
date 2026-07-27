// Static persona loader (spec 01 §3.1). A missing or empty persona seed is a
// startup error, not a silent empty prompt.

import { readFileSync } from 'node:fs'

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
