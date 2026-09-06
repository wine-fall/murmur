import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { InProcessMemoryStore, PersistentMemoryStore } from '../src/memory/memory.ts'
import {
  BUG_FORM_URL,
  Director,
  FEATURE_FORM_URL,
  openerFor,
  steerFromLine,
  type DirectorDeps,
} from '../src/director/director.ts'
import { SCENES } from '../src/director/scene.ts'
import { INSTALL_COMMAND } from '../src/support/update.ts'
import { directorSettings, FakeBrain, FakeHost, FakePlayer, FakeVoice, until } from './fakes.ts'

function setup(over: Partial<DirectorDeps> & { gapSeconds?: number } = {}) {
  const { gapSeconds = 0, ...rest } = over
  // Never the desktop's own opener: every harness injects one, so no test can
  // reach a real browser by forgetting to.
  const opened: string[] = []
  const brain = new FakeBrain()
  const voice = new FakeVoice()
  const player = new FakePlayer()
  const host = new FakeHost()
  const memory = new InProcessMemoryStore()
  const knobs = directorSettings({ gapSeconds })
  const director = new Director({
    persona: 'p',
    brain,
    voice,
    player,
    memory,
    host,
    settings: () => knobs,
    openUrl: (url) => void opened.push(url),
    ...rest,
  })
  return { brain, voice, player, host, memory, knobs, opened, director }
}

describe('steerFromLine', () => {
  it('classifies /quit, /settings, /setup and talkback', () => {
    expect(steerFromLine(' /quit ')).toEqual({ intent: 'quit' })
    expect(steerFromLine('/settings')).toEqual({ intent: 'settings' })
    expect(steerFromLine('/setup')).toEqual({ intent: 'setup' })
    expect(steerFromLine('hello')).toEqual({ intent: 'talkback', text: 'hello' })
  })

  it('classifies the two feedback commands', () => {
    expect(steerFromLine('/bug')).toEqual({ intent: 'bug' })
    expect(steerFromLine(' /feature-request ')).toEqual({ intent: 'feature' })
  })

  it('classifies /update', () => {
    expect(steerFromLine('/update')).toEqual({ intent: 'update' })
  })
})

// spec 10 §3.2-C: the feedback commands are the listener's way out to GitHub.
// They open the prefilled issue form in a browser and ALWAYS print the URL, so
// a headless box (or a dead opener) still leaves something to click.
// A report floor the test drives by hand: it never finishes on its own, which
// is what makes "the radio kept playing" a real assertion.
function withReport(over: Partial<DirectorDeps> & { gapSeconds?: number } = {}) {
  const started: string[] = []
  const lines: string[] = []
  let finish!: () => void
  const done = new Promise<void>((resolve) => (finish = resolve))
  const report = {
    started,
    lines,
    cancels: 0,
    finish: (): void => finish(),
  }
  const harness = setup({
    ...over,
    reportRecall: (kind) => {
      started.push(kind)
      return {
        deliver: (line: string) => void lines.push(line),
        cancel: () => {
          report.cancels++
          finish()
        },
        done,
      }
    },
  })
  return { ...harness, report }
}

// The report floor REPLACES the browser form: with one wired, a feedback
// command must never reach the desktop. Every report test ends on this.
function expectNoBrowser(opened: string[]): void {
  expect(opened).toEqual([])
}

