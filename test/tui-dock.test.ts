// The question dock's pure logic (spec 10 §3.2-B): the title names what kind
// of answer the question wants, and the text wraps to the terminal instead of
// vanishing off the right edge. Rendering stays untested (spec 10 §3.9); this
// is the shaping the client renders.

import { describe, expect, it } from 'vitest'

import { dockLines, dockTitle, outbound } from '../tui/src/dock.ts'

describe('outbound', () => {
  it('forwards the empty line while a question is docked — Enter IS the skip (spec 06 §2.1)', () => {
    expect(outbound('', true)).toBe('')
    expect(outbound('   ', true)).toBe('   ')
  })

  it('keeps dropping empty lines when nothing is asked (idle Enter is not a message)', () => {
    expect(outbound('', false)).toBeNull()
    expect(outbound('   ', false)).toBeNull()
    expect(outbound('hello', false)).toBe('hello')
  })
})

describe('dockTitle', () => {
  it('names the kind of answer the question wants', () => {
    expect(dockTitle('question')).toBe(' murmur is asking ')
    expect(dockTitle('consent')).toBe(' murmur needs a yes ')
  })
})

describe('dockLines', () => {
  it('keeps a short line whole', () => {
    expect(dockLines('allow? [y/N]', 40)).toEqual(['allow? [y/N]'])
  })

  it('honors the newline a multi-part ask arrives with', () => {
    expect(dockLines('run [Bash]: brew install yt-dlp\nallow? [y/N]', 40)).toEqual([
      'run [Bash]: brew install yt-dlp',
      'allow? [y/N]',
    ])
  })

  it('wraps at word boundaries to the given width', () => {
    const lines = dockLines('what do you want on the air, mostly music or late-night talk?', 24)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(24)
    expect(lines.join(' ')).toBe('what do you want on the air, mostly music or late-night talk?')
  })

  it('hard-splits a word longer than the width instead of overflowing', () => {
    const lines = dockLines('https://api.fish.audio/some/very/long/endpoint/path', 16)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(16)
    expect(lines.join('')).toBe('https://api.fish.audio/some/very/long/endpoint/path')
  })

  it('survives a degenerate width', () => {
    expect(dockLines('hi', 0)).toEqual(['h', 'i'])
  })
})
