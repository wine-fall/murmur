// The /update command's own logic (spec 10 §3.2-C): what murmur says and does
// between "the listener typed it" and "npm ran". Every boundary — the registry,
// the installer, where this run came from — is injected, so a test can never
// reach the network or write to the machine's global node_modules.
import { describe, expect, it } from 'vitest'

import {
  INSTALL_COMMAND,
  installCommandFor,
  isUnderGlobalRoot,
  isNewer,
  runUpdate,
  type UpdateDeps,
} from '../src/support/update.ts'

function build(over: Partial<UpdateDeps> = {}) {
  const infos: string[] = []
  let installs = 0
  const deps: UpdateDeps = {
    current: '0.2.0',
    latest: () => Promise.resolve('0.2.0'),
    install: () => {
      installs++
      return Promise.resolve(true)
    },
    isGlobal: () => true,
    info: (text) => void infos.push(text),
    ...over,
  }
  return { deps, infos, installed: () => installs }
}

describe('isNewer', () => {
  it('compares the dotted numbers, not the strings', () => {
    expect(isNewer('0.2.1', '0.2.0')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true) // string order would say no
    expect(isNewer('1.0.0', '0.99.0')).toBe(true)
  })

  it('is false for the same version and for anything older', () => {
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
  })

  it('treats a missing tail as zero, so 0.2 and 0.2.0 are the same version', () => {
    expect(isNewer('0.2', '0.2.0')).toBe(false)
    expect(isNewer('0.2.0', '0.2')).toBe(false)
  })

  // codex review: the version this run reports may carry a prerelease tag, and
  // '0.3.0-beta.1' is OLDER than the '0.3.0' the registry publishes.
  it('reads a stable release as newer than the prerelease that led to it', () => {
    expect(isNewer('0.3.0', '0.3.0-beta.1')).toBe(true)
    expect(isNewer('0.3.0', '0.3.0-rc.2')).toBe(true)
    expect(isNewer('0.2.9', '0.3.0-beta.1')).toBe(false)
  })

  it('never reads an unreadable manifest as newer than the registry', () => {
    // packageVersion() answers 'unknown' when it cannot read the manifest: the
    // published version is then the better bet, not a downgrade.
    expect(isNewer('0.2.0', 'unknown')).toBe(true)
  })
})

describe('runUpdate', () => {
  it('says so and installs nothing when the run is already current', async () => {
    const { deps, infos, installed } = build()
    await runUpdate(deps)
    expect(installed()).toBe(0)
    expect(infos.join(' ')).toContain('0.2.0')
    expect(infos).toHaveLength(1)
  })

  it('installs the newer version and asks for a restart', async () => {
    const { deps, infos, installed } = build({ latest: () => Promise.resolve('0.3.0') })
    await runUpdate(deps)
    expect(installed()).toBe(1)
    // The listener hears it start (npm is slow) and hears how it ended.
    expect(infos[0]).toContain('0.3.0')
    expect(infos.at(-1)).toContain('restart')
  })

  it('leaves a checkout alone — it names the newer version and stops there', async () => {
    // A dev run is updated with git, and an `npm i -g` from one would install a
    // murmur this process is not even running.
    const { deps, infos, installed } = build({
      latest: () => Promise.resolve('0.3.0'),
      isGlobal: () => false,
    })
    await runUpdate(deps)
    expect(installed()).toBe(0)
    expect(infos.join(' ')).toContain('0.3.0')
    expect(infos.join(' ')).not.toContain('restart')
  })

  it('hands over the command when the registry is unreachable', async () => {
    const { deps, infos, installed } = build({ latest: () => Promise.reject(new Error('offline')) })
    await runUpdate(deps)
    expect(installed()).toBe(0)
    expect(infos.join(' ')).toContain(INSTALL_COMMAND)
  })

  it('hands over the command when npm fails, rather than claiming an update', async () => {
    const { deps, infos } = build({
      latest: () => Promise.resolve('0.3.0'),
      install: () => Promise.resolve(false),
    })
    await runUpdate(deps)
    expect(infos.at(-1)).toContain(INSTALL_COMMAND)
    expect(infos.at(-1)).not.toContain('restart')
  })

  it('never rejects — a thrown installer degrades to the manual command', async () => {
    // This runs beside the program on nobody's await: a rejection here would be
    // an unhandled one.
    const { deps, infos } = build({
      latest: () => Promise.resolve('0.3.0'),
      install: () => Promise.reject(new Error('npm exploded')),
    })
    await expect(runUpdate(deps)).resolves.toBeUndefined()
    expect(infos.at(-1)).toContain(INSTALL_COMMAND)
  })
})

// codex review: `npm i -g` only updates the murmur this run IS when this run is
// the global install. An npx cache and a project-local dependency both live in
// a `node_modules/murmur-radio/` too, and updating from one installs a copy the
// listener is not running while the message claims a restart would help.
describe('isUnderGlobalRoot', () => {
  const node = '/opt/homebrew/bin/node'
  const global = '/opt/homebrew/lib/node_modules/murmur-radio/dist/'

  it("is true for the package under the running node's global root", () => {
    expect(isUnderGlobalRoot(global, node, 'darwin')).toBe(true)
  })

  it('is false for an npx cache, a project-local dependency, and a checkout', () => {
    const npx = '/Users/x/.npm/_npx/1a2b3c/node_modules/murmur-radio/dist/'
    const local = '/Users/x/code/app/node_modules/murmur-radio/dist/'
    const checkout = '/Users/x/code/murmur/src/'
    expect(isUnderGlobalRoot(npx, node, 'darwin')).toBe(false)
    expect(isUnderGlobalRoot(local, node, 'darwin')).toBe(false)
    expect(isUnderGlobalRoot(checkout, node, 'darwin')).toBe(false)
  })

  it("is false under another node's global root — that murmur is not this run", () => {
    expect(isUnderGlobalRoot(global, '/Users/x/.nvm/versions/node/v24.0.0/bin/node', 'darwin')).toBe(false)
  })

  it('knows the Windows global layout, which sits beside node with no lib/ hop', () => {
    const npm = 'C:\\Users\\x\\AppData\\Roaming\\npm'
    expect(isUnderGlobalRoot(`${npm}\\node_modules\\murmur-radio\\dist\\`, `${npm}\\node.exe`, 'win32')).toBe(
      true,
    )
    expect(isUnderGlobalRoot('C:\\code\\app\\node_modules\\murmur-radio\\', `${npm}\\node.exe`, 'win32')).toBe(
      false,
    )
  })
})

describe('installCommandFor', () => {
  it('runs npm directly off win32', () => {
    expect(installCommandFor('darwin')).toEqual({
      command: 'npm',
      args: ['install', '-g', 'murmur-radio@latest'],
    })
  })

  // codex review: npm on Windows is `npm.cmd`, a shell script — spawned without
  // a shell, a bare `npm` is ENOENT and every /update degrades to the manual
  // command. Same fix the desktop opener already carries for `start`.
  it('goes through cmd on win32, where npm is a .cmd shim', () => {
    expect(installCommandFor('win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'npm', 'install', '-g', 'murmur-radio@latest'],
    })
  })
})