describe('Director — /bug and /feature-request', () => {
  const openings = (): { urls: string[]; open: (url: string) => void } => {
    const urls: string[] = []
    return { urls, open: (url) => void urls.push(url) }
  }

  it('opens the bug form and prints its URL, without composing a reply', async () => {
    const { urls, open } = openings()
    const { brain, host, director } = setup({ gapSeconds: 3, openUrl: open })
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => urls.length === 1, 'bug form opened')
    expect(urls[0]).toBe(BUG_FORM_URL)
    expect(host.infos.some((m) => m.includes(BUG_FORM_URL))).toBe(true)
    host.type('/quit')
    await run
    expect(brain.respondCalls).toEqual([]) // a command is never a turn
    expect(host.user).toEqual([])
  })

  it('opens the feature form on /feature-request', async () => {
    const { urls, open } = openings()
    const { brain, host, director } = setup({ gapSeconds: 3, openUrl: open })
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/feature-request')
    await until(() => urls.length === 1, 'feature form opened')
    expect(urls[0]).toBe(FEATURE_FORM_URL)
    host.type('/quit')
    await run
    expect(brain.respondCalls).toEqual([])
  })

  it('picks the desktop opener per platform, never spawn\'s deprecated shell form', () => {
    // DEP0190 (codex review): args + `shell: true` warns on Node 24 and the
    // warning would land on the TUI's own terminal.
    expect(openerFor('darwin', BUG_FORM_URL)).toEqual({ command: 'open', args: [BUG_FORM_URL] })
    expect(openerFor('linux', BUG_FORM_URL)).toEqual({ command: 'xdg-open', args: [BUG_FORM_URL] })
    // cmd re-parses its own command line, and a prefilled issue URL is full of
    // `&` — unquoted, the browser would receive only the part before the first
    // one and every prefilled field would be lost.
    const prefilled = `${BUG_FORM_URL}&version=0.1.2&platform=darwin`
    expect(openerFor('win32', prefilled)).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', `"${prefilled}"`],
    })
  })

  it('hands the whole flow to the report floor when one is wired', async () => {
    const { brain, host, director, report, opened } = withReport({ gapSeconds: 3 })
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => report.started.length === 1, 'the report floor opened')
    expect(report.started).toEqual(['bug'])
    expectNoBrowser(opened)
    report.finish()
    host.type('/quit')
    await run
  })

  // The whole reason report is its own floor and not a second guide: the setup
  // guide parks the program because it is reconfiguring it, and a report
  // changes nothing about the run. The radio must not go quiet while the
  // listener types out what went wrong.
  it('keeps the radio on the air for the whole report', async () => {
    // A real gap, so the program is genuinely mid-run when /bug lands rather
    // than already finished.
    const { brain, host, player, director, report, opened } = withReport({ gapSeconds: 0.02 })
    brain.batches = [['first'], ['second'], ['third']]
    const run = director.run(3)
    await until(() => host.radio.length >= 1, 'first segment')
    host.type('/bug')
    await until(() => report.started.length === 1, 'the report floor opened')
    const airedSoFar = player.played.length
    // Nothing resolves the report: the program has to keep going underneath it.
    await until(() => host.radio.length >= 3, 'the program kept going under the report')
    // Written AND spoken — the segments are reaching the player, not just the
    // transcript. A silent radio would pass the line count alone.
    expect(player.played.length).toBeGreaterThan(airedSoFar)
    expectNoBrowser(opened)
    report.finish()
    await run
  })

  it('every typed line is the report\'s while it holds the floor', async () => {
    const { brain, host, director, report, opened } = withReport({ gapSeconds: 3 })
    brain.batches = [['a'], ['b'], ['c']]
    const run = director.run(3)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => report.started.length === 1, 'the report floor opened')
    host.type('the voice died mid-song')
    await until(() => report.lines.length === 1, 'the line reached the report')
    expect(report.lines).toEqual(['the voice died mid-song'])
    // Not a turn: no reply composed, nothing echoed as the listener talking.
    expect(brain.respondCalls).toEqual([])
    expect(host.user).toEqual([])
    expectNoBrowser(opened)
    report.finish()
    host.type('/quit')
    await run
  })

  it('gives the keyboard back once the report is done', async () => {
    const { brain, host, director, report, opened } = withReport({ gapSeconds: 3 })
    brain.batches = [['a'], ['b'], ['c']]
    const run = director.run(3)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => report.started.length === 1, 'the report floor opened')
    report.finish()
    // A macrotask, so the Director's own then-handler has cleared the floor
    // before the next line is typed.
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.type('are you still there')
    await until(() => brain.respondCalls.length === 1, 'a reply, not report material')
    expect(report.lines).toEqual([])
    expectNoBrowser(opened)
    host.type('/quit')
    await run
  })

  // Typing out a bug description must not make the radio talk MORE: a line the
  // report ate is not a reason to cut the inter-segment gap short.
  it('a line the report ate does not shorten the gap', async () => {
    const { brain, host, director, report, opened } = withReport({ gapSeconds: 0.4 })
    brain.batches = [['a'], ['b'], ['c']]
    const run = director.run(3)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => report.started.length === 1, 'the report floor opened')
    // Into the NEXT gap, then type: an aborted gap would put the following
    // segment on the air almost immediately.
    await until(() => host.radio.length === 2, 'the second segment')
    const typedAt = Date.now()
    host.type('it went quiet')
    await until(() => report.lines.length === 1, 'the line reached the report')
    await until(() => host.radio.length === 3, 'the third segment')
    expect(Date.now() - typedAt).toBeGreaterThanOrEqual(300)
    expectNoBrowser(opened)
    report.finish()
    host.type('/quit')
    await run
  })

  it('/quit cancels the open report on its way out', async () => {
    // A budget the run does not reach, so /quit is what ends it.
    const { brain, host, director, report } = withReport({ gapSeconds: 3 })
    brain.batches = [['a'], ['b'], ['c']]
    const run = director.run(3)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => report.started.length === 1, 'the report floor opened')
    host.type('/quit')
    await run
    // Left running, a report waiting on a read (or on the model) would hold
    // work open behind a listener who has already left.
    expect(report.cancels).toBe(1)
  })

  it('/quit leaves even with a report open — it is the one line the floor does not eat', async () => {
    const { brain, host, director, report, opened } = withReport({ gapSeconds: 3 })
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => report.started.length === 1, 'the report floor opened')
    host.type('/quit')
    await run
    expect(report.lines).toEqual([])
    expectNoBrowser(opened)
  })

  it('still prints the URL when the opener fails (no browser on the box)', async () => {
    const { brain, host, director } = setup({
      gapSeconds: 3,
      openUrl: () => {
        throw new Error('no opener')
      },
    })
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/bug')
    await until(() => host.infos.some((m) => m.includes(BUG_FORM_URL)), 'URL printed anyway')
    host.type('/quit')
    await run
  })
})

