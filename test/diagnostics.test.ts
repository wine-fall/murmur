import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  LOG_TAIL_LINES,
  parseLogLine,
  parseLogLines,
  readLogTail,
  render,
  type DiagnosticsInput,
} from '../src/diagnostics.ts'

const GENERATED_AT = new Date('2026-08-31T12:00:00Z')

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    version: '0.1.2',
    platform: 'darwin 25.5.0 node v24.3.0',
    brain: { actual: 'claude', requested: 'claude' },
    voice: { actual: 'stub', requested: 'hosted' },
    frontEnd: { actual: 'tui', requested: 'tui' },
    probes: [
      { name: 'yt-dlp', ok: true, reason: '' },
      { name: 'bun', ok: true, reason: '' },
    ],
    events: parseLogLines([
      '09:00:01 INFO host: the radio is on the air',
      '09:00:02 INFO radio: good evening',
      '09:00:05 INFO user: hey',
    ]),
    sources: [{ path: '/log/murmur-2026-08-31.log', from: 1, to: 3, count: 3 }],
    generatedAt: GENERATED_AT,
    ...over,
  }
}

describe('render', () => {
  it('is a deterministic string: header, verbatim log, footer', () => {
    expect(render(input())).toBe(
      [
        'murmur diagnostics',
        'generated 2026-08-31T12:00:00.000Z',
        'version 0.1.2',
        'platform darwin 25.5.0 node v24.3.0',
        '',
        'brain: claude',
        'voice: stub (requested hosted)',
        'front-end: tui',
        '',
        'probes:',
        '  ok   yt-dlp',
        '  ok   bun',
        '',
        'signals: none of the known failure signatures matched',
        '',
        '--- log: 3 lines, 2 of them conversation (marked ">") ---',
        '  09:00:01 INFO host: the radio is on the air',
        '> 09:00:02 INFO radio: good evening',
        '> 09:00:05 INFO user: hey',
        '--- end of log ---',
        '',
        'log files:',
        '  /log/murmur-2026-08-31.log lines 1-3 (3 lines)',
        'total 3 lines',
        '',
      ].join('\n'),
    )
  })

  it('copies every log line verbatim, timestamps and all', () => {
    const raw = '09:00:09 INFO director: talk.refill got=2 depth=3 | weird: (payload) [x]'
    const report = render(input({ events: [parseLogLine(raw)] }))
    expect(report).toContain(`  ${raw}\n`)
  })

  it('reports a failing probe with its reason', () => {
    const report = render(
      input({ probes: [{ name: 'ffmpeg', ok: false, reason: "ffmpeg binary not found: 'ffmpeg'" }] }),
    )
    expect(report).toContain("  FAIL ffmpeg — ffmpeg binary not found: 'ffmpeg'")
  })
})

describe('render signals', () => {
  it('names the front-end when the bun probe failed', () => {
    const report = render(input({ probes: [{ name: 'bun', ok: false, reason: 'bun binary not found' }] }))
    expect(report).toContain('the terminal front-end is not up')
  })

  it('names the front-end when the client exited non-zero', () => {
    const report = render(input({ events: [parseLogLine('09:00:03 INFO tui: front-end exited (code 1)')] }))
    expect(report).toContain('the terminal front-end is not up')
  })

  it('ignores a clean front-end exit', () => {
    const report = render(input({ events: [parseLogLine('09:00:03 INFO tui: front-end exited (code 0)')] }))
    expect(report).toContain('signals: none of the known failure signatures matched')
  })

  it('names ffmpeg when its probe failed', () => {
    const report = render(input({ probes: [{ name: 'ffmpeg', ok: false, reason: 'not found' }] }))
    expect(report).toContain('ffmpeg is not usable')
  })

  it('names the voice endpoint on a 4xx', () => {
    const line = '09:00:04 INFO host: voice synthesis failed (Error: TTS request failed (401): bad key); skipping this segment.'
    expect(render(input({ events: [parseLogLine(line)] }))).toContain('the voice endpoint refused the request')
  })

  it('does not fire the voice signature on the radio quoting the error', () => {
    const line = '09:00:04 INFO radio: it said TTS request failed (401), which is a funny thing to say'
    expect(render(input({ events: parseLogLines([line]) }))).toContain(
      'signals: none of the known failure signatures matched',
    )
  })

  it('does not fire the voice signature on a 5xx', () => {
    const line = '09:00:04 INFO host: voice synthesis failed (Error: TTS request failed (503): busy); skipping this segment.'
    expect(render(input({ events: [parseLogLine(line)] }))).toContain(
      'signals: none of the known failure signatures matched',
    )
  })
})

