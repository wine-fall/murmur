// The report floor (spec 10 §3.2-C): `/bug` and `/feature-request` become a
// short conversation that leaves a draft on disk, instead of a URL the
// listener has to fill in from memory.
//
// The one thing that makes this floor different from the guide's: IT DOES NOT
// STOP THE RADIO. The guide suspends the program because it is reconfiguring
// it — a new voice, a missing binary — and the program has nothing to do until
// that settles. Writing a report changes nothing about the run, so the program
// keeps writing, playing and speaking underneath; only the keyboard changes
// hands, because a typed line has to be either the bug description or talk-back
// and there is no way to tell which. The Director owns that handover: it keeps
// reading lines and delivers them here (src/director.ts).

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GuideCapable } from './contracts.ts'
import {
  parseLogLines,
  readLogTail,
  render,
  type LogTail,
  type ProbeReport,
  type Selection,
} from './diagnostics.ts'
import {
  buildIssueUrl,
  issueTitle,
  type CopyResult,
  type GhCreated,
  type GhDraft,
  type GhStatus,
} from './deliver.ts'
import type { LogEvidence } from './dev-log.ts'
import { escPulse, isYes } from './guide.ts'
import { ask, LineQueue, type Host } from './host.ts'
import { REPORT_PROMPT, reportSystemPrompt } from './prompts.ts'

export type ReportKind = 'bug' | 'feature'

// How long a draft the listener never sent stays around. The same fortnight the
// dev log keeps its days (src/dev-log.ts) — a report is evidence about a run,
// and it ages out of usefulness on the same clock as the log it quotes.
const RETENTION_DAYS = 14

// The drafts this flow names, so the sweep never touches a file the listener
// put here themselves.
const DRAFT = /^(?:bug|feature)-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}\.md$/

const TITLE: Record<ReportKind, string> = {
  bug: 'murmur bug report',
  feature: 'murmur feature request',
}

const OPENING: Record<ReportKind, string> = {
  bug: 'what broke?',
  feature: 'what do you wish it did?',
}

// The four ways out of the draft, each answerable by its first letter.
const OPTIONS = 'send it, view it, clean it, or drop it? [s/v/c/d]'

// The murmur home's drafts. Derived from the home the config boundary already
// resolved rather than re-read from the environment (spec 05 §2.3).
export function reportsDir(home: string): string {
  return join(home, 'reports')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Filename-safe down to the second: two reports in one evening must not land
// on the same draft, and a colon is not a filename on every platform.
function stamp(at: Date): string {
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  )
}

// Make the drafts directory and drop the ones that have aged out. Best-effort,
// like the dev log's own sweep: an unwritable home costs a draft, never the
// radio.
export function prepareReports(dir: string, at: Date = new Date()): void {
  try {
    mkdirSync(dir, { recursive: true })
    const cutoff = stamp(new Date(at.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)).slice(0, 10)
    for (const name of readdirSync(dir)) {
      const dated = DRAFT.exec(name)
      if (dated === null || dated[1]! >= cutoff) continue
      rmSync(join(dir, name), { force: true })
    }
  } catch {
    // e.g. an unwritable home, or a file sitting where the directory should be
  }
}

// What a run ended up with, for the report's header. The same three selections
// `render` prints; gathered by the caller, which is the only place that knows
// what was asked for beside what was built.
export interface ReportFacts {
  version: string
  platform: string
  brain: Selection
  voice: Selection
  frontEnd: Selection
}

// The repo a report is filed against. One constant so the browser road and the
// gh road can never disagree about where it went.
export const REPORT_REPO = 'wine-fall/murmur'

// Everything the send step does to the outside world. Grouped and REQUIRED,
// each one injected: between them these write a clipboard, open a browser, and
// create a real GitHub issue, and a default behind any of them would let a test
// — or a forgetful construction site — do all three for real.
export interface DeliverTools {
  // Whether a browser can be opened HERE. Environment-decided, never inferred
  // from whether a spawn seemed to work (src/deliver.ts explains why).
  hasBrowser(): boolean
  copy(text: string): Promise<CopyResult>
  openUrl(url: string): void
  ghReady(): Promise<GhStatus>
  ghCreate(draft: GhDraft): Promise<GhCreated>
}

