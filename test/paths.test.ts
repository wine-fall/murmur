import { describe, expect, it } from 'vitest'

import { cacheRoot, claudeCodeRoot, dataRoot, homeRoot, settingsPath, tuiSocketPath } from '../src/paths.ts'

describe('paths', () => {
  it('defaults to ~/.murmur with data/ and cache/ beneath', () => {
    const env = {}
    expect(homeRoot(env).endsWith('/.murmur')).toBe(true)
    expect(dataRoot(env)).toBe(`${homeRoot(env)}/data`)
    expect(cacheRoot(env)).toBe(`${homeRoot(env)}/cache`)
  })

  it('MURMUR_HOME relocates everything; blank degrades to the default', () => {
    expect(dataRoot({ MURMUR_HOME: '/tmp/mh' })).toBe('/tmp/mh/data')
    expect(dataRoot({ MURMUR_HOME: '  ' }).endsWith('/.murmur/data')).toBe(true)
  })

  it('expands a leading ~ in MURMUR_HOME (a quoted .env value arrives unexpanded)', () => {
    const home = homeRoot({ MURMUR_HOME: '~/mh' })
    expect(home.startsWith('/')).toBe(true)
    expect(home.endsWith('/mh')).toBe(true)
    expect(home.includes('~')).toBe(false)
    // A bare ~ is the home dir itself.
    expect(homeRoot({ MURMUR_HOME: '~' }).includes('~')).toBe(false)
  })
})

// spec 06 §2.3: the Claude Code data root slice B reads, resolved in the one
// module allowed to resolve user-level paths.
describe('claudeCodeRoot', () => {
  it('honours $CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeCodeRoot({ CLAUDE_CONFIG_DIR: '/tmp/cc' })).toBe('/tmp/cc')
    expect(claudeCodeRoot({}).endsWith('/.claude')).toBe(true)
    expect(claudeCodeRoot({ CLAUDE_CONFIG_DIR: '  ' }).endsWith('/.claude')).toBe(true)
  })

  it('expands a leading ~ the same way MURMUR_HOME does', () => {
    const root = claudeCodeRoot({ CLAUDE_CONFIG_DIR: '~/alt-claude' })
    expect(root.includes('~')).toBe(false)
    expect(root.endsWith('/alt-claude')).toBe(true)
  })
})

// spec 10 §2.3: the wire's socket is resolved by the one path authority too.
describe('the TUI socket', () => {
  it('lives under the murmur home in run/, and moves with MURMUR_HOME', () => {
    expect(tuiSocketPath({ MURMUR_HOME: '/tmp/mh' })).toBe('/tmp/mh/run/tui.sock')
    expect(tuiSocketPath({}).endsWith('/.murmur/run/tui.sock')).toBe(true)
  })

  it('stays inside the unix socket path length limit', () => {
    // macOS caps sun_path at 104 bytes; a socket that cannot bind is a
    // front-end that never starts.
    expect(tuiSocketPath({}).length).toBeLessThan(100)
  })
})

// spec 12 §2.1: the listener's knobs sit beside voice.json at the home root.
describe('the settings file', () => {
  it('lives at the home root and moves with MURMUR_HOME', () => {
    expect(settingsPath({ MURMUR_HOME: '/tmp/mh' })).toBe('/tmp/mh/settings.json')
    expect(settingsPath({}).endsWith('/.murmur/settings.json')).toBe(true)
  })
})
