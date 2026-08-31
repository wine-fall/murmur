import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { prepareDevLog, resolveDevLog } from '../src/dev-log.ts'

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
