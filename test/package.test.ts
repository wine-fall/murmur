// The npm-install contract: `npm i -g murmur-radio` must yield a working
// `murmur` command. Node refuses to type-strip anything under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the tarball carries a
// compiled dist/ built by prepack — while dev keeps running src/ directly.
// These pin the manifest invariants that `npm pack` itself does not check.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name?: string
  private?: boolean
  bin?: Record<string, string>
  files?: string[]
  engines?: Record<string, string>
  license?: string
  scripts?: Record<string, string>
}

describe('package manifest (the npm-install contract)', () => {
  it('is publishable under a free name', () => {
    // Bare "murmur" is taken on the registry (a murmur3 hashing lib).
    expect(pkg.name).toBe('murmur-radio')
    expect(pkg.private).toBeUndefined()
    expect(pkg.license).toBeDefined()
  })

  it('exposes the murmur command as a built entry prepack produces', () => {
    // The shebang lives in src/main.ts; tsc carries it into dist/main.js.
    expect(pkg.bin?.murmur).toBe('dist/main.js')
    expect(readFileSync(join(root, 'src/main.ts'), 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
    // prepack must build dist AND ship the .md prompt tsc will not copy.
    expect(pkg.scripts?.prepack).toContain('tsconfig.build.json')
    expect(pkg.scripts?.prepack).toContain('persona-seed.md')
  })

  it('whitelists only what the runtime needs, and every entry exists', () => {
    expect(pkg.files).toBeDefined()
    // dist/ exists only after prepack; everything else must exist now.
    for (const entry of pkg.files!.filter((f) => f !== 'dist'))
      expect(existsSync(join(root, entry)), entry).toBe(true)
    // The dev-only trees must stay out of the tarball — src included: the
    // runtime is dist/, and shipping src would tempt a node_modules TS run.
    for (const banned of ['specs', 'scratch', 'test', 'scripts', '.dev', 'src'])
      expect(pkg.files).not.toContain(banned)
    // The runtime's three resource roots must be in.
    for (const needed of ['dist', 'assets', 'tui/src']) expect(pkg.files).toContain(needed)
  })

  it('declares the Node floor native type-stripping needs', () => {
    expect(pkg.engines?.node).toBe('>=24')
  })
})
