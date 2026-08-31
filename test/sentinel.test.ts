import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseCli } from '../src/config.ts'
import { escalatingSigint, runSetupCli } from '../src/app.ts'
import type { Host } from '../src/host.ts'
import { sentinelRoot } from '../src/paths.ts'
import {
  armSentinel,
  collectCrashed,
  pidAlive,
  uncleanExitNotice,
  type CrashedSession,
} from '../src/sentinel.ts'

const NOW = new Date('2026-08-31T10:00:00Z')

function runDir(): string {
  return mkdtempSync(join(tmpdir(), 'murmur-run-'))
}

// A sentinel left behind by a run that never disarmed.
function leave(dir: string, pid: number, startedAt: string): string {
  const path = join(dir, `session-${String(pid)}.json`)
  writeFileSync(path, JSON.stringify({ pid, startedAt }))
  return path
}

const dead = (): boolean => false
const alive = (): boolean => true

describe('armSentinel', () => {
  it('writes one file per instance, naming the pid and when it started', () => {
    const dir = join(runDir(), 'nested')
    armSentinel(dir, 4321, NOW)
    const path = join(dir, 'session-4321.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      pid: 4321,
      startedAt: '2026-08-31T10:00:00.000Z',
    })
  })

  it('disarms by removing its own file, and does not mind being called twice', () => {
    const dir = runDir()
    const disarm = armSentinel(dir, 4321, NOW)
    disarm()
    disarm()
    expect(existsSync(join(dir, 'session-4321.json'))).toBe(false)
  })

  it('leaves the sentinel of another instance alone when it disarms', () => {
    const dir = runDir()
    leave(dir, 999, NOW.toISOString())
    armSentinel(dir, 4321, NOW)()
    expect(readdirSync(dir)).toEqual(['session-999.json'])
  })
})

describe('collectCrashed', () => {
  it('reports a sentinel whose pid is gone, and clears it so it is reported once', () => {
    const dir = runDir()
    leave(dir, 4321, '2026-08-30T09:00:00.000Z')
    expect(collectCrashed(dir, dead)).toEqual([
      { pid: 4321, startedAt: '2026-08-30T09:00:00.000Z' },
    ])
    expect(readdirSync(dir)).toEqual([])
    expect(collectCrashed(dir, dead)).toEqual([])
  })

  it('ignores a sentinel whose pid is still running — that is another radio', () => {
    const dir = runDir()
    leave(dir, 4321, NOW.toISOString())
    expect(collectCrashed(dir, alive)).toEqual([])
    expect(readdirSync(dir)).toEqual(['session-4321.json'])
  })

  it('reports every stale sentinel in one pass, oldest first', () => {
    const dir = runDir()
    leave(dir, 300, '2026-08-30T09:00:00.000Z')
    leave(dir, 1200, '2026-08-29T09:00:00.000Z')
    leave(dir, 45, '2026-08-31T09:00:00.000Z')
    expect(collectCrashed(dir, dead).map((c: CrashedSession) => c.pid)).toEqual([1200, 300, 45])
    expect(readdirSync(dir)).toEqual([])
  })

  it('sweeps an unreadable sentinel without reporting a crash it cannot prove', () => {
    const dir = runDir()
    writeFileSync(join(dir, 'session-7.json'), 'not json at all')
    writeFileSync(join(dir, 'session-8.json'), JSON.stringify({ pid: 'eight' }))
    expect(collectCrashed(dir, dead)).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('never touches what else lives in run/', () => {
    const dir = runDir()
    writeFileSync(join(dir, 'tui.sock'), '')
    expect(collectCrashed(dir, dead)).toEqual([])
    expect(readdirSync(dir)).toEqual(['tui.sock'])
  })

  it('is empty for a run directory that was never made', () => {
    expect(collectCrashed(join(tmpdir(), 'murmur-no-such-run-1'), dead)).toEqual([])
  })

  // The OS reuses pids. A sentinel carrying OUR number, read before this run
  // has armed anything, is the record of the run that died holding it — and
  // arming would overwrite it, so it has to be reported first.
  it('reports a stale sentinel that happens to carry the pid of this run', () => {
    const dir = runDir()
    leave(dir, 4321, '2026-08-30T09:00:00.000Z')
    expect(collectCrashed(dir, alive, 4321).map((c: CrashedSession) => c.pid)).toEqual([4321])
    expect(readdirSync(dir)).toEqual([])
  })

  // Two radios booting at once must not both announce the same lost run.
  it('claims a stale sentinel so only one of two simultaneous boots reports it', () => {
    const dir = runDir()
    leave(dir, 4321, '2026-08-30T09:00:00.000Z')
    const first = collectCrashed(dir, dead, 100)
    const second = collectCrashed(dir, dead, 200)
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('pidAlive', () => {
  it('calls a pid that answers the probe alive', () => {
    expect(pidAlive(4321, () => {})).toBe(true)
  })

  it('calls a pid the OS does not know dead', () => {
    expect(
      pidAlive(4321, () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }),
    ).toBe(false)
  })

  // Another user's process is one we may not signal — very much alive.
  it('treats EPERM as alive rather than risking a false crash report', () => {
    expect(
      pidAlive(4321, () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }),
    ).toBe(true)
  })

  it('answers alive for a pid that could never be probed safely', () => {
    expect(pidAlive(0, () => {})).toBe(true)
    expect(pidAlive(-1, () => {})).toBe(true)
  })
})

describe('uncleanExitNotice', () => {
  const session = (pid: number): CrashedSession => ({ pid, startedAt: NOW.toISOString() })

  it('says nothing when the last run said goodbye', () => {
    expect(uncleanExitNotice([])).toBeNull()
  })

  it('says one line for one lost run', () => {
    expect(uncleanExitNotice([session(1)])).toContain('without saying goodbye')
  })

  it('folds several lost runs into that same one line', () => {
    const notice = uncleanExitNotice([session(1), session(2)])
    expect(notice).toContain('2')
    expect(notice?.split('\n')).toHaveLength(1)
  })
})

// A forced exit is the listener leaving in a hurry, not a crash: the phase
// still gets to put its sentinel down before the process dies. A run that
// THROWS its way out never reaches any of these seams, which is the point.
describe('escalatingSigint force press', () => {
  const bareHost = (): Host => ({
    start: () => {},
    peekLine: () => new Promise(() => {}),
    takeLine: () => undefined,
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: () => {},
    banner: () => {},
  })

  it('runs the teardown of the phase before it forces the process out', () => {
    const dir = runDir()
    const disarm = armSentinel(dir, 4321, NOW)
    const off = escalatingSigint(bareHost(), () => {}, disarm)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    try {
      process.emit('SIGINT')
      expect(readdirSync(dir)).toEqual(['session-4321.json'])
      process.emit('SIGINT')
      expect(exit).toHaveBeenCalledWith(1)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      exit.mockRestore()
      off()
    }
  })
})

describe('the short-lived entry points', () => {
  // Only a real broadcast arms a sentinel: --setup / --setup-music /
  // --bootstrap-profile come and go constantly, and a sentinel each would have
  // them reporting one another as crashes.
  it('leave no sentinel behind', async () => {
    const home = mkdtempSync(join(tmpdir(), 'murmur-home-'))
    const config = parseCli(['--brain', 'stub'], { MURMUR_HOME: home }).config
    await runSetupCli(config)
    await runSetupCli(config, { musicOnly: true })
    expect(existsSync(sentinelRoot(config.home))).toBe(false)
  })
})
