import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { GuideCapable, GuideRequest } from '../src/contracts.ts'
import {
  prepareReports,
  reportsDir,
  startReport,
  type DeliverTools,
  type ReportDeps,
  type ReportKind,
} from '../src/report.ts'
import type { GhDraft, GhStatus } from '../src/deliver.ts'
import { FakeHost, until } from './fakes.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'murmur-report-'))
}

// A day of log with one conversation line and one diagnostic, in the shape
// devLogMirror writes and readLogTail reads.
function seedLog(root: string, day = '2026-08-31'): string {
  const dir = join(root, 'log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `murmur-${day}.log`),
    '21:03:01 INFO host: TTS request failed (401)\n21:03:04 INFO user: it went quiet again\n',
  )
  return dir
}

function deps(root: string, over: Partial<ReportDeps> = {}): ReportDeps {
  return {
    host: new FakeHost(),
    home: root,
    logs: { kind: 'daily', dir: seedLog(root) },
    facts: {
      version: '0.1.2',
      platform: 'darwin arm64',
      brain: { actual: 'stub', requested: 'stub' },
      voice: { actual: 'stub', requested: 'hosted' },
      frontEnd: { actual: 'plain', requested: 'tui' },
    },
    model: 'test-model',
    // Never a real editor: the dep is required precisely so no test can spawn
    // one by forgetting it.
    openEditor: () => Promise.resolve(),
    deliver: tools(),
    probes: () => Promise.resolve([{ name: 'ffmpeg', ok: false, reason: 'not found' }]),
    now: () => new Date('2026-08-31T21:04:00Z'),
    ...over,
  }
}

// Every executor that would touch the machine, faked. Nothing in this file can
// reach a real clipboard, a real browser or a real GitHub issue: the types
// require each one, so forgetting is a compile error rather than an accident.
interface Tools extends DeliverTools {
  copied: string[]
  opened: string[]
  created: GhDraft[]
}

function tools(over: Partial<DeliverTools> = {}): Tools {
  const copied: string[] = []
  const opened: string[] = []
  const created: GhDraft[] = []
  return {
    copied,
    opened,
    created,
    hasBrowser: () => true,
    copy: (text) => {
      copied.push(text)
      return Promise.resolve({ ok: true, command: 'pbcopy', reason: '' })
    },
    openUrl: (url) => void opened.push(url),
    ghReady: () => Promise.resolve({ kind: 'ready', user: 'wine-fall' }),
    ghCreate: (draft) => {
      created.push(draft)
      return Promise.resolve({ ok: true, url: 'https://github.com/wine-fall/murmur/issues/9', reason: '' })
    },
    ...over,
  }
}

// Drive a fresh report straight to the send option and return the harness.
async function sendWith(root: string, host: FakeHost, deliver: Tools, kind: ReportKind = 'bug') {
  const session = startReport(deps(root, { host, deliver }), kind)
  await until(() => host.asks.length > 0, 'the options ask')
  const path = draftPathFrom(host)
  session.deliver('send')
  return { session, path }
}

// The one line the flow prints once the draft is on disk, and the path in it.
function draftPathFrom(host: FakeHost): string {
  const line = host.infos.find((info) => info.includes('.md'))
  expect(line, `no draft line in ${JSON.stringify(host.infos)}`).toBeDefined()
  return /(\S+\.md)/.exec(line!)![1]!
}

