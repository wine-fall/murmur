import { describe, expect, it } from 'vitest'

import { checkText, tsComments } from '../scripts/check-source-language.ts'

// The samples this suite feeds the checker are escapes, never literal CJK —
// the checker runs over its own test file too, and a literal would fail it.
const IDEOGRAPH = '\u597d'
const FULLWIDTH_STOP = '\u3002'
const KATAKANA = '\u30ab\u30ca'

describe('no-CJK check', () => {
  it('flags CJK on the line that carries it, whatever the file type', () => {
    const errors = checkText('specs/a.md', `fine\nnot ${IDEOGRAPH} fine\n`)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('specs/a.md:2')
    expect(errors[0]).toContain(IDEOGRAPH)
  })

  it('passes ASCII plus the typographic punctuation the policy allows', () => {
    expect(checkText('src/a.ts', '// an em-dash — and an ellipsis … and §3.1\n')).toEqual([])
  })

  it('allows the symbols murmur comments actually use: arrows and tier marks', () => {
    expect(checkText('src/a.ts', '// the tier-③ ledger, read → written\n')).toEqual([])
  })

  it('flags CJK inside a string literal, not just a comment', () => {
    expect(checkText('src/a.ts', `const greeting = '${IDEOGRAPH}'\n`)).toHaveLength(1)
  })

  it('flags fullwidth punctuation and kana', () => {
    expect(checkText('src/a.ts', `// done${FULLWIDTH_STOP}\n`)).toHaveLength(1)
    expect(checkText('src/a.ts', `// ${KATAKANA}\n`)).toHaveLength(1)
  })
})

describe('English-only comments (TypeScript)', () => {
  it('flags a non-English character in a line comment', () => {
    const errors = checkText('src/a.ts', 'const x = 1 // naïve\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('src/a.ts:1')
    expect(errors[0]).toContain('non-English')
    expect(errors[0]).toContain('ï')
  })

  it('flags a block comment and reports the line the character is on', () => {
    const errors = checkText('src/a.ts', '/*\n * café\n */\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('src/a.ts:2')
  })

  it('leaves non-English characters in string literals alone', () => {
    expect(checkText('src/a.ts', "const city = 'Köln'\n")).toEqual([])
    expect(checkText('src/a.ts', 'const city = `Köln`\n')).toEqual([])
  })

  it('does not mistake // inside a string for a comment', () => {
    expect(checkText('src/a.ts', "const url = 'https://köln.example'\n")).toEqual([])
  })

  it('only applies to TypeScript — a Markdown file keeps its accents', () => {
    expect(checkText('README.md', 'Köln is a city.\n')).toEqual([])
  })
})

describe('tsComments', () => {
  it('finds line and block comments with their line numbers', () => {
    const source = ['const a = 1 // first', '/* second', '   still second */', 'const b = 2'].join('\n')
    expect(tsComments(source)).toEqual([
      { line: 1, text: '// first' },
      { line: 2, text: '/* second\n   still second */' },
    ])
  })

  it('ignores comment markers inside strings and template literals', () => {
    expect(tsComments("const a = '// not a comment'")).toEqual([])
    expect(tsComments('const a = `/* not a comment */`')).toEqual([])
    expect(tsComments('const a = "escaped \\" // still a string"')).toEqual([])
  })

  it('treats a comment marker inside a comment as ordinary text', () => {
    expect(tsComments('/* a // b */')).toEqual([{ line: 1, text: '/* a // b */' }])
  })
})
