import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { readLogTail } from '../src/support/diagnostics.ts'
import { prepareDevLog, resolveDevLog, resolveLogSource } from '../src/support/dev-log.ts'
import { readCrashWindow } from '../src/support/sentinel.ts'

// Local midnight-relative, like the sentinel's own tests: the log's stamps are
// clock-only, so a UTC-built date would window the wrong hours.
const local = (y: number, m: number, d: number, hh: number, mm: number, ss: number): Date =>
  new Date(y, m, d, hh, mm, ss)

const NOW = new Date('2026-08-31T09:30:00')

describe('resolveDevLog', () => {
  it('defaults to one file per day under the murmur home', () => {
    const home = mkdtempSync(join(tmpdir(), 'murmur-home-'))
    expect(resolveDevLog({ MURMUR_HOME: home }, NOW)).toBe(
      join(home, 'log', 'murmur-2026-08-31.log'),
    )
  })

  it('lets an explicit MURMUR_DEV_LOG win (make dev keeps .dev/dev.log)', () => {
    const home = mkdtempSync(join(tmpdir(), 'murmur-home-'))
    expect(resolveDevLog({ MURMUR_HOME: home, MURMUR_DEV_LOG: '.dev/dev.log' }, NOW)).toBe(
      '.dev/dev.log',
    )
  })

  it('reads an empty MURMUR_DEV_LOG as an explicit off', () => {
    expect(resolveDevLog({ MURMUR_DEV_LOG: '' }, NOW)).toBe('')
  })

  it('expands a ~ the listener typed (a quoted .env value arrives unexpanded)', () => {
    const path = resolveDevLog({ MURMUR_DEV_LOG: '~/murmur.log' }, NOW)
    expect(path.startsWith('/')).toBe(true)
    expect(path.endsWith('/murmur.log')).toBe(true)
    expect(path.includes('~')).toBe(false)
  })
})

describe('prepareDevLog', () => {
  it('creates the directory the mirror is about to append to', () => {
    const home = mkdtempSync(join(tmpdir(), 'murmur-home-'))
    const path = resolveDevLog({ MURMUR_HOME: home }, NOW)
    prepareDevLog(path, NOW)
    expect(existsSync(join(home, 'log'))).toBe(true)
  })

  it('sweeps daily logs past the retention window, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-log-'))
    const names = [
      'murmur-2026-08-01.log', // 30 days old
      'murmur-2026-08-16.log', // 15 days old
      'murmur-2026-08-17.log', // exactly 14 days old: still inside the window
      'murmur-2026-08-31.log', // today's, about to be written to
      'notes.txt', // not ours
      'dev.log', // not a dated daily log
    ]
    for (const name of names) writeFileSync(join(dir, name), 'x')
    prepareDevLog(join(dir, 'murmur-2026-08-31.log'), NOW)
    expect(readdirSync(dir).sort()).toEqual([
      'dev.log',
      'murmur-2026-08-17.log',
      'murmur-2026-08-31.log',
      'notes.txt',
    ])
  })

  it('leaves a directory the listener chose alone', () => {
    // MURMUR_DEV_LOG points somewhere murmur does not own (make dev's
    // .dev/dev.log, say): make the directory, sweep nothing in it.
    const dir = mkdtempSync(join(tmpdir(), 'murmur-log-'))
    writeFileSync(join(dir, 'murmur-2026-08-01.log'), 'x')
    prepareDevLog(join(dir, 'dev.log'), NOW)
    expect(existsSync(join(dir, 'murmur-2026-08-01.log'))).toBe(true)
  })

  it('never sweeps away the file it is about to write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-log-'))
    const pinned = join(dir, 'murmur-2026-08-01.log')
    writeFileSync(pinned, 'x')
    prepareDevLog(pinned, NOW)
    expect(existsSync(pinned)).toBe(true)
  })

  it('is a no-op when logging is off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-log-'))
    writeFileSync(join(dir, 'murmur-2026-08-01.log'), 'x')
    prepareDevLog('', NOW)
    expect(readdirSync(dir)).toEqual(['murmur-2026-08-01.log'])
  })

  it('never throws when the location cannot be prepared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-log-'))
    const notADir = join(dir, 'file')
    writeFileSync(notADir, 'x')
    expect(() => prepareDevLog(join(notADir, 'murmur-2026-08-31.log'), NOW)).not.toThrow()
  })
})