export interface ReportDeps {
  host: Host
  // The one murmur home, already resolved at the config boundary.
  home: string
  // Where this run's own diagnostics are, in whatever shape the log writer
  // chose (src/dev-log.ts). Not a directory: an overridden log is one file, and
  // a report that assumed the dated set would quote another run or nothing.
  logs: LogEvidence
  facts: ReportFacts
  // Borrowed for the opening question (spec 03-03 §2's capability, not a new
  // abstraction). Absent — a stub run, or no key — skips straight to the draft.
  guide?: GuideCapable
  model: string
  // The machine probes, injected so a test never spawns a binary. Absent = the
  // report says none were run.
  probes?: () => Promise<ProbeReport[]>
  deliver: DeliverTools
  // How `view` shows the draft. Required, and with no fallback behind it: only
  // the caller knows whether anything else is holding the terminal, and a
  // default that spawned an editor into a live TUI would fight it for the
  // screen. Resolves when the listener is done looking.
  openEditor: (path: string) => Promise<void>
  now?: () => Date
}

// The Director's handle on a running report: it keeps owning the keyboard and
// hands each line over, so the two never race for the same typed line.
export interface ReportSession {
  deliver(line: string): void
  // End the flow from outside and keep nothing — the listener is leaving, so
  // there is nobody left to answer the prompt this is waiting on.
  cancel(): void
  readonly done: Promise<void>
}

// The header the listener's own words go in, above the machine's half.
function describe(kind: ReportKind, said: string): string {
  const body = said.trim() === '' ? '(nothing written down — the log below is the whole report)' : said.trim()
  return `# ${TITLE[kind]}\n\n${body}\n\n## diagnostics\n\n`
}

// A report the caller already knows the shape of — murmur's own, not the
// listener's. The crash path fills both in: it knows what happened (the
// listener does not, a boot later) and which log window it happened in.
export interface ReportOpening {
  said: string
  tail?: LogTail
}

export function startReport(
  deps: ReportDeps,
  kind: ReportKind,
  given?: ReportOpening,
): ReportSession {
  const { host } = deps
  const queue = new LineQueue()
  // Esc answers the read that is waiting with '' — which, on every prompt this
  // flow has, means "drop it".
  const esc = escPulse()
  const now = deps.now ?? ((): Date => new Date())

  const read = async (): Promise<string> => {
    const take = queue.peek().then(() => queue.take() ?? '')
    return await Promise.race([take, esc.wait()])
  }

  // Esc, or the Director's cancel. A LATCH, not just the pulse: the flow spends
  // real time in places where no read is waiting (the probes shell out, the
  // editor holds the listener), and a keypress there must not be lost. Every
  // stage checks it before committing to the next.
  let dropped = false
  const drop = (): void => {
    dropped = true
    esc.fire()
  }

  const done = (async (): Promise<void> => {
    host.setMode?.('report')
    host.onInterrupt?.(drop)
    let path: string | null = null
    try {
      const said = given?.said ?? (await opening(deps, kind, read, () => dropped))
      if (dropped) return void host.info('dropped it — nothing kept.', 'flow')
      const dir = reportsDir(deps.home)
      prepareReports(dir, now())
      const tail = given?.tail ?? readLogTail(deps.logs)
      const input = {
        ...deps.facts,
        probes: (await deps.probes?.()) ?? [],
        events: parseLogLines(tail.lines),
        sources: tail.sources,
        generatedAt: now(),
      }
      // The probes shelled out; the listener may have given up while they ran.
      if (dropped) return void host.info('dropped it — nothing kept.', 'flow')
      path = join(dir, `${kind}-${stamp(now())}.md`)
      const write = (clean: boolean): void => {
        writeFileSync(path!, describe(kind, said) + render(input, { includeConversation: !clean }))
      }
      write(false)
      host.info(`draft saved to ${path}`)

      // The draft is on disk now, so every option below reads it from there.
      while (!dropped) {
        ask(host, OPTIONS, 'question')
        const answer = chosen(await read())
        if (answer === 'send') {
          // Deliberately re-read: the listener may have just edited this file
          // in `view`, and the copy this flow rendered is then a lie. Every
          // road below carries THIS text, or the file itself.
          await deliverDraft(deps, kind, path, readFileSync(path, 'utf8'), read, () => dropped)
          return
        }
        if (answer === 'view') {
          await deps.openEditor(path)
          continue
        }
        if (answer === 'clean') {
          write(true)
          host.info('the conversation is out of the draft.')
          continue
        }
        if (answer === 'drop') break
        // Anything else is a typo, not an instruction. NOTHING here destroys
        // the draft by falling through: a listener who types "send it" and
        // loses the report has been robbed by a menu.
        host.info('type s, v, c or d — the draft is still here.')
      }
      rmSync(path, { force: true })
      path = null
      host.info('dropped it — nothing kept.', 'flow')
    } catch (err) {
      // A report is never worth taking the radio down for.
      host.info(`the report failed (${String(err)}); back to the program.`)
      if (path !== null) rmSync(path, { force: true })
    } finally {
      host.onInterrupt?.(null)
      host.setMode?.('radio')
    }
  })()

  return {
    deliver(line: string): void {
      queue.push(line)
    },
    cancel: drop,
    done,
  }
}

