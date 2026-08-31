import { describe, expect, it } from 'vitest'

import {
  URL_BUDGET,
  buildIssueUrl,
  clipboardCandidates,
  copyToClipboard,
  type ClipboardProcess,
  type ClipboardSpawn,
} from '../src/deliver.ts'

// A clipboard tool that behaves as told: 'ok' takes the text, 'missing' is not
// installed (spawn emits ENOENT), 'fail' runs and exits non-zero.
type Behavior = 'ok' | 'missing' | 'fail' | 'broken-pipe'

function fakeSpawn(behaviors: Record<string, Behavior>): {
  spawn: ClipboardSpawn
  tried: string[]
  wrote: string[]
} {
  const tried: string[] = []
  const wrote: string[] = []
  const spawn: ClipboardSpawn = (command) => {
    tried.push(command)
    const listeners: {
      spawn?: () => void
      error?: (err: Error) => void
      close?: (code: number | null) => void
    } = {}
    const behavior = behaviors[command] ?? 'missing'
    let stdinError: ((err: Error) => void) | undefined
    queueMicrotask(() => {
      if (behavior === 'missing') {
        listeners.error?.(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        return
      }
      listeners.spawn?.()
      if (behavior === 'broken-pipe') {
        stdinError?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        return
      }
      listeners.close?.(behavior === 'ok' ? 0 : 1)
    })
    const process: ClipboardProcess = {
      stdin: {
        end: (chunk: string) => void wrote.push(chunk),
        on: (_event, listener) => void (stdinError = listener),
      },
      on: (event, listener) => {
        if (event === 'spawn') listeners.spawn = listener as () => void
        else if (event === 'error') listeners.error = listener as (err: Error) => void
        else listeners.close = listener as (code: number | null) => void
      },
    }
    return process
  }
  return { spawn, tried, wrote }
}

describe('clipboardCandidates', () => {
  it('uses pbcopy on darwin', () => {
    expect(clipboardCandidates('darwin')).toEqual([{ command: 'pbcopy', args: [] }])
  })

  it('uses clip on win32', () => {
    expect(clipboardCandidates('win32')).toEqual([{ command: 'clip', args: [] }])
  })

  // Two competing stacks and no way to know which one a box has: Wayland first,
  // X11 behind it.
  it('offers wl-copy then xclip on linux', () => {
    expect(clipboardCandidates('linux')).toEqual([
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
    ])
  })
})

describe('copyToClipboard', () => {
  it('hands the text to the platform tool and says which one took it', async () => {
    const { spawn, wrote } = fakeSpawn({ pbcopy: 'ok' })
    const result = await copyToClipboard('the report', { platform: 'darwin', spawn })
    expect(result).toEqual({ ok: true, command: 'pbcopy', reason: '' })
    expect(wrote).toEqual(['the report'])
  })

  it('falls back to xclip when wl-copy is not installed', async () => {
    const { spawn, tried, wrote } = fakeSpawn({ xclip: 'ok' })
    const result = await copyToClipboard('the report', { platform: 'linux', spawn })
    expect(result.ok).toBe(true)
    expect(result.command).toBe('xclip')
    expect(tried).toEqual(['wl-copy', 'xclip'])
    expect(wrote).toEqual(['the report'])
  })

  // The caller has to be able to say "the draft is at <path>, copy it yourself".
  it('reports failure, with a reason, when neither linux tool is there', async () => {
    const { spawn, tried } = fakeSpawn({})
    const result = await copyToClipboard('the report', { platform: 'linux', spawn })
    expect(result.ok).toBe(false)
    expect(result.command).toBeNull()
    expect(result.reason).toContain('xclip')
    expect(tried).toEqual(['wl-copy', 'xclip'])
  })

  it('treats a tool that runs and fails as a failure too', async () => {
    const { spawn } = fakeSpawn({ pbcopy: 'fail' })
    const result = await copyToClipboard('the report', { platform: 'darwin', spawn })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('pbcopy')
  })

  // A tool that starts and then dies before reading breaks the pipe from the
  // other end: unhandled, that error would take the radio down with it.
  it('reports a broken pipe as a failed copy instead of dying on it', async () => {
    const { spawn } = fakeSpawn({ 'wl-copy': 'broken-pipe', xclip: 'ok' })
    const result = await copyToClipboard('the report', { platform: 'linux', spawn })
    expect(result.ok).toBe(true)
    expect(result.command).toBe('xclip')
  })

  it('reports a broken pipe when there is nothing left to fall back to', async () => {
    const { spawn } = fakeSpawn({ pbcopy: 'broken-pipe' })
    const result = await copyToClipboard('the report', { platform: 'darwin', spawn })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('pbcopy')
  })

  it('survives a spawn that throws outright', async () => {
    const spawn: ClipboardSpawn = () => {
      throw new Error('no child processes')
    }
    const result = await copyToClipboard('the report', { platform: 'darwin', spawn })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('pbcopy')
  })
})

describe('buildIssueUrl', () => {
  it('prefills every field of the bug form', () => {
    const built = buildIssueUrl('bug', {
      'what-happened': 'the pane never opened',
      expected: 'the pane opens',
      version: '0.1.2',
      platform: 'macOS 15.5, Ghostty',
      logs: '09:00:01 INFO host: on the air',
    })
    expect(built.url).toContain('/issues/new?template=bug.yml')
    expect(built.url).toContain('&what-happened=the%20pane%20never%20opened')
    expect(built.url).toContain('&version=0.1.2')
    expect(built.url).toContain('&logs=09%3A00%3A01%20INFO%20host%3A%20on%20the%20air')
    expect(built.truncated).toBeNull()
    expect(built.dropped).toEqual([])
  })

  it('points the feature form at its own template', () => {
    const built = buildIssueUrl('feature', { what: 'a sleep timer', why: 'I fall asleep' })
    expect(built.url).toContain('template=feature-request.yml')
    expect(built.url).toContain('&why=I%20fall%20asleep')
  })

  it('leaves an empty field out entirely', () => {
    const built = buildIssueUrl('bug', { 'what-happened': 'x', logs: '' })
    expect(built.url).not.toContain('logs=')
    expect(built.dropped).toEqual([])
  })

  it('encodes newlines, ampersands, hashes and non-ASCII', () => {
    const built = buildIssueUrl('bug', { 'what-happened': 'a & b\n#3 caf\u00e9 \ud83c\udf99' })
    expect(built.url).toContain('a%20%26%20b%0A%233%20caf%C3%A9%20%F0%9F%8E%99')
    // Decoding the value back gives exactly what went in.
    const value = new URL(built.url).searchParams.get('what-happened')
    expect(value).toBe('a & b\n#3 caf\u00e9 \ud83c\udf99')
  })

  it('keeps a long report under the budget by truncating the log excerpt', () => {
    const logs = Array.from({ length: 4000 }, (_, i) => `09:00:00 INFO host: line ${String(i)}`).join('\n')
    const built = buildIssueUrl('bug', {
      'what-happened': 'it stopped',
      expected: 'it kept going',
      version: '0.1.2',
      platform: 'macOS 15.5',
      logs,
    })
    expect(built.bytes).toBeLessThanOrEqual(URL_BUDGET)
    expect(built.url.length).toBeLessThanOrEqual(URL_BUDGET)
    expect(built.truncated).not.toBeNull()
    expect(built.truncated?.field).toBe('logs')
    expect(built.truncated?.ofBytes).toBeGreaterThan(built.truncated!.keptBytes)
    expect(built.dropped).toEqual([])
    // The lines nearest the failure are the ones a maintainer reads: the front
    // is what goes.
    const value = new URL(built.url).searchParams.get('logs')
    expect(value?.endsWith('line 3999')).toBe(true)
    expect(value).not.toContain('line 0\n')
  })

  it('never sacrifices the fields that make a report actionable', () => {
    const built = buildIssueUrl('bug', {
      'what-happened': 'it stopped',
      version: '0.1.2',
      platform: 'macOS 15.5',
      logs: 'x'.repeat(50_000),
    })
    const params = new URL(built.url).searchParams
    expect(params.get('what-happened')).toBe('it stopped')
    expect(params.get('version')).toBe('0.1.2')
    expect(params.get('platform')).toBe('macOS 15.5')
    expect(built.bytes).toBeLessThanOrEqual(URL_BUDGET)
  })

  // The essential fields are never cut, even when keeping them costs the
  // budget: a report the maintainer cannot act on is worth less than a long URL.
  it('drops the excerpt outright when not even a little of it fits', () => {
    const built = buildIssueUrl('bug', {
      'what-happened': 'y'.repeat(URL_BUDGET),
      logs: 'x'.repeat(1000),
    })
    expect(built.dropped).toEqual(['logs'])
    expect(built.truncated).toBeNull()
    expect(new URL(built.url).searchParams.get('logs')).toBeNull()
    expect(new URL(built.url).searchParams.get('what-happened')).toHaveLength(URL_BUDGET)
    expect(built.bytes).toBeGreaterThan(URL_BUDGET)
  })

  // Multi-byte characters must never be cut mid-sequence.
  it('truncates whole characters, so the value still decodes', () => {
    const built = buildIssueUrl('bug', { 'what-happened': 'x', logs: '\ud83c\udf99'.repeat(6000) })
    const value = new URL(built.url).searchParams.get('logs')
    expect(value).toMatch(/^\u{1F399}+$/u)
    expect(built.bytes).toBeLessThanOrEqual(URL_BUDGET)
  })
})