// One decision, two views. The branch that picks WHERE the diagnostics go is
// the same branch that knows what SHAPE they take, so a reader never has to
// compare a path against a default to guess which it is looking at.
describe('resolveLogSource', () => {
  it('is the dated set when nothing overrides it', () => {
    const home = '/tmp/murmur-home'
    const source = resolveLogSource({ MURMUR_HOME: home }, NOW)
    expect(source.evidence).toEqual({ kind: 'daily', dir: join(home, 'log') })
    // The path half is unchanged: the same file the mirror appends to.
    expect(source.path).toBe(resolveDevLog({ MURMUR_HOME: home }, NOW))
  })

  it('is that one file when MURMUR_DEV_LOG names it', () => {
    const source = resolveLogSource({ MURMUR_DEV_LOG: '.dev/dev.log' }, NOW)
    expect(source.evidence).toEqual({ kind: 'file', path: '.dev/dev.log' })
    expect(source.path).toBe('.dev/dev.log')
  })

  it('expands a ~ in the override, in both halves', () => {
    const source = resolveLogSource({ MURMUR_DEV_LOG: '~/murmur.log' }, NOW)
    expect(source.evidence).toEqual({ kind: 'file', path: source.path })
    expect(source.path.startsWith('~')).toBe(false)
  })

  it('is nothing at all when the override is explicitly empty', () => {
    // An empty MURMUR_DEV_LOG asks for no log; there is then no evidence to
    // read either, and the readers must say so rather than invent a directory.
    const source = resolveLogSource({ MURMUR_DEV_LOG: '' }, NOW)
    expect(source.evidence).toEqual({ kind: 'none' })
    expect(source.path).toBe('')
  })
})

// The regression this exists to prevent (#176): the two roads that carry log
// evidence into a report used to decide independently where to look, and one
// of them was wrong under an override. They now take the SAME resolved value,
// and this pins that both find the run's lines through it.
describe('both report roads read the evidence the writer chose', () => {
  const write = (path: string, lines: string[]): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, lines.join('\n') + '\n')
  }

  const LINES = [
    '22:10:00 INFO host: the run starts here',
    '22:10:05 INFO director: talk.refill got=2 depth=2',
    '22:11:30 INFO host: the last thing it said',
  ]
  const crash = { pid: 4242, startedAt: local(2026, 8, 30, 22, 10, 0).toISOString() }
  const nextBoot = local(2026, 8, 30, 23, 0, 0)

  it('finds them with no override — the dated set', () => {
    const home = mkdtempSync(join(tmpdir(), 'murmur-home-'))
    const env = { MURMUR_HOME: home }
    const { path, evidence } = resolveLogSource(env, local(2026, 8, 30, 22, 10, 0))
    write(path, LINES)
    expect(readLogTail(evidence, 500).lines).toEqual(LINES)
    expect(readCrashWindow(evidence, crash, nextBoot).lines).toEqual(LINES)
  })

  it('finds them under MURMUR_DEV_LOG — the one file `make dev` points at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-dev-'))
    const env = { MURMUR_DEV_LOG: join(dir, 'dev.log') }
    const { path, evidence } = resolveLogSource(env, local(2026, 8, 30, 22, 10, 0))
    write(path, LINES)
    // Both roads, same evidence, same lines: neither can regress alone.
    expect(readLogTail(evidence, 500).lines).toEqual(LINES)
    expect(readCrashWindow(evidence, crash, nextBoot).lines).toEqual(LINES)
  })
})
