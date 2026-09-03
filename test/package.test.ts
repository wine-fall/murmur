// The npm-install contract: `npm i -g murmur-radio` must yield a working
// `murmur` command. Node refuses to type-strip anything under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the tarball carries a
// compiled dist/ built by prepack — while dev keeps running src/ directly.
// These pin the manifest invariants that `npm pack` itself does not check.

import { spawnSync } from 'node:child_process'
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

// spec 05-01 §3.4: node:sqlite is behind Node's experimental flag and warns on
// load. The listener did not choose SQLite and cannot act on it, so that one
// warning must not reach the terminal a real run prints to.
describe('the engine starts without an experimental warning', () => {
  // Two halves, and each pins a different one. This one pins that nothing in
  // main.ts's import graph loads node:sqlite STATICALLY — a static import warns
  // when the builtin links, which is before any filter a module could install.
  it('never links node:sqlite just by starting up', () => {
    const run = spawnSync(process.execPath, [join(root, 'src/main.ts'), '--version'], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stderr).not.toContain('ExperimentalWarning')
  })

  // And this one pins that the filter actually silences the warning when the
  // module IS loaded — which is what a run that reaches recall does.
  it('silences the warning when recall loads node:sqlite', () => {
    const script =
      "import './src/warnings.ts'\nconst { RecallIndex } = await import('./src/recall.ts')\n" +
      "new RecallIndex(':memory:').rebuild([{ ts: 1, role: 'user', text: 'a lantern' }])\n"
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')

    // Without the filter the same run is noisy — so the assertion above is not
    // passing for some other reason.
    const bare = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script.split('\n').slice(1).join('\n')],
      { cwd: root, encoding: 'utf8' },
    )
    expect(bare.stderr).toContain('ExperimentalWarning')
  })

  it('still lets every other warning through', () => {
    const script =
      "import './src/warnings.ts'\nprocess.emitWarning('a real warning')\n" +
      "process.emitWarning('another experiment', 'ExperimentalWarning')\n"
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(run.stderr).toContain('a real warning')
    expect(run.stderr).toContain('another experiment')
  })
})
