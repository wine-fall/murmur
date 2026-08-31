import { describe, expect, it } from 'vitest'

import {
  URL_BUDGET,
  buildIssueUrl,
  canOpenBrowser,
  clipboardCandidates,
  copyToClipboard,
  createIssueWithGh,
  ghReady,
  issueTitle,
  type ClipboardProcess,
  type ClipboardSpawn,
  type GhResult,
  type GhRunner,
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

// --- the headless fallback ------------------------------------------------ //

function fakeGh(result: Partial<GhResult>): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: GhRunner = (args) => {
    calls.push(args)
    return Promise.resolve({ ok: false, missing: false, stdout: '', stderr: '', ...result })
  }
  return { run, calls }
}

// The shape `gh auth status` prints when more than one account is known: the
// active one is whichever carries the marker, not the first listed.
const TWO_ACCOUNTS = [
  'github.com',
  '  x Logged in to github.com account octocat (keyring)',
  '  - Active account: false',
  '  x Logged in to github.com account hubot (keyring)',
  '  - Active account: true',
].join('\n')

describe('ghReady', () => {
  it('knows when gh is not installed at all', async () => {
    const { run } = fakeGh({ missing: true })
    const status = await ghReady(run)
    expect(status.kind).toBe('missing')
  })

  it('knows when gh is installed but nobody is logged in', async () => {
    const { run } = fakeGh({
      ok: false,
      stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
    })
    const status = await ghReady(run)
    expect(status.kind).toBe('logged-out')
    expect(status.kind === 'logged-out' && status.reason).toContain('not logged into')
  })

  it('names the account an issue would be filed as', async () => {
    const { run, calls } = fakeGh({ ok: true, stdout: TWO_ACCOUNTS })
    const status = await ghReady(run)
    expect(status).toEqual({ kind: 'ready', user: 'hubot' })
    // Scoped to github.com: an Enterprise identity cannot file this report.
    expect(calls).toEqual([['auth', 'status', '--hostname', 'github.com']])
  })

  it('reads the older single-account wording too', async () => {
    const { run } = fakeGh({ ok: true, stdout: '  x Logged in to github.com as octocat (oauth_token)' })
    expect(await ghReady(run)).toEqual({ kind: 'ready', user: 'octocat' })
  })

  it('reads the status wherever gh printed it', async () => {
    const { run } = fakeGh({ ok: true, stderr: TWO_ACCOUNTS })
    expect(await ghReady(run)).toEqual({ kind: 'ready', user: 'hubot' })
  })

  // gh can exit 0 with the ACTIVE credential broken and a saved one healthy.
  // Naming that saved account would promise an identity gh will not use.
  it('refuses an account that is listed but not the active one', async () => {
    const inactiveOnly = [
      'github.com',
      '  x Logged in to github.com account octocat (keyring)',
      '  - Active account: false',
    ].join('\n')
    const { run } = fakeGh({ ok: true, stdout: inactiveOnly })
    expect((await ghReady(run)).kind).toBe('logged-out')
  })

  // Filing as an identity we cannot name is the mistake this whole probe
  // exists to prevent, so an unreadable status is not "ready".
  it('refuses to call itself ready when it cannot name the account', async () => {
    const { run } = fakeGh({ ok: true, stdout: 'github.com\n  something new and unparsed' })
    const status = await ghReady(run)
    expect(status.kind).toBe('logged-out')
    expect(status.kind === 'logged-out' && status.reason).toContain('account')
  })
})

describe('issueTitle', () => {
  it('carries the classification the labels cannot', () => {
    expect(issueTitle('bug', 'the pane never opened')).toBe('[bug] the pane never opened')
    expect(issueTitle('feature', 'a sleep timer')).toBe('[feat] a sleep timer')
  })

  it('does not double the prefix on a summary that already has one', () => {
    expect(issueTitle('bug', '[bug] the pane never opened')).toBe('[bug] the pane never opened')
  })
})

describe('createIssueWithGh', () => {
  const draft = { repo: 'wine-fall/murmur', title: '[bug] it stopped', bodyFile: '/tmp/draft.md' }

  it('files the issue with the body in a file, and hands back the URL', async () => {
    const { run, calls } = fakeGh({
      ok: true,
      stdout: 'https://github.com/wine-fall/murmur/issues/171\n',
    })
    const created = await createIssueWithGh(draft, run)
    expect(created).toEqual({
      ok: true,
      url: 'https://github.com/wine-fall/murmur/issues/171',
      reason: '',
    })
    expect(calls[0]).toEqual([
      'issue',
      'create',
      '--repo',
      'wine-fall/murmur',
      '--title',
      '[bug] it stopped',
      '--body-file',
      '/tmp/draft.md',
    ])
  })

  // Verified against the real API (issue #171): an issue form's labels are
  // applied by the web submission, never by the REST call gh makes, and --label
  // needs triage rights the reporter does not have. Asking for one would only
  // fail the whole filing.
  it('never asks for a label', async () => {
    const { run, calls } = fakeGh({ ok: true, stdout: 'https://github.com/wine-fall/murmur/issues/1' })
    await createIssueWithGh(draft, run)
    expect(calls[0]).not.toContain('--label')
  })

  it('reports the failure instead of pretending it filed', async () => {
    const { run } = fakeGh({ ok: false, stderr: 'HTTP 410: Issues are disabled' })
    const created = await createIssueWithGh(draft, run)
    expect(created.ok).toBe(false)
    expect(created.url).toBe('')
    expect(created.reason).toContain('Issues are disabled')
  })

  it('says so when gh is not there', async () => {
    const { run } = fakeGh({ missing: true })
    const created = await createIssueWithGh(draft, run)
    expect(created.ok).toBe(false)
    expect(created.reason).toContain('not installed')
  })

  it('does not claim success when gh printed no URL', async () => {
    const { run } = fakeGh({ ok: true, stdout: 'Creating issue in wine-fall/murmur\n' })
    const created = await createIssueWithGh(draft, run)
    expect(created.ok).toBe(false)
    expect(created.reason).toContain('URL')
  })
})

// Which road the report takes is decided from the ENVIRONMENT, never from
// whether opening a browser appeared to work: `openUrl` spawns detached and
// swallows its error, so "it opened" is not an answer this process can get.
describe('canOpenBrowser', () => {
  it('trusts a desktop session', () => {
    expect(canOpenBrowser({}, 'darwin')).toBe(true)
    expect(canOpenBrowser({}, 'win32')).toBe(true)
    expect(canOpenBrowser({ DISPLAY: ':0' }, 'linux')).toBe(true)
    expect(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true)
  })

  it('takes ssh at its word, on any platform', () => {
    // The listener is looking at a terminal somewhere else; a browser opened
    // here would open on a screen nobody is in front of.
    expect(canOpenBrowser({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, 'darwin')).toBe(false)
    expect(canOpenBrowser({ SSH_TTY: '/dev/pts/0' }, 'darwin')).toBe(false)
    expect(canOpenBrowser({ SSH_TTY: '/dev/pts/0', DISPLAY: ':0' }, 'linux')).toBe(false)
  })

  it('needs a display server on linux', () => {
    expect(canOpenBrowser({}, 'linux')).toBe(false)
    // Set but empty is not a display: a headless box exports it that way.
    expect(canOpenBrowser({ DISPLAY: '' }, 'linux')).toBe(false)
  })
})
