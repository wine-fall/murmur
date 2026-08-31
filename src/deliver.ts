// The two delivery primitives behind the one-key bug report (spec 10 §3.2-C):
// putting the draft where the listener can paste it, and handing GitHub a form
// that is already filled in. Both are parts, not wiring — the flow that decides
// when to use them lives with the report conversation.

import { spawn as nodeSpawn } from 'node:child_process'

// --- the clipboard -------------------------------------------------------- //

export interface ClipboardTool {
  command: string
  args: string[]
}

// What writes the clipboard here, in preference order. Shaped like `openerFor`
// (src/director.ts): a pure platform decision, spawned by a thin layer below.
// Linux is the only platform with a real choice — Wayland's tool first, X11's
// behind it — and on a given box either, or neither, may be installed.
export function clipboardCandidates(platform: NodeJS.Platform): ClipboardTool[] {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }]
  if (platform === 'win32') return [{ command: 'clip', args: [] }]
  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
  ]
}

// Just enough of a child process to write to and wait on — so a test can hand
// in a fake without building one.
export interface ClipboardProcess {
  stdin: {
    end(chunk: string): void
    on(event: 'error', listener: (err: Error) => void): void
  } | null
  on(event: 'spawn', listener: () => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
}

export type ClipboardSpawn = (command: string, args: string[]) => ClipboardProcess

// Whether the text actually landed, and if not, why — the caller needs the
// answer to fall back on "the draft is at <path>, copy it yourself".
export interface CopyResult {
  ok: boolean
  command: string | null
  reason: string
}

export async function copyToClipboard(
  text: string,
  opts: { platform?: NodeJS.Platform; spawn?: ClipboardSpawn } = {},
): Promise<CopyResult> {
  const platform = opts.platform ?? process.platform
  const run = opts.spawn ?? defaultSpawn
  let reason = 'no clipboard tool is known for this platform'
  for (const tool of clipboardCandidates(platform)) {
    const failure = await attemptCopy(run, tool, text)
    if (failure === null) return { ok: true, command: tool.command, reason: '' }
    // Keep the LAST candidate's reason: on linux that is the one a listener can
    // act on, the earlier tool having simply not been this box's stack.
    reason = failure
  }
  return { ok: false, command: null, reason }
}

const defaultSpawn: ClipboardSpawn = (command, args) =>
  nodeSpawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })

// Resolves null when the tool took the text, else the reason it did not.
function attemptCopy(spawn: ClipboardSpawn, tool: ClipboardTool, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (failure: string | null): void => {
      if (settled) return
      settled = true
      resolve(failure)
    }
    let child: ClipboardProcess
    try {
      child = spawn(tool.command, tool.args)
    } catch (err) {
      return done(`${tool.command} could not start: ${String(err)}`)
    }
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      done(missing ? `${tool.command} is not installed` : `${tool.command} failed: ${err.message}`)
    })
    child.on('close', (code) => done(code === 0 ? null : `${tool.command} exited ${String(code)}`))
    // Only a process that actually started has a stdin worth writing to:
    // writing to the torn-down pipe of a missing binary raises an error of its
    // own, on the stream rather than here.
    child.on('spawn', () => {
      const stdin = child.stdin
      if (stdin === null) return done(`${tool.command} has nowhere to take the text`)
      // A tool that starts and then exits before reading (a headless session's
      // wl-copy, a draft it refuses) breaks the pipe ASYNCHRONOUSLY: unhandled,
      // that EPIPE takes the radio down instead of falling back.
      stdin.on('error', (err) => done(`${tool.command} would not take the text: ${err.message}`))
      try {
        stdin.end(text)
      } catch (err) {
        done(`${tool.command} would not take the text: ${String(err)}`)
      }
    })
  })
}

// --- the prefilled issue form --------------------------------------------- //

// GitHub's issue forms accept a query parameter per field id. Verified against
// the real forms, every field including the `logs` textarea — the length below
// is the only real constraint.
const ISSUE_BASE = 'https://github.com/wine-fall/murmur/issues/new'

const TEMPLATE_FILE = { bug: 'bug.yml', feature: 'feature-request.yml' } as const

export type IssueTemplate = keyof typeof TEMPLATE_FILE

// How long the whole URL may get. Browsers and servers stop honoring one
// somewhere past this; it is a budget for the ENTIRE address, not per field.
export const URL_BUDGET = 8000

// The one field a report can survive losing. Everything else — what happened,
// what was expected, the version, the platform — is what makes a report
// actionable at all, so it is never touched.
const SACRIFICIAL = 'logs'

// What had to give, so the caller can say it out loud rather than silently
// handing over a shortened report.
export interface IssueUrl {
  url: string
  bytes: number
  // The sacrificial field when only part of it fit.
  truncated: { field: string; keptBytes: number; ofBytes: number } | null
  // Fields left out entirely.
  dropped: string[]
}

export function buildIssueUrl(template: IssueTemplate, fields: Record<string, string>): IssueUrl {
  const base = `${ISSUE_BASE}?template=${TEMPLATE_FILE[template]}`
  const kept = Object.entries(fields).filter(([, value]) => value !== '')
  const excerpt = kept.find(([id]) => id === SACRIFICIAL)?.[1] ?? ''
  const essential = kept.filter(([id]) => id !== SACRIFICIAL)
  const withoutExcerpt = base + essential.map(([id, value]) => param(id, value)).join('')

  const whole = excerpt === '' ? withoutExcerpt : withoutExcerpt + param(SACRIFICIAL, excerpt)
  if (whole.length <= URL_BUDGET) {
    return { url: whole, bytes: whole.length, truncated: null, dropped: [] }
  }

  // The excerpt is a LOG: the lines nearest the failure are what a maintainer
  // reads, so a trim drops the front. Anything that must survive whole belongs
  // in one of the fields above, which are never cut.
  const budget = URL_BUDGET - withoutExcerpt.length - param(SACRIFICIAL, '').length
  const survives = longestTail(excerpt, budget)
  if (survives === '') {
    return {
      url: withoutExcerpt,
      bytes: withoutExcerpt.length,
      truncated: null,
      dropped: [SACRIFICIAL],
    }
  }
  const url = withoutExcerpt + param(SACRIFICIAL, survives)
  return {
    url,
    bytes: url.length,
    truncated: {
      field: SACRIFICIAL,
      keptBytes: encodeURIComponent(survives).length,
      ofBytes: encodeURIComponent(excerpt).length,
    },
    dropped: [],
  }
}

function param(id: string, value: string): string {
  return `&${encodeURIComponent(id)}=${encodeURIComponent(value)}`
}

// The longest tail of `text` whose encoded form fits `budget`, counted in whole
// characters — a cut inside a multi-byte sequence would not decode.
function longestTail(text: string, budget: number): string {
  if (budget <= 0) return ''
  const chars = [...text]
  let used = 0
  let taken = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const cost = encodeURIComponent(chars[i]!).length
    if (used + cost > budget) break
    used += cost
    taken++
  }
  return chars.slice(chars.length - taken).join('')
}