// spec 10 §3.2-C: /update is a command like the rest — it checks npm for a
// newer murmur beside the program, and never becomes a turn. The check itself
// is `src/support/update.ts`; what is pinned here is that the Director routes to it.
describe('Director — /update', () => {
  function withUpdate(over: Partial<DirectorDeps> & { gapSeconds?: number } = {}) {
    const calls: number[] = []
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const harness = setup({
      ...over,
      updateRecall: () => {
        calls.push(Date.now())
        return done
      },
    })
    // Unbounded runs below: a segment budget could retire the loop between two
    // typed lines and pass a routing test for the wrong reason. /quit ends them.
    harness.brain.batches = Array.from({ length: 12 }, (_, i) => [`talk ${i + 1}`])
    return { ...harness, update: { calls, finish: (): void => finish() } }
  }

  it('starts the check without composing a reply or echoing the line', async () => {
    const { brain, host, director, update } = withUpdate({ gapSeconds: 3 })
    const run = director.run()
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/update')
    await until(() => update.calls.length === 1, 'the check started')
    update.finish()
    host.type('/quit')
    await run
    expect(brain.respondCalls).toEqual([]) // a command is never a turn
    expect(host.user).toEqual([])
  })

  // npm is slow, and the check is never awaited: the radio owes the listener
  // its program for the whole minute an install can take.
  it('keeps the program on the air while the check runs', async () => {
    const { host, player, director, update } = withUpdate({ gapSeconds: 0.02 })
    const run = director.run()
    await until(() => host.radio.length >= 1, 'first segment')
    host.type('/update')
    await until(() => update.calls.length === 1, 'the check started')
    const airedSoFar = player.played.length
    // Nothing resolves the check: the program has to keep going underneath it.
    await until(() => host.radio.length >= 3, 'the program kept going under the check')
    // Written AND spoken — a silent radio would pass the line count alone.
    expect(player.played.length).toBeGreaterThan(airedSoFar)
    update.finish()
    host.type('/quit')
    await run
  })

  it('runs one check at a time — a second /update is not a second npm', async () => {
    const { host, director, update } = withUpdate({ gapSeconds: 3 })
    const run = director.run()
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/update')
    await until(() => update.calls.length === 1, 'the check started')
    host.type('/update')
    // Long enough for the impatient second line to reach the Director at all.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(update.calls).toHaveLength(1)
    update.finish()
    host.type('/quit')
    await run
  })

  it('takes the check again once the first one has finished', async () => {
    const { host, director, update } = withUpdate({ gapSeconds: 3 })
    const run = director.run()
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/update')
    await until(() => update.calls.length === 1, 'the check started')
    update.finish()
    // A macrotask, so the Director's own then-handler has cleared the flag
    // before the next line is typed.
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.type('/update')
    await until(() => update.calls.length === 2, 'a second check')
    host.type('/quit')
    await run
  })

  it('hands over the command when the run has no updater wired (stub runs)', async () => {
    const { brain, host, director } = setup({ gapSeconds: 3 })
    brain.batches = Array.from({ length: 12 }, (_, i) => [`talk ${i + 1}`])
    const run = director.run()
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/update')
    await until(() => host.infos.some((m) => m.includes(INSTALL_COMMAND)), 'the manual command')
    host.type('/quit')
    await run
    expect(brain.respondCalls).toEqual([])
  })
})