// Which of the four the listener meant. The prompt spells the options out in
// words, so the words it shows have to work as answers; everything else is
// unrecognized, and unrecognized never means "delete it".
function chosen(line: string): 'send' | 'view' | 'clean' | 'drop' | null {
  const said = line.trim().toLowerCase()
  if (said === 's' || said === 'send' || said === 'send it') return 'send'
  if (said === 'v' || said === 'view' || said === 'view it') return 'view'
  if (said === 'c' || said === 'clean' || said === 'clean it') return 'clean'
  if (said === 'd' || said === 'drop' || said === 'drop it') return 'drop'
  return null
}

// The one question, then one turn of the guide capability to write the answer
// up in the words a maintainer needs. A run with no brain behind it skips
// straight to the machine's half of the report — the log tail was always the
// part doing the work.
//
// The listener's line is read BEFORE the model is called, and travels as the
// prompt: the harness sends `prompt` as the opening user message and only then
// consults nextUserInput, so a prompt written at the listener would be answered
// by the model first and that answer would land in the draft.
async function opening(
  deps: ReportDeps,
  kind: ReportKind,
  read: () => Promise<string>,
  dropped: () => boolean,
): Promise<string> {
  if (deps.guide === undefined) return ''
  ask(deps.host, OPENING[kind], 'question')
  const said = (await read()).trim()
  if (said === '' || dropped()) return said
  try {
    return await deps.guide.runGuide({
      systemPrompt: reportSystemPrompt(kind),
      prompt: `${REPORT_PROMPT}\n\n${said}`,
      model: deps.model,
      maxTurns: 1,
      onText: (text) => deps.host.info(text),
      // Transcription, not investigation: this capability ships with the
      // guide's built-in shell and file tools, and a bug report has no business
      // reading the listener's disk. The refusal is the boundary, not a hope.
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'the report writes, it does not investigate' }),
    })
  } catch {
    // The brain failed; the listener's own words plus the log tail still make a
    // report worth filing.
    return said
  }
}

// --- handing the draft over ----------------------------------------------- //
//
// Three roads, in order, and the order is the point.
//
// The browser is the main road, and on it the LAST PRESS IS ALWAYS THE
// LISTENER'S: murmur fills the form in and opens it, and Create is theirs to
// click. That is a general rule, not a concession to this piece — nothing here
// posts on someone's behalf while they can still read what is about to go out.
// `gh` is the exception the rule makes for a box with no browser to press it
// in, and even there a confirm naming the account comes first.

// Where the listener's own words end and the machine's half begins, in the
// draft this module writes.
const DIAGNOSTICS = '\n## diagnostics\n'

