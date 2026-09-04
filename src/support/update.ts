// The /update command (spec 10 §3.2-C): a listener who installed murmur from
// npm has no way to learn a newer one exists short of visiting the registry, so
// the radio checks for them and installs on request.
//
// Everything that touches the world — the registry, npm, where this run came
// from — is a function on UpdateDeps, wired once in app.ts. runUpdate itself
// only decides and narrates, and it NEVER rejects: it runs beside the program
// on nobody's await, so a thrown installer would be an unhandled rejection
// rather than a lost segment.

import { spawn } from 'node:child_process'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

const PACKAGE = 'murmur-radio'

// The one command a listener may have to run themselves — every degraded path
// ends by handing it over, so it is written once.
export const INSTALL_COMMAND = `npm install -g ${PACKAGE}@latest`

// Long enough for a slow network, short enough that a listener who typed a
// command is not left wondering (the program keeps playing either way).
const REGISTRY_TIMEOUT_MS = 8_000

// Newer by the dotted numbers, not by string order — '0.10.0' sorts before
// '0.9.9' as text. A missing tail is zero, so '0.2' and '0.2.0' are one
// version, and a non-numeric part (packageVersion()'s 'unknown') reads as zero,
// which only ever makes us offer the published one. A prerelease suffix is cut
// before the compare and settles an otherwise equal pair: by semver precedence
// '0.3.0' is the release '0.3.0-beta.1' was heading for, and so is newer.
export function isNewer(latest: string, current: string): boolean {
  const parts = (version: string): number[] =>
    version.split('-')[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(latest), parts(current)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    if (delta !== 0) return delta > 0
  }
  return !latest.includes('-') && current.includes('-')
}

// The registry's own dist-tag endpoint: one small document, no npm process to
// spawn and no auth. A non-2xx or a malformed body throws, and the caller
// degrades to the manual command.
export async function latestVersion(): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`registry answered ${response.status}`)
  return z.object({ version: z.string() }).parse(await response.json()).version
}

// How to run npm on this platform. Windows exposes it as `npm.cmd`, a shell
// script rather than an executable, so a shell-less spawn of a bare `npm` is
// ENOENT there and every /update would degrade to the manual command — the same
// hop the desktop opener already makes for `start`.
export function installCommandFor(platform: NodeJS.Platform): { command: string; args: string[] } {
  const args = ['install', '-g', `${PACKAGE}@latest`]
  return platform === 'win32' ? { command: 'cmd', args: ['/c', 'npm', ...args] } : { command: 'npm', args }
}

// npm's output is swallowed rather than inherited: the TUI owns that terminal
// and a progress bar drawn over it would corrupt the frame. The exit code is
// the whole result; a listener who wants the reason runs INSTALL_COMMAND.
export function installLatest(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return new Promise((resolve) => {
    const { command, args } = installCommandFor(platform)
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', () => resolve(false)) // no npm on PATH is a failure, not a crash
    child.on('close', (code) => resolve(code === 0))
  })
}

// Would `npm i -g` update the murmur this process is actually running? Only if
// this code lives under the global root of the node running it — npm's own
// prefix rule: `<prefix>/lib/node_modules` off win32, beside node itself on it.
// A `node_modules/murmur-radio/` match alone is not enough (codex review): an
// npx cache and a project-local dependency both look like that, and updating
// from one installs a copy the listener is not running.
export function isUnderGlobalRoot(
  moduleDir: string,
  execPath: string,
  platform: NodeJS.Platform,
): boolean {
  // One separator for the compare, so a Windows path is the same shape as the
  // posix ones; Windows paths are also case-insensitive.
  const slashed = (path: string): string => path.replace(/\\/g, '/')
  const bin = posix.dirname(slashed(execPath))
  const root = platform === 'win32' ? bin : posix.dirname(bin) + '/lib'
  const home = `${root}/node_modules/${PACKAGE}/`
  const dir = slashed(moduleDir)
  return platform === 'win32'
    ? dir.toLowerCase().startsWith(home.toLowerCase())
    : dir.startsWith(home)
}

export function isGlobalInstall(): boolean {
  return isUnderGlobalRoot(
    fileURLToPath(new URL('.', import.meta.url)),
    process.execPath,
    process.platform,
  )
}

export type UpdateDeps = {
  current: string
  latest: () => Promise<string>
  install: () => Promise<boolean>
  isGlobal: () => boolean
  info: (text: string) => void
}

export async function runUpdate(deps: UpdateDeps): Promise<void> {
  let latest: string
  try {
    latest = await deps.latest()
  } catch {
    deps.info(`could not reach npm just now — try \`${INSTALL_COMMAND}\` yourself.`)
    return
  }
  if (!isNewer(latest, deps.current)) {
    deps.info(`already the latest murmur (${deps.current}).`)
    return
  }
  if (!deps.isGlobal()) {
    // A checkout updates with git; an npx run or a project-local dependency is
    // updated by whatever installed it. All three share the one true statement:
    // an `npm i -g` from here would not be the murmur they are running.
    deps.info(
      `murmur ${latest} is out — this run is ${deps.current}, and it is not the npm install, so update it where it came from.`,
    )
    return
  }
  deps.info(`murmur ${latest} is out — updating from ${deps.current}...`)
  let ok = false
  try {
    ok = await deps.install()
  } catch {
    ok = false
  }
  deps.info(
    ok
      ? `updated to ${latest} — restart murmur to pick it up.`
      : `the update did not go through — run \`${INSTALL_COMMAND}\` to see why.`,
  )
}