describe('Director — /setup recall (spec 10 §3.4 mid-broadcast)', () => {
  it('a typed /setup pauses the talk loop for the recall and resumes after', async () => {
    // Q6 of the boundary decisions: the DJ stops opening new segments while
    // the guide has the floor; the recall returning hands the loop back.
    let inRecall = false
    let recalls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { brain, player, host, director } = setup({
      setupRecall: async () => {
        recalls++
        inRecall = true
        await gate
        inRecall = false
      },
    })
    brain.batches = [['a'], ['b']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'first clip on air')
    host.type('/setup')
    await until(() => inRecall, 'the recall opened')
    // The loop is parked inside the recall: no second segment airs.
    await new Promise((r) => setTimeout(r, 30))
    expect(player.played.length).toBe(1)
    release()
    player.finish() // the parked clip ends; the loop moves to the next segment
    await until(() => player.played.length === 2, 'the broadcast resumed')
    host.type('/quit')
    await run
    expect(recalls).toBe(1)
  })

  it('without the recall wiring (a stub run), /setup answers with the shell pointer', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('/setup')
    await until(() => host.infos.some((m) => m.includes('murmur --setup')), 'the pointer line')
    host.type('/quit')
    await run
  })

  it('auth-shaped synth failures point at /setup ONCE — the reopen path (issue #97)', async () => {
    const { brain, voice, player, host, director } = setup()
    brain.batches = [['a'], ['b'], ['c']]
    player.auto = true
    voice.failTimes = 99
    voice.failWith = 'endpoint answered 401 unauthorized'
    await director.run(3)
    const hints = host.infos.filter((m) => m.includes('/setup'))
    expect(hints.length).toBe(1)
  })

  it('an auth failure also raises the app seam, so detectGaps can see a failing endpoint', async () => {
    let raised = 0
    const { brain, voice, player, director } = setup({ onVoiceAuthFailure: () => void raised++ })
    brain.batches = [['a']]
    player.auto = true
    voice.failTimes = 99
    voice.failWith = '403 forbidden'
    await director.run(1)
    expect(raised).toBeGreaterThanOrEqual(1)
  })

  it('a /quit that lands inside the recall stops the loop without composing more', async () => {
    let fireQuit: () => void = () => {}
    const { brain, player, host, director } = setup({
      setupRecall: async () => fireQuit(), // the user typed /quit INTO the setup conversation
    })
    fireQuit = () => director.requestQuit()
    brain.batches = [['a'], ['b']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('/setup')
    player.finish()
    await run // must resolve: the recall's quit is honored, no second segment
    expect(player.played.length).toBe(1)
    expect(host.infos.some((m) => m.includes('going off the air'))).toBe(true)
  })

  it('a non-auth synth failure keeps the plain skip line — no /setup nagging', async () => {
    const { brain, voice, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = true
    voice.failTimes = 99
    voice.failWith = 'socket hang up'
    await director.run(1)
    expect(host.infos.some((m) => m.includes('skipping this segment'))).toBe(true)
    expect(host.infos.some((m) => m.includes('/setup'))).toBe(false)
  })
})

// spec 12 §3.6: /settings is a command like /quit — the engine owns the parse.
// A front-end with a pane is told to show it; the plain host gets one pointer
// line. Neither burns a reply turn nor interrupts what is on air.
describe('Director — /settings command', () => {
  it('tells a pane-capable host to show the pane, without composing a reply', async () => {
    const { brain, host, director } = setup({ gapSeconds: 3 })
    let shown = 0
    host.showSettings = () => void shown++
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/settings')
    await until(() => shown === 1, 'pane shown')
    host.type('/quit')
    await run
    expect(brain.respondCalls).toEqual([]) // never treated as talkback
  })

  it('points a plain host at the file instead', async () => {
    const { brain, host, director } = setup({ gapSeconds: 3 })
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('/settings')
    await until(() => host.infos.some((m) => m.includes('settings.json')), 'pointer line')
    host.type('/quit')
    await run
    expect(brain.respondCalls).toEqual([])
  })
})

// spec 12 §3.2: gap and memory span read the live thunk — a change lands at the
// next boundary with no reconstruction.
describe('Director — live settings', () => {
  it('picks up a changed recentWindow at the next brain call', async () => {
    const { brain, memory, knobs, director } = setup()
    for (let i = 1; i <= 6; i++) memory.record({ role: 'radio', text: `old ${i}` })
    knobs.recentWindow = 3
    brain.batches = [['a', 'b']]
    await director.run(1)
    expect(brain.talkContexts[0]!.recent.length).toBe(3)
  })

  it('picks up a changed gapSeconds at the next gap', async () => {
    const { brain, player, host, knobs, director } = setup({ gapSeconds: 60 })
    player.auto = false
    brain.batches = [['a'], ['b']]
    const run = director.run(2)
    await until(() => player.played.length === 1, 'clip on air')
    knobs.gapSeconds = 0 // lands while the clip still plays -> the gap reads it
    player.finish()
    // A captured 60s gap would park the loop here; the live read airs b now.
    await until(() => player.played.length === 2, 'second segment aired')
    player.finish()
    await run
    expect(host.radio).toEqual(['a', 'b'])
  })
})

describe('Director — autonomous talk loop', () => {
  it('airs beats from batched calls and records them', async () => {
    const { brain, player, host, memory, director } = setup()
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(3)
    // Batches cover multiple segments in order: the extras air from the
    // look-ahead buffer, never regenerated (a cold call per segment would air
    // fresh later-batch beats instead of b).
    expect(host.radio).toEqual(['a', 'b', 'c'])
    expect(player.played).toHaveLength(3)
    expect(memory.recent(10).map((t) => t.text)).toEqual(['a', 'b', 'c'])
  })

  it('a failing brain degrades to a skipped segment, never a crash', async () => {
    const { brain, host, director } = setup()
    brain.batches = [] // every call throws
    await director.run(2)
    expect(host.radio).toEqual([])
    expect(host.infos.some((m) => m.includes('talk generation failed'))).toBe(true)
  })

  it('a failing synth retries then skips the segment', async () => {
    const retry = setup()
    retry.brain.batches = [['a']]
    retry.voice.failTimes = 1 // first attempt fails; retry succeeds
    await retry.director.run(1)
    expect(retry.host.radio).toEqual(['a'])

    const skip = setup()
    skip.brain.batches = [['b']]
    skip.voice.failTimes = 99 // every attempt fails: the segment is skipped
    await skip.director.run(1)
    expect(skip.host.radio).toEqual([])
    expect(skip.host.infos.some((m) => m.includes('voice synthesis failed'))).toBe(true)
  })
})

describe('Director — talk look-ahead (spec 04 §3.3)', () => {
  it('the next segment airs the buffered beat, pre-synthesized behind the prior one', async () => {
    const { brain, voice, host, director } = setup()
    brain.batches = [['a', 'b'], ['c', 'd']]
    await director.run(2)
    // b came from the depth-2 buffer (a cold call at segment 2 would have
    // aired c, the next batch's first beat).
    expect(host.radio).toEqual(['a', 'b'])
    // b's synthesis was scheduled with the cold batch — behind segment 1, not
    // on segment 2's critical path.
    expect(voice.synthesized.slice(0, 2)).toEqual(['a', 'b'])
  })

  it('a top-up refill carries the queued beat as a prior radio turn (coherence)', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a', 'b'], ['c']]
    await director.run(1)
    // Call 0 is the cold batch; call 1 is the refill fired after a was
    // recorded, whose context holds BOTH the aired a and the queued-but-unaired
    // b — so the batch continues the monologue instead of duplicating b.
    await until(() => brain.talkContexts.length >= 2, 'refill fired')
    const texts = brain.talkContexts[1]!.recent.map((t) => t.text)
    expect(texts).toContain('a')
    expect(texts).toContain('b')
    expect(brain.talkContexts[1]!.recent.at(-1)).toEqual({ role: 'radio', text: 'b' })
    // The refill's stages land in the dev log (spec 04 §3.3).
    expect(host.debugs.some((m) => m.includes('talk.refill'))).toBe(true)
  })

  it('a transient nextTalks failure is retried; the beat still airs', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a', 'b']]
    brain.nextTalksFailTimes = 1
    await director.run(1)
    expect(host.radio).toEqual(['a'])
  })
})

