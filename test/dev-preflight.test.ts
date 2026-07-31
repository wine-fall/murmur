import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'dev-preflight.ts')

// A sanitized PATH holding only node's own directory: yt-dlp, ffmpeg and bun
// are then deterministically absent, whatever the developer's machine has.
const BARE_PATH = dirname(process.execPath)

type Run = { code: number; stdout: string }

async function preflight(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, ...args], {
      env: { PATH: BARE_PATH, ...env },
    })
    return { code: 0, stdout }
  } catch (err) {
    const failure = err as { code?: number; stdout?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '' }
  }
}

// spec 03-03 §7.1 point 1: the shell preflight is a REPORTER. Every gap it can
// name is one the app itself now repairs by conversation, so nothing it finds
// may stop `make dev` from reaching src/main.ts. Only a missing node blocks —
// and that one is enforced by the shell, which cannot run this script at all
// without it (§7.3 criterion 8).
describe('dev-preflight (reporter, not gatekeeper)', () => {
  it('reports a missing voice endpoint and still exits 0', async () => {
    const { code, stdout } = await preflight(['--no-music', '--voice', 'hosted'])
    expect(code).toBe(0)
    expect(stdout).toContain('voice')
    // It must point at the conversation, not at a shell fix the user would
    // otherwise go hunting for.
    expect(stdout.toLowerCase()).toContain('murmur')
  })

  it('reports missing bun for the default TUI front-end and still exits 0', async () => {
    const { code, stdout } = await preflight(['--no-music', '--voice', 'stub'])
    expect(code).toBe(0)
    expect(stdout).toContain('bun')
  })

  it('--plain has no bun to want', async () => {
    const { stdout } = await preflight(['--no-music', '--voice', 'stub', '--plain'])
    expect(stdout).not.toContain('bun')
  })

  it('a fully satisfied run says so and exits 0', async () => {
    const { code, stdout } = await preflight(['--no-music', '--voice', 'stub', '--plain'])
    expect(code).toBe(0)
    expect(stdout).toContain('preflight')
  })

  it('never exits non-zero, whatever is missing', async () => {
    // The whole point of the demotion: the radio always launches degraded, so
    // there is no combination of absent dependencies that blocks the shell.
    const { code } = await preflight(['--no-music', '--voice', 'hosted'], { MURMUR_TTS_URL: '' })
    expect(code).toBe(0)
  })
})