describe('render conversation handling', () => {
  it('marks conversation lines and counts them', () => {
    expect(render(input())).toContain('--- log: 3 lines, 2 of them conversation (marked ">") ---')
  })

  it('drops them on request and says how many went', () => {
    const report = render(input(), { includeConversation: false })
    expect(report).toContain('--- log: 1 lines, 2 conversation lines removed ---')
    expect(report).not.toContain('good evening')
    expect(report).toContain('  09:00:01 INFO host: the radio is on the air')
    // The footer still reports what was COLLECTED, not what survived the filter.
    expect(report).toContain('total 3 lines')
  })

  it('says nothing about conversation when there is none', () => {
    const report = render(input({ events: [parseLogLine('09:00:01 INFO host: on the air')] }))
    expect(report).toContain('--- log: 1 lines ---')
  })

  it('renders an empty log and no sources', () => {
    const report = render(input({ events: [], sources: [] }))
    expect(report).toContain('--- log: 0 lines ---')
    expect(report).toContain('log files: none')
  })
})

describe('parseLogLines', () => {
  const MULTILINE = [
    '09:00:02 INFO radio: the first line of a segment',
    'and the second, with no stamp of its own',
    '09:00:03 INFO host: back to diagnostics',
    'a bare continuation of that one',
  ]

  it('carries conversation across the continuation lines of one message', () => {
    expect(parseLogLines(MULTILINE).map((e) => e.conversation)).toEqual([true, true, false, false])
  })

  it('calls a continuation with nothing above it a diagnostic', () => {
    expect(parseLogLines(['orphaned continuation'])[0]!.conversation).toBe(false)
  })

  it('drops a whole conversation message, continuations included', () => {
    const report = render(input({ events: parseLogLines(MULTILINE) }), { includeConversation: false })
    expect(report).not.toContain('and the second')
    expect(report).toContain('a bare continuation of that one')
    expect(report).toContain('--- log: 2 lines, 2 conversation lines removed ---')
  })
})

describe('parseLogLine', () => {
  it('reads the devLogMirror shape', () => {
    expect(parseLogLine('09:00:02 INFO radio: good evening')).toEqual({
      raw: '09:00:02 INFO radio: good evening',
      time: '09:00:02',
      level: 'INFO',
      name: 'radio',
      message: 'good evening',
      conversation: true,
    })
  })

  it('treats host/director/tui as diagnostics', () => {
    expect(parseLogLine('09:00:02 INFO director: talk.refill got=2').conversation).toBe(false)
  })

  it('keeps a malformed line whole and calls it a diagnostic', () => {
    const raw = '  Traceback (most recent call last):'
    expect(parseLogLine(raw)).toEqual({
      raw,
      time: '',
      level: '',
      name: '',
      message: raw,
      conversation: false,
    })
  })

  it('keeps a colon-heavy message intact', () => {
    expect(parseLogLine('09:00:02 INFO host: a: b: c').message).toBe('a: b: c')
  })
})

function logDir(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-log-'))
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), lines.length === 0 ? '' : lines.join('\n') + '\n')
  }
  return dir
}

const day = (n: number, prefix: string): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1)}`)

describe('readLogTail', () => {
  it('fills N lines backwards across days, oldest first', () => {
    const dir = logDir({
      'murmur-2026-08-29.log': day(10, 'a'),
      'murmur-2026-08-30.log': day(4, 'b'),
      'murmur-2026-08-31.log': day(3, 'c'),
    })
    const tail = readLogTail(dir, 5)
    expect(tail.lines).toEqual(['b-3', 'b-4', 'c-1', 'c-2', 'c-3'])
    expect(tail.sources).toEqual([
      { path: join(dir, 'murmur-2026-08-30.log'), from: 3, to: 4, count: 2 },
      { path: join(dir, 'murmur-2026-08-31.log'), from: 1, to: 3, count: 3 },
    ])
  })

  it('returns everything there is when the logs are shorter than N', () => {
    const dir = logDir({ 'murmur-2026-08-31.log': day(2, 'c') })
    const tail = readLogTail(dir, 500)
    expect(tail.lines).toEqual(['c-1', 'c-2'])
    expect(tail.sources).toEqual([
      { path: join(dir, 'murmur-2026-08-31.log'), from: 1, to: 2, count: 2 },
    ])
  })

  it('ignores files that are not dated murmur logs, and empty days', () => {
    const dir = logDir({
      'murmur-2026-08-30.log': [],
      'murmur-2026-08-31.log': day(2, 'c'),
      'notes.txt': day(9, 'x'),
    })
    const tail = readLogTail(dir, 500)
    expect(tail.lines).toEqual(['c-1', 'c-2'])
    expect(tail.sources.map((s) => s.path)).toEqual([join(dir, 'murmur-2026-08-31.log')])
  })

  it('is empty for a directory that does not exist', () => {
    expect(readLogTail(join(tmpdir(), 'murmur-no-such-dir-1'), 500)).toEqual({ lines: [], sources: [] })
  })

  it('defaults to the tail size the module fixes', () => {
    const dir = logDir({ 'murmur-2026-08-31.log': day(LOG_TAIL_LINES + 7, 'c') })
    expect(readLogTail(dir).lines.length).toBe(LOG_TAIL_LINES)
  })
})