describe('Director — prepare-then-barge-in interjection', () => {
  it('keeps playing while composing, then cuts over when the reply is ready', async () => {
    const { brain, player, host, memory, director } = setup()
    // Batch 2 feeds the background refill (discarded by the steer); batch 3 is
    // the fresh post-reply regeneration.
    brain.batches = [['a'], ['bg'], ['next']]
    brain.respondDelayMs = 40
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'first clip on air')
    host.type('hi')
    // While the reply composes, the current clip must keep playing (no stop).
    await new Promise((r) => setTimeout(r, 15))
    expect(player.stops).toBe(0)
    expect(player.playing).toBe(true)
    // Reply lands: the clip is cut, the reply airs over the same channel.
    await until(() => player.stops === 1, 'barge-in stop')
    await until(() => host.radio.length === 2, 'reply aired')
    expect(host.radio[1]).toBe('re:hi')
    expect(memory.recent(10).map((t) => `${t.role}:${t.text}`)).toEqual([
      'radio:a',
      'user:hi',
      'radio:re:hi',
    ])
    player.finish() // reply clip ends
    await until(() => player.played.length >= 3, 'program resumes') // next segment airs
    host.type('/quit')
    player.finish()
    await run
  })

  it('merges lines arriving before the reply is ready into one reply', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    brain.respondDelayMs = 40
    player.auto = false
    const run = director.run(1)
    await until(() => player.played.length === 1, 'clip on air')
    host.type('one')
    await new Promise((r) => setTimeout(r, 10))
    host.type('two')
    await until(() => host.radio.length === 2, 'merged reply aired')
    // The reply covers both lines in one respond call; the discarded first
    // prepare may also have recorded its call — the FINAL one is merged.
    expect(brain.respondCalls.at(-1)).toBe('one\ntwo')
    expect(host.user).toEqual(['one', 'two'])
    expect(host.radio[1]).toBe('re:one\ntwo')
    player.finish()
    player.finish()
    await run
  })

  it('a reply that fails to compose returns to the program', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    brain.failRespond = true
    player.auto = false
    const run = director.run(1)
    await until(() => player.played.length === 1, 'clip on air')
    host.type('hi')
    await until(() => host.infos.some((m) => m.includes('reply failed')), 'degraded')
    expect(player.stops).toBe(0) // nothing to barge in with; clip plays on
    player.finish()
    await run
    expect(host.radio).toEqual(['a'])
  })

  it('discards buffered look-ahead beats on a talkback (stale after the user turn)', async () => {
    const { brain, player, host, director } = setup()
    // Batch 2 is consumed by the background refill; the steer discards both the
    // buffered stale-b and the refilled bg, so the resume regenerates fresh.
    brain.batches = [['a', 'stale-b'], ['bg'], ['fresh']]
    player.auto = false
    const run = director.run(2)
    await until(() => player.played.length === 1, 'clip on air')
    host.type('hi')
    await until(() => host.radio.length === 2, 'reply aired')
    player.finish() // reply ends -> next segment
    await until(() => host.radio.length === 3, 'next segment')
    expect(host.radio[2]).toBe('fresh') // never a stale buffered beat
    expect(host.radio).not.toContain('stale-b')
    expect(host.radio).not.toContain('bg')
    player.finish()
    await run
  })
})

