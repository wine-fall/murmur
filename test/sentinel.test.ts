import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseCli } from '../src/config.ts'
import { escalatingSigint, runSetupCli } from '../src/app.ts'
import { quitLatch } from '../src/guide.ts'
import { LineQueue, type Host } from '../src/host.ts'
import { sentinelRoot } from '../src/paths.ts'
import type { ReportSession } from '../src/report.ts'
import {
  armSentinel,
  collectCrashed,
  crashDescription,
  offerCrashReport,
  pidAlive,
  readCrashWindow,
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

// --- the crash report window --------------------------------------------- //

// Local wall-clock, because that is what devLogMirror stamps and what the daily
// log is named after — building the fixtures this way keeps the tests honest in
// any timezone.
const local = (y: number, m: number, d: number, hh: number, mm: number, ss: number): Date =>
  new Date(y, m - 1, d, hh, mm, ss)

function crashAt(at: Date, pid = 4321): CrashedSession {
  return { pid, startedAt: at.toISOString() }
}

function logDirWith(name: string, lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-crashlog-'))
  writeFileSync(join(dir, name), lines.join('\n') + '\n')
  return dir
}

const DAY = [
  '09:00:00 INFO host: an earlier run, before the one that died',
  '09:00:01 INFO radio: the earlier run talking',
  '22:10:00 INFO host: the run that died starts here',
  '22:10:05 INFO director: talk.refill got=2 depth=2',
  'a bare continuation with no stamp of its own',
  '22:11:30 INFO host: the last thing it ever said',
  '23:00:00 INFO host: this boot, long after',
  '23:00:01 INFO host: and its second line',
]

describe('readCrashWindow', () => {
  const crash = crashAt(local(2026, 8, 30, 22, 10, 0))
  const thisBoot = local(2026, 8, 30, 23, 0, 0)

  it('takes the window of the run that died, not the tail of the log', () => {
    const dir = logDirWith('murmur-2026-08-30.log', DAY)
    const window = readCrashWindow(dir, crash, thisBoot)
    expect(window.lines).toEqual([
      '22:10:00 INFO host: the run that died starts here',
      '22:10:05 INFO director: talk.refill got=2 depth=2',
      'a bare continuation with no stamp of its own',
      '22:11:30 INFO host: the last thing it ever said',
    ])
  })

  it('reports which lines of which file it took', () => {
    const dir = logDirWith('murmur-2026-08-30.log', DAY)
    expect(readCrashWindow(dir, crash, thisBoot).sources).toEqual([
      { path: join(dir, 'murmur-2026-08-30.log'), from: 3, to: 6, count: 4 },
    ])
  })

  it('runs to the end of the day when this boot is on a later one', () => {
    const dir = logDirWith('murmur-2026-08-30.log', DAY)
    const window = readCrashWindow(dir, crash, local(2026, 8, 31, 9, 0, 0))
    expect(window.lines).toHaveLength(6)
    expect(window.lines.at(-1)).toBe('23:00:01 INFO host: and its second line')
  })

  it('keeps the end of a window too long to carry whole', () => {
    const dir = logDirWith('murmur-2026-08-30.log', DAY)
    const window = readCrashWindow(dir, crash, thisBoot, 2)
    expect(window.lines).toEqual([
      'a bare continuation with no stamp of its own',
      '22:11:30 INFO host: the last thing it ever said',
    ])
    expect(window.sources[0]?.from).toBe(5)
  })

  it('is empty when that day has no log at all', () => {
    const dir = logDirWith('murmur-2026-08-29.log', DAY)
    expect(readCrashWindow(dir, crash, thisBoot)).toEqual({ lines: [], sources: [] })
  })

  it('is empty when the run died before it wrote anything', () => {
    const dir = logDirWith('murmur-2026-08-30.log', DAY.slice(0, 2))
    expect(readCrashWindow(dir, crash, thisBoot)).toEqual({ lines: [], sources: [] })
  })
})

describe('crashDescription', () => {
  const crash = crashAt(local(2026, 8, 30, 22, 10, 0))

  it('names the run, when it started, and what it last said', () => {
    const dir = logDirWith('murmur-2026-08-30.log', DAY)
    const said = crashDescription(crash, readCrashWindow(dir, crash, local(2026, 8, 30, 23, 0, 0)))
    expect(said).toContain('pid 4321')
    expect(said).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    expect(said).toContain('22:11:30 INFO host: the last thing it ever said')
  })

  // Honest about what it can prove: a sentinel says the run did not take any of
  // its own exits. It does not say why, because murmur cannot see why.
  it('claims only what the sentinel actually shows', () => {
    const said = crashDescription(crash, { lines: [], sources: [] })
    expect(said).toContain('did not end its last run itself')
    expect(said.toLowerCase()).not.toContain('crashed because')
    expect(said).toContain('cannot')
  })

  it('says so when the run died before it wrote anything', () => {
    const said = crashDescription(crash, { lines: [], sources: [] })
    expect(said).toContain('nothing from that run')
  })
})

// --- the offer ------------------------------------------------------------ //

function offerHost(): {
  host: Host
  said: string[]
  asked: string[]
  type: (line: string) => void
  close: () => void
} {
  const queue = new LineQueue()
  const said: string[] = []
  const asked: string[] = []
  let close!: () => void
  const eof = new Promise<void>((resolve) => (close = resolve))
  const host: Host = {
    start: () => {},
    peekLine: () => queue.peek(),
    takeLine: () => queue.take(),
    eof: () => eof,
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: (m) => void said.push(m),
    ask: (text) => void asked.push(text),
    banner: () => {},
  }
  return { host, said, asked, type: (line) => queue.push(line), close }
}

function fakeSession(): { session: ReportSession; got: string[]; cancelled: () => boolean; finish: () => void } {
  const got: string[] = []
  let cancelled = false
  let finish!: () => void
  const done = new Promise<void>((resolve) => (finish = resolve))
  return {
    session: {
      deliver: (line) => void got.push(line),
      cancel: () => {
        cancelled = true
        finish()
      },
      done,
    },
    got,
    cancelled: () => cancelled,
    finish,
  }
}


describe('offerCrashReport', () => {
  const crashed = [{ pid: 4321, startedAt: local(2026, 8, 30, 22, 10, 0).toISOString() }]

  it('says what it noticed and asks before writing anything', async () => {
    const { host, said, asked } = offerHost()
    let started = false
    await offerCrashReport({
      host,
      crashed,
      read: () => Promise.resolve('n'),
      quit: quitLatch(),
      startSession: () => {
        started = true
        return fakeSession().session
      },
    })
    expect(said[0]).toContain('without saying goodbye')
    expect(asked).toHaveLength(1)
    expect(started).toBe(false)
  })

  // A listener who says no is not asked twice, and never hears about this run
  // again: collectCrashed already cleared the sentinel.
  it('lets a no go without a second word about it', async () => {
    const { host, said } = offerHost()
    await offerCrashReport({
      host,
      crashed,
      read: () => Promise.resolve('no'),
      quit: quitLatch(),
      startSession: () => fakeSession().session,
    })
    expect(said).toHaveLength(2)
    expect(said[1]).toContain('back to the program')
  })

  it('opens the report on a yes and feeds it what the listener types', async () => {
    const { host, type } = offerHost()
    const fake = fakeSession()
    const offer = offerCrashReport({
      host,
      crashed,
      read: () => Promise.resolve('y'),
      quit: quitLatch(),
      startSession: () => fake.session,
    })
    await Promise.resolve()
    type('s')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.got).toEqual(['s'])
    fake.finish()
    await offer
  })

  // The listener is leaving mid-draft: the flow has nobody left to answer it.
  it('ends the report when the listener leaves', async () => {
    const { host } = offerHost()
    const fake = fakeSession()
    const quit = quitLatch()
    const offer = offerCrashReport({
      host,
      crashed,
      read: () => Promise.resolve('y'),
      quit,
      startSession: () => fake.session,
    })
    await Promise.resolve()
    quit.fire()
    await offer
    expect(fake.cancelled()).toBe(true)
  })

  // A /quit typed INTO the draft is the listener leaving, not a menu answer.
  it('takes a typed /quit as leaving rather than feeding it to the draft', async () => {
    const { host, type } = offerHost()
    const fake = fakeSession()
    const quit = quitLatch()
    const offer = offerCrashReport({
      host,
      crashed,
      read: () => Promise.resolve('y'),
      quit,
      startSession: () => fake.session,
    })
    await Promise.resolve()
    type('/quit')
    await offer
    expect(quit.requested).toBe(true)
    expect(fake.got).toEqual([])
    expect(fake.cancelled()).toBe(true)
  })

  // A closed stdin, or a front-end that detached: no line is ever coming, and
  // the boot must not wait out a prompt nobody can answer.
  it('ends the draft on EOF instead of holding the boot open', async () => {
    const { host, close } = offerHost()
    const fake = fakeSession()
    const offer = offerCrashReport({
      host,
      crashed,
      read: () => Promise.resolve('y'),
      quit: quitLatch(),
      startSession: () => fake.session,
    })
    await Promise.resolve()
    close()
    await offer
    expect(fake.cancelled()).toBe(true)
  })

  it('says nothing at all when the last run said goodbye', async () => {
    const { host, said, asked } = offerHost()
    await offerCrashReport({
      host,
      crashed: [],
      read: () => Promise.resolve('y'),
      quit: quitLatch(),
      startSession: () => fakeSession().session,
    })
    expect(said).toEqual([])
    expect(asked).toEqual([])
  })
})
