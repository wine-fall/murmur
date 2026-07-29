// Enforce the v1 source-language policy (DESIGN §0).
//
// Two checks:
//
// 1. No Chinese (CJK) anywhere — comments, string literals, docs alike. v1
//    sources contain no Chinese. The radio speaks Chinese only at runtime, from
//    the model (the persona prompt sets the output language); it is never a
//    hardcoded string. This applies to every file type.
//
// 2. Comments are English-only — a comment may hold ASCII plus a small
//    allowlist of typographic punctuation (em/en dashes, ellipsis, curly
//    quotes, the section sign used for spec refs like "§3.1"). Anything else
//    fails. (CJK in a comment is already caught by check 1; this additionally
//    bars other non-English scripts from comments.) TypeScript only — it needs
//    to know where the comments are.
//
//   node scripts/check-source-language.ts [FILE ...]
//
// With no arguments, scans src/, test/, scripts/, and .github/scripts/. Exits
// non-zero on any violation, so it works as a pre-commit hook and in CI.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Typographic punctuation acceptable in otherwise-English comments: dashes,
// ellipsis, curly quotes, the section sign used for spec refs like "§3.1", the
// arrow used for "X -> Y" prose, and the circled digits spec 05 names its
// memory tiers with. Symbols, not another writing system — which is what the
// English-only rule is actually about.
const ALLOWED_NON_ASCII = new Set('—–…“”‘’§→①②③')

function isCjk(ch: string): boolean {
  const o = ch.codePointAt(0) ?? 0
  return (
    (o >= 0x3000 && o <= 0x303f) || // CJK symbols and punctuation
    (o >= 0x3040 && o <= 0x30ff) || // Hiragana + Katakana
    (o >= 0x3400 && o <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (o >= 0x4e00 && o <= 0x9fff) || // CJK Unified Ideographs
    (o >= 0xac00 && o <= 0xd7af) || // Hangul syllables
    (o >= 0xf900 && o <= 0xfaff) || // CJK compatibility ideographs
    (o >= 0xff00 && o <= 0xffef) // halfwidth and fullwidth forms
  )
}

function sortedUnique(chars: string[]): string[] {
  return [...new Set(chars)].sort()
}

function checkNoCjk(path: string, text: string): string[] {
  const errors: string[] = []
  text.split('\n').forEach((line, index) => {
    const found = sortedUnique([...line].filter(isCjk))
    if (found.length > 0) {
      errors.push(`${path}:${index + 1}: Chinese/CJK not allowed in v1 sources: ${found.join(' ')}`)
    }
  })
  return errors
}

export type TsComment = { line: number; text: string }

// Comments in TypeScript source, with the 1-based line each one starts on.
// A hand-rolled scanner rather than a parser: it tracks string and template
// literals so a `//` inside one is not read as a comment.
// ponytail: regex literals are not tracked — a `/…\/\/…/` literal could be
// misread as a comment start. Teach it regex state if that ever fires.
export function tsComments(source: string): TsComment[] {
  const comments: TsComment[] = []
  let line = 1
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '\n') {
      line += 1
      i += 1
    } else if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      comments.push({ line, text: source.slice(i, stop) })
      i = stop
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      const text = source.slice(i, stop)
      comments.push({ line, text })
      line += (text.match(/\n/g) ?? []).length
      i = stop
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i += 1
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i += 1
        else if (source[i] === '\n') line += 1
        i += 1
      }
      i += 1
    } else {
      i += 1
    }
  }
  return comments
}

function checkCommentsEnglish(path: string, source: string): string[] {
  const errors: string[] = []
  for (const comment of tsComments(source)) {
    comment.text.split('\n').forEach((text, offset) => {
      const bad = sortedUnique(
        [...text].filter((ch) => ch.codePointAt(0)! >= 128 && !ALLOWED_NON_ASCII.has(ch) && !isCjk(ch)),
      )
      if (bad.length > 0) {
        errors.push(`${path}:${comment.line + offset}: non-English character(s) in comment: ${bad.join(' ')}`)
      }
    })
  }
  return errors
}

export function checkText(path: string, text: string): string[] {
  const errors = checkNoCjk(path, text)
  if (path.endsWith('.ts')) errors.push(...checkCommentsEnglish(path, text))
  return errors
}

function collect(argv: string[]): string[] {
  if (argv.length > 0) return argv
  const roots = ['src', 'test', 'scripts', '.github/scripts']
  return roots.flatMap((root) => {
    let entries: string[]
    try {
      entries = readdirSync(root, { recursive: true, encoding: 'utf8' })
    } catch {
      return []
    }
    return entries.filter((entry) => entry.endsWith('.ts')).map((entry) => join(root, entry))
  })
}

function main(argv: string[]): number {
  const paths = collect(argv)
  const errors: string[] = []
  for (const path of paths) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue // a path passed but gone (a staged deletion) is not a violation
    }
    errors.push(...checkText(path, text))
  }
  if (errors.length > 0) {
    console.log('Source-language check FAILED:')
    for (const error of errors) console.log(`  ${error}`)
    return 1
  }
  console.log(`Source-language check passed (${paths.length} file(s)).`)
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