describe('Director — memory wiring (spec 05)', () => {
  it('assembles the pack from the store: profile, covered topics, scene', async () => {
    const store = new PersistentMemoryStore({ dir: mkdtempSync(join(tmpdir(), 'murmur-dir-')) })
    store.applyCompaction('knows jazz', 0)
    store.recordEvent('topic', 'rain')
    store.recordEvent('topic', 'coffee')
    const { brain, director } = setup({ memory: store })
    brain.batches = [['a']]
    await director.run(1)
    const ctx = brain.talkContexts.at(-1)!
    // Dated on load by the spec 05-01 §3.3 post-pass.
    expect(ctx.profile).toContain('knows jazz')
    expect(ctx.coveredTopics).toEqual(['rain', 'coffee'])
    expect(SCENES).toContain(ctx.scene)
  })

  it('ledgers a beat topic at air time; untagged beats ledger nothing', async () => {
    const { brain, memory, director } = setup()
    brain.batches = [[{ text: 'tagged', topic: 'night walks' }, { text: 'plain' }]]
    await director.run(2)
    expect(memory.recentTopics(10)).toEqual(['night walks'])
    expect(memory.recent(10).map((t) => t.text)).toEqual(['tagged', 'plain'])
  })

  it('pokes the compactor once per segment boundary', async () => {
    const pokes: number[] = []
    const compactor = { maybeSchedule: () => (pokes.push(1), false) }
    const { brain, director } = setup({ compactor })
    brain.batches = [['a', 'b'], ['c']]
    await director.run(3)
    expect(pokes.length).toBe(3)
  })
})

