import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { LevelFilter, LogFollower } from '../scripts/devwatch.ts'

const tempLog = (): string => join(mkdtempSync(join(tmpdir(), 'devwatch-')), 'dev.log')

describe('LevelFilter', () => {
  it('hides the DEBUG firehose at the default INFO level', () => {
    const filter = new LevelFilter('INFO')
    expect(filter.show('10:00:00 DEBUG harness: raw dump')).toBe(false)
    expect(filter.show('10:00:01 INFO director: airing a beat')).toBe(true)
    expect(filter.show('10:00:02 WARNING music: retrying')).toBe(true)
  })

  it('carries the decision onto continuation lines that have no level token', () => {
    const filter = new LevelFilter('INFO')
    filter.show('10:00:00 WARNING music: retrying')
    expect(filter.show('  Traceback: line 1')).toBe(true)
    filter.show('10:00:01 DEBUG harness: raw dump')
    expect(filter.show('  ...continued dump')).toBe(false)
  })

  it('does not read an indented continuation line as carrying a level', () => {
    const filter = new LevelFilter('INFO')
    filter.show('10:00:00 WARNING music: retrying')
    expect(filter.show('  DEBUG was the last state')).toBe(true)
  })

  it('unmutes everything at DEBUG', () => {
    expect(new LevelFilter('DEBUG').show('10:00:00 DEBUG harness: raw dump')).toBe(true)
  })

  it('falls back to INFO for an unknown level name', () => {
    expect(new LevelFilter('LOUD').show('10:00:00 DEBUG harness: raw dump')).toBe(false)
  })
})

describe('LogFollower', () => {
  it('waits quietly for a logfile that does not exist yet', () => {
    expect(new LogFollower(join(tmpdir(), 'murmur-no-such-dir', 'dev.log')).readNew()).toEqual([])
  })

  it('returns only the lines appended since the last call', () => {
    const path = tempLog()
    writeFileSync(path, 'one\ntwo\n')
    const follower = new LogFollower(path)
    expect(follower.readNew()).toEqual(['one', 'two'])
    expect(follower.readNew()).toEqual([])
    appendFileSync(path, 'three\n')
    expect(follower.readNew()).toEqual(['three'])
  })

  it('holds a partial line back until its newline arrives', () => {
    const path = tempLog()
    writeFileSync(path, 'complete\npart')
    const follower = new LogFollower(path)
    expect(follower.readNew()).toEqual(['complete'])
    appendFileSync(path, 'ial\n')
    expect(follower.readNew()).toEqual(['partial'])
  })

  it('restarts from the top when the file is truncated by a fresh run', () => {
    const path = tempLog()
    writeFileSync(path, 'old session line\n')
    const follower = new LogFollower(path)
    follower.readNew()
    writeFileSync(path, 'new\n')
    expect(follower.readNew()).toEqual(['new'])
  })
})
