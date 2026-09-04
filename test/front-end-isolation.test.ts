// spec 10 §5.9 (hard acceptance): `frontEnd: 'plain'` costs nothing. The engine
// and the fast test layer must carry no TUI dependency at all — not a package,
// not an import. The TUI client is a sibling process with its own manifest, and
// the ONLY thing crossing the line is src/host/ipc.ts, in the client's direction.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

const engineSources = readdirSync(join(ROOT, 'src'), { recursive: true })
  .map(String)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(join(ROOT, 'src', name), 'utf-8') }))

describe('the engine carries no TUI dependency', () => {
  it('no engine module imports the front-end or its framework', () => {
    const offenders = engineSources
      .filter(({ text }) => /from '(@opentui\/|\.\.\/tui\/)/.test(text))
      .map(({ name }) => name)
    expect(offenders).toEqual([])
  })

  it('the engine manifest never grows an OpenTUI or React dependency', () => {
    const manifest = readFileSync(join(ROOT, 'package.json'), 'utf-8')
    expect(manifest).not.toMatch(/@opentui|"react"/)
  })

  it('the client depends on the engine only for the wire schemas', () => {
    const client = readdirSync(join(ROOT, 'tui', 'src'))
      .map((name) => readFileSync(join(ROOT, 'tui', 'src', name), 'utf-8'))
      .join('\n')
    const reachIns = [...client.matchAll(/from '\.\.\/\.\.\/src\/([\w./-]+)'/g)].map((m) => m[1])
    expect([...new Set(reachIns)]).toEqual(['host/ipc.ts'])
  })
})