describe('Director — quit', () => {
  it('/quit during playback stops the clip and exits cleanly', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('/quit')
    await run
    expect(player.stops).toBeGreaterThanOrEqual(1)
    expect(host.radio).toEqual(['a'])
  })

  it('/quit answers instantly with the going-off line — teardown must not be silent', async () => {
    // The 3 seconds of voice/engine close are honest work; the lag the user
    // felt was the silence. The ack lands when the quit is HEARD.
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('/quit')
    await until(() => host.infos.some((m) => m.includes('going off the air')), 'the ack line')
    await run
  })

  it('requestQuit (Ctrl-C) prints the same going-off ack', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    director.requestQuit()
    await run
    expect(host.infos.some((m) => m.includes('going off the air'))).toBe(true)
  })

  it('/quit merged into a compose window quits without airing the reply', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    brain.respondDelayMs = 60
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    host.type('hi')
    await new Promise((r) => setTimeout(r, 10))
    host.type('/quit')
    await run
    expect(host.radio).toEqual(['a']) // no reply aired
    // The merged path is still a quit someone typed: it acks like the rest.
    expect(host.infos.some((m) => m.includes('going off the air'))).toBe(true)
  })

  it('a line typed during the gap gets a reply, then the program moves on', async () => {
    // A long gap makes the sequencing deterministic: the line always lands
    // inside the gap, and the steer aborts the remaining sleep. Batch 2 feeds
    // the background refill the steer discards; batch 3 airs post-reply.
    const { brain, host, director } = setup({ gapSeconds: 3 })
    brain.batches = [['a'], ['bg'], ['b']]
    const run = director.run(2)
    await until(() => host.radio.length === 1, 'first segment')
    host.type('hey')
    await until(() => host.radio.includes('re:hey'), 'gap reply aired')
    await until(() => host.radio.includes('b'), 'program resumed')
    await run
    expect(host.radio).toEqual(['a', 're:hey', 'b'])
  })

  it('requestQuit stops the loop between segments', async () => {
    const { brain, player, host, director } = setup()
    brain.batches = [['a']]
    player.auto = false
    const run = director.run()
    await until(() => player.played.length === 1, 'clip on air')
    director.requestQuit()
    player.finish()
    await run
    expect(host.radio).toEqual(['a'])
  })
})

