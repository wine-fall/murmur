import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { GuideCapable, GuideRequest } from '../src/contracts.ts'
import { prepareReports, reportsDir, startReport, type ReportDeps } from '../src/report.ts'
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
    logDir: seedLog(root),
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
    probes: () => Promise.resolve([{ name: 'ffmpeg', ok: false, reason: 'not found' }]),
    now: () => new Date('2026-08-31T21:04:00Z'),
    ...over,
  }
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

  it('view opens the draft in the editor, and send re-reads it from disk', async () => {
    const root = home()
    const host = new FakeHost()
    const opened: string[] = []
    const session = startReport(
      deps(root, {
        host,
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
    // The line count comes from the edited file, not the rendered draft.
    const sent = host.infos.at(-1)!
    expect(sent).toContain(path)
    expect(sent).toContain('1 line')
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
    const session = startReport(deps(root, { host }), 'bug')
    await until(() => host.asks.length > 0, 'the options ask')
    const path = draftPathFrom(host)
    session.deliver('send it')
    await session.done
    expect(host.infos.at(-1)).toContain(path)
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