describe('the report floor (spec 10 §3.2-C)', () => {
  it('writes a draft under the murmur home and names the path', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    expect(path.startsWith(reportsDir(root))).toBe(true)
    expect(path.endsWith('.md')).toBe(true)
    const draft = readFileSync(path, 'utf8')
    // The facts the maintainer reads first, and the log tail verbatim.
    expect(draft).toContain('0.1.2')
    expect(draft).toContain('FAIL ffmpeg')
    expect(draft).toContain('TTS request failed (401)')
    session.deliver('drop')
    await session.done
  })

  it('takes the floor for the whole flow and hands it back at the end', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    expect(host.modes).toEqual(['report'])
    session.deliver('drop')
    await session.done
    expect(host.modes).toEqual(['report', 'radio'])
  })

  it('a feature request and a bug share the floor, under their own names', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'feature')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    expect(path).toContain('feature-')
    session.deliver('drop')
    await session.done
  })

  it('drop deletes the draft and says nothing was kept', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    expect(existsSync(path)).toBe(true)
    session.deliver('drop')
    await session.done
    expect(existsSync(path)).toBe(false)
  })

  it('esc is drop', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    host.pressEsc()
    await session.done
    expect(existsSync(path)).toBe(false)
  })

  it('clean re-renders the draft without the conversation lines', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    expect(readFileSync(path, 'utf8')).toContain('it went quiet again')
    session.deliver('clean')
    await until(() => host.asks.length > 1, 'the options ask again')
    const cleaned = readFileSync(path, 'utf8')
    expect(cleaned).not.toContain('it went quiet again')
    // The diagnostics the report exists for survive the scrub.
    expect(cleaned).toContain('TTS request failed (401)')
    session.deliver('drop')
    await session.done
  })

  it('view opens the draft in the editor, and send hands over what it left there', async () => {
    const root = home()
    const host = new FakeHost()
    const opened: string[] = []
    const deliver = tools()
    const session = startReport(
      deps(root, {
        host,
        deliver,
        // The listener edits in the editor — the flow must not keep believing
        // the copy it rendered.
        openEditor: (path) => {
          opened.push(path)
          writeFileSync(path, 'I deleted almost all of it\n')
          return Promise.resolve()
        },
      }),
      'bug',
    )
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    session.deliver('view')
    await until(() => host.asks.length > 1, 'the options ask again')
    expect(opened).toEqual([path])
    session.deliver('send')
    await session.done
    // What travels is the EDITED file, re-read from disk — never the copy the
    // flow rendered before the listener touched it.
    expect(deliver.copied).toEqual(['I deleted almost all of it\n'])
  })

  // Every option is spelled out in the prompt, so the prompt's own words have
  // to work — and nothing else may destroy the draft by accident.
  it('only an explicit drop deletes the draft', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    for (const stray of ['', 'yes', 'what?', 'ss']) {
      session.deliver(stray)
      await until(() => host.asks.length > 1, `re-prompt after ${JSON.stringify(stray)}`)
      expect(existsSync(path), `${JSON.stringify(stray)} destroyed the draft`).toBe(true)
      host.asks.length = 1
    }
    session.deliver('drop it')
    await session.done
    expect(existsSync(path)).toBe(false)
  })

  it('takes the option words the prompt actually offers', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools()
    const session = startReport(deps(root, { host, deliver }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    session.deliver('send it')
    await session.done
    expect(deliver.copied).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
  })

  it('esc pressed during the slow half still drops it', async () => {
    const root = home()
    const host = new FakeHost()
    let release!: () => void
    const probing = new Promise<void>((resolve) => (release = resolve))
    const session = startReport(
      deps(root, {
        host,
        // A real probe shells out; the listener can give up while it runs, and
        // nothing is waiting on a read to catch the keypress.
        probes: async () => {
          await probing
          return []
        },
      }),
      'bug',
    )
    await until(() => host.modes.length > 0, 'the floor was taken')
    host.pressEsc()
    release()
    await session.done
    expect(host.asks).toHaveLength(0)
    expect(existsSync(reportsDir(root))).toBe(true)
    expect(readdirSync(reportsDir(root))).toEqual([])
  })

  it('cancel ends the flow and keeps nothing', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    session.cancel()
    await session.done
    expect(existsSync(path)).toBe(false)
    expect(host.modes.at(-1)).toBe('radio')
  })

  it('asks the listener what broke when a brain is there to ask', async () => {
    const root = home()
    const host = new FakeHost()
    const seen: GuideRequest[] = []
    const guide: GuideCapable = {
      runGuide(req) {
        seen.push(req)
        return Promise.resolve(`the voice went silent — they said: ${req.prompt}`)
      },
    }
    const session = startReport(deps(root, { host, guide }), 'bug')
    await until(() => host.asks.length > 0, 'the question')
    session.deliver('the voice stopped mid-song')
    await until(() => host.asks.some((a) => a.text.includes('send')), 'the options ask')
    const draft = readFileSync(draftPathFrom(host), 'utf8')
    expect(draft).toContain('the voice stopped mid-song')
    expect(seen).toHaveLength(1)
    // ONE turn, and the listener's own words are what it opens on: the SDK
    // sends `prompt` before it ever calls nextUserInput, so a prompt aimed at
    // the listener would be answered by the model first and land in the draft.
    expect(seen[0]!.prompt).toContain('the voice stopped mid-song')
    expect(seen[0]!.nextUserInput).toBeUndefined()
    // No tools: a bug report is a transcription, never an investigation of the
    // listener's disk.
    const permission = await seen[0]!.canUseTool!('Read', {}, {
      signal: AbortSignal.abort(),
      toolUseID: 'probe',
      requestId: 'probe',
    })
    expect(permission).toMatchObject({ behavior: 'deny' })
    session.deliver('drop')
    await session.done
  })

  it('skips the question with no brain to ask, and still writes the draft', async () => {
    const root = home()
    const host = new FakeHost()
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    // Straight to the options: a stub run never opened a conversation.
    expect(host.asks).toHaveLength(1)
    expect(readFileSync(draftPathFrom(host), 'utf8')).toContain('TTS request failed (401)')
    session.deliver('drop')
    await session.done
  })
})