// spec 10 §2.1/§3.2-D: what the Director tells a front-end with a status
// region. Pushed at boundaries, never polled — and no host is required to care.
describe('Director — program state (spec 10)', () => {
  it('announces each talk segment as it airs, with the scene', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a']]
    await director.run(1)
    const talk = host.states.filter((s) => s.kind === 'talk')
    expect(talk).toHaveLength(1)
    expect(SCENES).toContain(talk[0]!.scene)
  })

  it('marks the gap between segments so the strip does not claim to be talking', async () => {
    const { brain, host, director } = setup()
    brain.batches = [['a', 'b']]
    await director.run(2)
    expect(host.states.map((s) => s.kind)).toEqual(['talk', 'gap', 'talk'])
  })

  it('a host with no status region is untouched (onState is optional)', async () => {
    const { brain, host, director } = setup()
    // The pre-spec-10 shape: a Host that never implemented onState.
    delete (host as Partial<FakeHost>).onState
    brain.batches = [['a']]
    await expect(director.run(1)).resolves.toBeUndefined()
    expect(host.radio).toEqual(['a'])
  })
})

// spec 12 §2.6/§3.9: the override reaches the model through the same live
// settings read every other hot knob uses — no restart, and persona.md is never
// touched, so clearing it hands the language back to the persona. Assertions are
// order-robust: the spec-04 look-ahead means a beat's brain call happens well
// before that beat airs, so call COUNTS are not a contract here.
describe('Director — the language override (spec 12 \u00a73.9)', () => {
  const said = (ctx: { persona: string }) => /Speak in Japanese\./.test(ctx.persona)

  it('rides on the persona only while it is set', async () => {
    const { brain, knobs, director } = setup()
    brain.batches = Array.from({ length: 12 }, (_, i) => [`talk ${i}`])
    const run = director.run(8)

    await until(() => brain.talkContexts.length >= 1, 'the first brain call')
    expect(brain.talkContexts.every((c) => c.persona === 'p')).toBe(true)

    knobs.language = 'Japanese'
    await until(() => brain.talkContexts.some(said), 'the override reached a brain call')

    // Clearing is pinned where it lives: withLanguage(persona, undefined) in
    // prompts.test.ts and the store's erase in settings.test.ts. Re-proving it
    // here would only buy a race against the look-ahead.
    await run
  })
})
