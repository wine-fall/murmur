// The delivery primitives behind the one-key bug report (spec 10 §3.2-C):
// putting the draft where the listener can paste it, handing GitHub a form that
// is already filled in, and — for a box with no browser to press Create in —
// filing it through `gh`. Parts, not wiring: the flow that decides which road
// to take lives with the report conversation.

import { execFile, spawn as nodeSpawn } from 'node:child_process'

// --- the clipboard -------------------------------------------------------- //

export interface ClipboardTool {
  command: string
  args: string[]
}

// What writes the clipboard here, in preference order. Shaped like `openerFor`
// (src/director/director.ts): a pure platform decision, spawned by a thin layer below.
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

// `spawn` is required, with no default behind it: a caller that forgot one
// would write the listener's real clipboard — from a test, silently. Every
// dependency here that touches the machine is injected for the same reason;
// `spawnClipboard` below is the one production wiring.
export async function copyToClipboard(
  text: string,
  opts: { platform?: NodeJS.Platform; spawn: ClipboardSpawn },
): Promise<CopyResult> {
  const platform = opts.platform ?? process.platform
  const run = opts.spawn
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

export const spawnClipboard: ClipboardSpawn = (command, args) =>
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

// --- which road ----------------------------------------------------------- //

// Is there a browser here for the listener to press Create in?
//
// Decided from the ENVIRONMENT, not from a result: `openUrl` spawns the
// platform opener detached and swallows its error (src/director/director.ts), so
// "did it open" is not a question this process can ever get an answer to.
// Pure, so the decision is testable without a desktop.
export function canOpenBrowser(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // The listener is sitting at a terminal somewhere else entirely; a browser
  // opened on THIS machine opens on a screen nobody is looking at.
  if ((env.SSH_CONNECTION ?? '') !== '' || (env.SSH_TTY ?? '') !== '') return false
  // macOS and Windows always have a way to show a page. Linux only has one
  // when a display server is actually up — a headless box exports neither, or
  // exports one empty.
  if (platform !== 'linux') return true
  return (env.DISPLAY ?? '') !== '' || (env.WAYLAND_DISPLAY ?? '') !== ''
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

// --- the headless fallback ------------------------------------------------ //
//
// The browser is the main road: the listener reviews the prefilled form and
// presses Create themselves. `gh` is for the boxes with no browser to press it
// in — ssh, a headless machine — where murmur files the issue directly.
//
// VERIFIED (wine-fall/murmur#171, gh 2.52.0): an issue created this way does
// NOT pick up the `labels: ['bug']` declared in the issue form. Those labels
// are applied by the web form submission; `gh issue create` posts through the
// REST API, where the template never participates. `--label` cannot make up
// the difference either — it needs triage rights on the repo, which an ordinary
// reporter does not have, and asking for one would fail the whole filing. So
// the gh path deliberately sends no label, and the title prefix carries the
// classification instead (see `issueTitle`).

// The little of a `gh` run the callers here need. `missing` is separate from a
// failed run because "install gh" and "gh said no" are different next steps.
export interface GhResult {
  ok: boolean
  missing: boolean
  stdout: string
  stderr: string
}

export type GhRunner = (args: string[]) => Promise<GhResult>

// The one production `gh`. Exported rather than defaulted for the reason
// above: a forgotten runner would file a real issue on the real repo.
export const runGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err === null) return resolve({ ok: true, missing: false, stdout, stderr })
      const code = (err as NodeJS.ErrnoException).code
      const missing = code === 'ENOENT' || code === 'ENOTDIR'
      resolve({ ok: false, missing, stdout, stderr })
    })
  })

// Three answers, because each has its own next step: install gh, log in, or go
// ahead — as this named account. The name matters: a machine can hold more than
// one GitHub identity, and filing a report as the wrong one is the kind of
// mistake that is only noticed afterwards. The caller shows it in the confirm
// line.
export type GhStatus =
  | { kind: 'missing'; reason: string }
  | { kind: 'logged-out'; reason: string }
  | { kind: 'ready'; user: string }

export async function ghReady(run: GhRunner): Promise<GhStatus> {
  // Scoped to github.com: a bare status walks every configured host, so a
  // stale Enterprise credential could fail the probe — or worse, hand back an
  // Enterprise identity that cannot file this report at all.
  const result = await run(['auth', 'status', '--hostname', GITHUB_HOST])
  if (result.missing) return { kind: 'missing', reason: 'the gh command-line tool is not installed' }
  // gh has printed this on stdout in some versions and stderr in others; both
  // are read so the probe does not hinge on which one this build chose.
  const text = `${result.stdout}\n${result.stderr}`
  if (!result.ok) return { kind: 'logged-out', reason: firstLine(text) || 'gh is not logged in' }
  const user = activeAccount(text)
  // Filing as an identity we cannot name is exactly the mistake this probe
  // exists to prevent, so an unreadable status is not "ready" — and the next
  // step is the logged-out one either way: sort gh's auth out first.
  if (user === null) return { kind: 'logged-out', reason: 'gh did not name the account it is logged in as' }
  return { kind: 'ready', user }
}

const GITHUB_HOST = 'github.com'

// "Logged in to github.com account NAME" (current) or "... as NAME" (older).
const ACCOUNT = /Logged in to \S+ (?:account|as) ([\w-]+)/
const MARKER = /Active account:/
const ACTIVE = /Active account:\s*true/

// With several accounts known, the active one is whichever the marker follows —
// never simply the first listed: gh can exit 0 with the ACTIVE credential
// broken and another one healthy, and naming that other account would promise
// an identity `gh issue create` is not going to use. The first-account fallback
// is only for the legacy output that carries no markers at all.
function activeAccount(text: string): string | null {
  const lines = text.split('\n')
  const marked = lines.some((line) => MARKER.test(line))
  let candidate: string | null = null
  for (const line of lines) {
    const named = ACCOUNT.exec(line)
    if (named !== null) {
      if (!marked) return named[1]!
      candidate = named[1]!
      continue
    }
    if (ACTIVE.test(line) && candidate !== null) return candidate
  }
  return null
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

// The classification the labels cannot carry on this path, matching the `title`
// prefixes the issue forms themselves set.
const TITLE_PREFIX = { bug: '[bug] ', feature: '[feat] ' } as const

export function issueTitle(template: IssueTemplate, summary: string): string {
  const prefix = TITLE_PREFIX[template]
  return summary.startsWith(prefix) ? summary : prefix + summary
}

export interface GhDraft {
  repo: string
  title: string
  // The body goes through a FILE: a report carries a log tail, and an argument
  // list has a length limit a draft can pass.
  bodyFile: string
}

export interface GhCreated {
  ok: boolean
  url: string
  reason: string
}

export async function createIssueWithGh(draft: GhDraft, run: GhRunner): Promise<GhCreated> {
  const result = await run([
    'issue',
    'create',
    '--repo',
    draft.repo,
    '--title',
    draft.title,
    '--body-file',
    draft.bodyFile,
  ])
  if (result.missing) {
    return { ok: false, url: '', reason: 'the gh command-line tool is not installed' }
  }
  if (!result.ok) {
    return { ok: false, url: '', reason: firstLine(result.stderr) || 'gh could not file the issue' }
  }
  const url = ISSUE_URL.exec(result.stdout)?.[0] ?? ''
  // gh exits 0 having printed the new issue's URL. No URL means something else
  // happened, and reporting a filing we cannot point at would be a lie.
  if (url === '') return { ok: false, url: '', reason: 'gh filed no issue URL to point at' }
  return { ok: true, url, reason: '' }
}

const ISSUE_URL = /https:\/\/\S+\/issues\/\d+/