describe('the drafts directory', () => {
  it('sweeps drafts that have aged out, and keeps the rest', () => {
    const root = home()
    const dir = reportsDir(root)
    const at = new Date('2026-08-31T21:04:00Z')
    mkdirSync(dir, { recursive: true })
    const aged = join(dir, 'bug-2026-08-01T10-00-00.md')
    const fresh = join(dir, 'feature-2026-08-30T10-00-00.md')
    const foreign = join(dir, 'notes-of-my-own.md')
    for (const path of [aged, fresh, foreign]) writeFileSync(path, 'x')
    prepareReports(dir, at)
    expect(existsSync(aged)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    // A file the listener put here is theirs, not ours to sweep.
    expect(existsSync(foreign)).toBe(true)
  })

  it('makes the directory when it is not there yet', () => {
    const dir = reportsDir(home())
    expect(existsSync(dir)).toBe(false)
    prepareReports(dir, new Date())
    expect(existsSync(dir)).toBe(true)
  })
})

// The three roads out, in order. The last press is ALWAYS the listener's on the
// browser road: murmur fills the form in, it does not submit for them.
describe('sending the report (spec 10 §3.2-C)', () => {
  it('road 1: clipboard plus a prefilled form, and the listener presses Create', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools()
    const { session, path } = await sendWith(root, host, deliver)
    await session.done
    // The body handed over is the one on DISK, whole.
    expect(deliver.copied).toHaveLength(1)
    expect(deliver.copied[0]).toBe(readFileSync(path, 'utf8'))
    expect(deliver.opened).toHaveLength(1)
    expect(deliver.opened[0]).toContain('template=bug.yml')
    expect(deliver.opened[0]).toContain('version=0.1.2')
    // Nothing was filed on the listener's behalf.
    expect(deliver.created).toEqual([])
    const told = host.infos.join('\n')
    expect(told).toContain('clipboard')
    expect(told.toLowerCase()).toContain('create')
  })

  it('road 1: a clipboard that refused says so, and points at the draft', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools({
      copy: () => Promise.resolve({ ok: false, command: null, reason: 'xclip is not installed' }),
    })
    const { session, path } = await sendWith(root, host, deliver)
    await session.done
    const told = host.infos.join('\n')
    // Never a pretended success.
    expect(told).toContain('xclip is not installed')
    expect(told).toContain(path)
    // The form still opens: a prefilled report beats no report.
    expect(deliver.opened).toHaveLength(1)
  })

  it('road 1: says out loud how much of the log the form could not hold', async () => {
    const root = home()
    const host = new FakeHost()
    // A log tail far past the URL budget, so the form has to give something up.
    const dir = join(root, 'log')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'murmur-2026-08-31.log'),
      Array.from({ length: 400 }, (_, i) => `21:03:0${String(i % 10)} INFO host: line ${String(i)} of a long night`).join('\n'),
    )
    const deliver = tools()
    const { session } = await sendWith(root, host, deliver)
    await session.done
    const told = host.infos.join('\n')
    expect(told).toMatch(/log/i)
    // The listener is told the size of what was lost, not just that something was.
    expect(told).toMatch(/\d+/)
    expect(deliver.opened[0]!.length).toBeLessThanOrEqual(8000)
  })

  it('road 2: no browser, so gh files it — but only after the listener confirms who as', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools({ hasBrowser: () => false })
    const { session, path } = await sendWith(root, host, deliver)
    await until(() => host.asks.length > 1, 'the confirm')
    // The identity is in the question: this machine holds more than one.
    expect(host.asks.at(-1)!.text).toContain('wine-fall')
    expect(deliver.created).toEqual([])
    session.deliver('y')
    await session.done
    expect(deliver.created).toHaveLength(1)
    // The body travels as a FILE — the draft itself, re-read by gh.
    expect(deliver.created[0]!.bodyFile).toBe(path)
    expect(deliver.created[0]!.title).toContain('[bug]')
    expect(deliver.created[0]!.repo).toContain('murmur')
    expect(host.infos.join('\n')).toContain('https://github.com/wine-fall/murmur/issues/9')
  })

  it('road 2: is honest that this road carries no label', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools({ hasBrowser: () => false })
    const { session } = await sendWith(root, host, deliver)
    await until(() => host.asks.length > 1, 'the confirm')
    // The two roads are NOT equivalent and the listener is not told they are:
    // the web form applies the label, the API path cannot.
    expect(host.asks.at(-1)!.text).toContain('label')
    session.deliver('n')
    await session.done
  })

  it('road 2: a declined confirm files nothing and leaves the draft', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools({ hasBrowser: () => false })
    const { session, path } = await sendWith(root, host, deliver)
    await until(() => host.asks.length > 1, 'the confirm')
    session.deliver('n')
    await session.done
    expect(deliver.created).toEqual([])
    expect(existsSync(path)).toBe(true)
    expect(host.infos.join('\n')).toContain(path)
  })

  it('road 2: a failed filing does not swallow the reason', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools({
      hasBrowser: () => false,
      ghCreate: () => Promise.resolve({ ok: false, url: '', reason: 'could not reach github.com' }),
    })
    const { session, path } = await sendWith(root, host, deliver)
    await until(() => host.asks.length > 1, 'the confirm')
    session.deliver('y')
    await session.done
    const told = host.infos.join('\n')
    expect(told).toContain('could not reach github.com')
    expect(told).toContain(path)
    expect(existsSync(path)).toBe(true)
  })

  it('road 3: no browser and no gh leaves the listener the path and the form', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools({
      hasBrowser: () => false,
      ghReady: () => Promise.resolve({ kind: 'missing', reason: 'the gh command-line tool is not installed' }),
    })
    const { session, path } = await sendWith(root, host, deliver)
    await session.done
    const told = host.infos.join('\n')
    expect(told).toContain('not installed')
    expect(told).toContain(path)
    expect(told).toContain('issues/new')
    expect(deliver.created).toEqual([])
    expect(deliver.copied).toEqual([])
  })

  it('road 3: the URL it prints is one a terminal can hand back', async () => {
    const root = home()
    const host = new FakeHost()
    // A full night of log, so a log-bearing URL would be thousands of
    // characters of percent-encoding printed over the program.
    const dir = join(root, 'log')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'murmur-2026-08-31.log'),
      Array.from({ length: 200 }, (_, i) => `21:03:01 INFO host: line ${String(i)}`).join('\n'),
    )
    const deliver = tools({
      hasBrowser: () => false,
      ghReady: () => Promise.resolve({ kind: 'missing', reason: 'no gh' }),
    })
    const { session, path } = await sendWith(root, host, deliver)
    await session.done
    const printed = /(https:\/\/\S+)/.exec(host.infos.join('\n'))![1]!
    // Nothing here reached a clipboard, so a URL carrying the whole log is a
    // wall of text the listener would have to retype. The log is in the draft;
    // the URL carries the rest.
    expect(printed.length).toBeLessThan(600)
    expect(printed).toContain('version=0.1.2')
    expect(printed).not.toContain('logs=')
    expect(host.infos.join('\n')).toContain(path)
  })

  // The form blocks Create until its required fields are filled, and murmur
  // cannot honestly invent them from one write-up. So it says which ones are
  // still the listener's to write, rather than "press Create" into a wall.
  it('road 1: names the field the form still needs before Create will take it', async () => {
    const root = home()
    const host = new FakeHost()
    const { session } = await sendWith(root, host, tools())
    await session.done
    const told = host.infos.join('\n')
    expect(told).toContain('What you expected instead')
    expect(told).toContain('Log excerpt')
  })

  it('road 1: a feature request is told about ITS form, not the bug form', async () => {
    const root = home()
    const host = new FakeHost()
    const { session } = await sendWith(root, host, tools(), 'feature')
    await session.done
    const told = host.infos.join('\n')
    // There is no Log excerpt on the feature form; telling someone to paste
    // into a field that is not there is an instruction they cannot follow.
    expect(told).not.toContain('Log excerpt')
    expect(told).toContain('Why')
  })

  it('road 1: always leaves a URL, because an opener can fail silently', async () => {
    const root = home()
    const host = new FakeHost()
    // DISPLAY is set but xdg-open is missing: hasBrowser says yes and the
    // spawn dies without telling anyone. The listener needs the address.
    const { session } = await sendWith(root, host, tools())
    await session.done
    expect(host.infos.join('\n')).toContain('issues/new')
  })

  it('esc while gh is still answering files nothing', async () => {
    const root = home()
    const host = new FakeHost()
    let release!: (status: GhStatus) => void
    const deliver = tools({
      hasBrowser: () => false,
      ghReady: () => new Promise<GhStatus>((resolve) => (release = resolve)),
    })
    const session = startReport(deps(root, { host, deliver }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const asksBefore = host.asks.length
    session.deliver('send')
    await until(() => release !== undefined, 'gh was asked')
    session.cancel()
    release({ kind: 'ready', user: 'wine-fall' })
    await session.done
    // No confirm was ever put up, so no later line can answer one.
    expect(host.asks).toHaveLength(asksBefore)
    expect(deliver.created).toEqual([])
  })

  it('a feature request travels as its own form, with no log field', async () => {
    const root = home()
    const host = new FakeHost()
    const deliver = tools()
    const { session } = await sendWith(root, host, deliver, 'feature')
    await session.done
    expect(deliver.opened[0]).toContain('template=feature-request.yml')
    expect(deliver.opened[0]).not.toContain('logs=')
  })
})