// The draft as its two halves. A report the listener edited in `view` is still
// read here, from disk, so what travels is what they left behind.
export function splitDraft(body: string): { description: string; diagnostics: string } {
  const at = body.indexOf(DIAGNOSTICS)
  const head = at === -1 ? body : body.slice(0, at)
  const diagnostics = at === -1 ? '' : body.slice(at + DIAGNOSTICS.length).trim()
  // Drop the `# title` line: the form has its own title.
  const description = head.replace(/^#[^\n]*\n/, '').trim()
  return { description, diagnostics }
}

// The form fields each template actually has. A feature request has no log
// field at all, so nothing tries to hand it one.
function formFields(
  kind: ReportKind,
  facts: ReportFacts,
  halves: { description: string; diagnostics: string },
): Record<string, string> {
  if (kind === 'feature') return { what: halves.description }
  return {
    'what-happened': halves.description,
    version: facts.version,
    platform: facts.platform,
    logs: halves.diagnostics,
  }
}

// What the form still needs from the listener before GitHub will accept it.
// Both templates mark a second field required, and one write-up cannot honestly
// be split into an account of what happened AND what was expected — so the flow
// names the field instead of inventing content for it or telling someone to
// press Create into a validation error.
function stillNeeded(kind: ReportKind, copied: boolean): string {
  if (kind === 'feature') {
    return copied
      ? 'fill in "Why", then press Create yourself — the whole draft is on your clipboard if you want more of it.'
      : 'fill in "Why", then press Create yourself.'
  }
  return copied
    ? 'fill in "What you expected instead", paste the draft into "Log excerpt" (it is on your clipboard), then press Create yourself.'
    : 'fill in "What you expected instead", then press Create yourself.'
}

// The issue's title on the gh road, where there is no form to supply one.
function summaryOf(description: string): string {
  const first = description.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  return first === '' ? 'a report from a listener' : first.slice(0, 120)
}

async function deliverDraft(
  deps: ReportDeps,
  kind: ReportKind,
  path: string,
  body: string,
  read: () => Promise<string>,
  dropped: () => boolean,
): Promise<void> {
  const { host, deliver } = deps
  const halves = splitDraft(body)
  const form = buildIssueUrl(kind, formFields(kind, deps.facts, halves))
  // The hand-it-over roads print their URL into a terminal, where a
  // log-bearing address is thousands of characters of percent-encoding with
  // the one actionable line — the draft's path — buried above it. Nothing was
  // copied on those roads anyway, so the log travels in the file anyone
  // reaching for this URL already has.
  const shortForm = buildIssueUrl(kind, formFields(kind, deps.facts, { ...halves, diagnostics: '' })).url

  if (deliver.hasBrowser()) {
    // The clipboard carries what the URL could not: the form's own length
    // budget is the reason the log may not fit, and a paste closes that gap.
    const copied = await deliver.copy(body)
    if (dropped()) return
    deliver.openUrl(form.url)
    sayWhatTheFormLost(deps, form, copied, path)
    if (!copied.ok) host.info(`no clipboard here (${copied.reason}) — the draft is at ${path}, to copy in yourself.`)
    // hasBrowser answers "is there a desktop", not "did the page open": the
    // opener is spawned detached and its failure is silent, so the address is
    // printed either way and a box with no URL handler still has a road.
    host.info(`the form is at ${shortForm}`)
    host.info(stillNeeded(kind, copied.ok), 'flow')
    return
  }

  const status = await deliver.ghReady()
  // gh shells out; the listener may have left while it answered, and the pulse
  // that Esc fired had no reader to wake.
  if (dropped()) return
  if (status.kind !== 'ready') {
    host.info(`no browser here, and ${status.reason}.`)
    return void byHand(host, path, shortForm)
  }

  // The account is in the question because a machine can hold more than one,
  // and a report filed under the wrong name is only noticed afterwards. The
  // missing label is in it too: these two roads are NOT equivalent, and saying
  // so is cheaper than a listener wondering why their issue went untriaged.
  ask(
    host,
    `no browser here — file it on GitHub as ${status.user}? it goes up through gh, which cannot attach the bug label, so the title carries that instead. [y/N]`,
    'consent',
  )
  if (!isYes(await read())) {
    host.info('left it with you, then.')
    return void byHand(host, path, shortForm)
  }

  if (dropped()) return
  const created = await deliver.ghCreate({
    repo: REPORT_REPO,
    title: issueTitle(kind, summaryOf(halves.description)),
    // The body goes as the FILE: a draft carries a log tail, and gh reads it
    // from disk — the same text `view` may have left there.
    bodyFile: path,
  })
  if (!created.ok) {
    host.info(`gh could not file it (${created.reason}).`)
    return void byHand(host, path, shortForm)
  }
  host.info(`filed as ${status.user}: ${created.url}`, 'flow')
}

// What the form could not hold, in the sizes a listener can act on. Never
// silent: a shortened report that looks whole is worse than a short one that
// says so.
function sayWhatTheFormLost(
  deps: ReportDeps,
  form: ReturnType<typeof buildIssueUrl>,
  copied: CopyResult,
  path: string,
): void {
  const rest = copied.ok ? 'the clipboard copy has all of it' : `all of it is in ${path}`
  if (form.dropped.includes('logs')) {
    deps.host.info(`the log did not fit in the form at all — ${rest}.`)
    return
  }
  if (form.truncated !== null) {
    const { keptBytes, ofBytes } = form.truncated
    deps.host.info(
      `the form could only hold ${String(keptBytes)} of the log's ${String(ofBytes)} bytes — ${rest}.`,
    )
  }
}

// The last road: nothing automatic worked, so hand over both halves of what the
// listener needs and get out of the way.
function byHand(host: Host, path: string, formUrl: string): void {
  host.info(`the draft is at ${path}`)
  host.info(`file it yourself at ${formUrl}`, 'flow')
}
