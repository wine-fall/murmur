import { describe, expect, it } from 'vitest'

import {
  cliConversation,
  cliPermission,
  escPulse,
  formatToolResult,
  lineReader,
  quitLatch,
} from '../src/guide.ts'
import type { AskKind, Host } from '../src/host.ts'

// A host with scripted keyboard lines (the same stdin the Director uses).
// atEof simulates a closed stdin (non-interactive run): no lines, ever.
// `docked` gives it a question surface (the TUI dock, spec 10 §3.2-B); without
// one, questions fall back to info like the plain host.
function fakeHost(
  lines: string[] = [],
  { atEof = false, docked = false } = {},
): {
  host: Host
  infos: string[]
  asks: { text: string; kind: AskKind }[]
  echoed: string[]
  busy: boolean[]
} {
  const infos: string[] = []
  const asks: { text: string; kind: AskKind }[] = []
  const echoed: string[] = []
  const busy: boolean[] = []
  const host: Host = {
    start: () => {},
    peekLine: () => (lines.length > 0 ? Promise.resolve(lines[0]!) : new Promise(() => {})),
    takeLine: () => lines.shift(),
    eof: () => (atEof ? Promise.resolve() : new Promise(() => {})),
    onRadioSegment: () => {},
    onUserLine: (text) => void echoed.push(text),
    info: (m) => void infos.push(m),
    banner: () => {},
    setBusy: (on) => void busy.push(on),
  }
  if (docked) host.ask = (text, kind) => void asks.push({ text, kind })
  return { host, infos, asks, echoed, busy }
}

const askOptions = {
  signal: new AbortController().signal,
  toolUseID: 'tool-use-1',
  requestId: 'request-1',
}

describe('lineReader (codex-review regressions)', () => {
  it('EOF resolves reads as empty (= decline), so a non-interactive run never blocks', async () => {
    const { host } = fakeHost([], { atEof: true })
    const read = lineReader(host, quitLatch())
    expect(await read()).toBe('')
    expect(await read()).toBe('')
  })

  it('an esc pulse resolves the PENDING read as empty and re-arms — no quit, no fast-forward', async () => {
    // Esc is an event, not a state: it answers the read that was waiting and
    // nothing else — the next read hears the keyboard again (unlike the quit
    // latch, whose fast-forward is the app going away).
    const lines: string[] = []
    const { host } = fakeHost(lines)
    const quit = quitLatch()
    const esc = escPulse()
    const read = lineReader(host, quit, esc)
    const pending = read()
    await new Promise((r) => setImmediate(r)) // the read registers on a microtask
    esc.fire()
    expect(await pending).toBe('')
    lines.push('still talking')
    expect(await read()).toBe('still talking')
    expect(quit.requested).toBe(false)
  })

  it('an esc pulse fired with nobody waiting is dropped, never stored', async () => {
    const esc = escPulse()
    esc.fire() // lands while a guide turn runs — no read pending
    const lines: string[] = []
    const { host } = fakeHost(lines)
    const read = lineReader(host, quitLatch(), esc)
    lines.push('a real answer')
    expect(await read()).toBe('a real answer')
  })

  it('echoes the line it took, so a foreground conversation reads like one', async () => {
    // The front-end paints the program log from what the ENGINE reports
    // (spec 10 §3.3: segments + user lines + info) — the client never echoes
    // its own keystrokes. onUserLine was wired on the Director's path only, so
    // every answer typed to the guide or the first-run seeds vanished as it
    // was submitted: the user's own half of the conversation was invisible.
    const { host, echoed } = fakeHost(['fish.audio, I think'])
    const read = lineReader(host, quitLatch())
    expect(await read()).toBe('fish.audio, I think')
    expect(echoed).toEqual(['fish.audio, I think'])
  })

  it('never echoes a line read as a secret — the credential channel stays out of band', async () => {
    // The API key is read through this same reader (the tool's promptSecret,
    // spec 03-03 §7.2). An echo would put it on the wire as a `userLine`:
    // into the TUI's log, into the replay backlog a later attach receives,
    // and into the dev log — the exact places the secret channel exists to
    // keep it out of.
    const { host, echoed } = fakeHost(['sk-live-not-a-real-key'])
    const read = lineReader(host, quitLatch())
    expect(await read({ echo: false })).toBe('sk-live-not-a-real-key')
    expect(echoed).toEqual([])
  })

  it('echoes nothing when no line was typed (EOF, esc, the quit fast-forward)', async () => {
    // A read that resolves through some OTHER race arm has no keyboard line
    // behind it — an echo there would put words in the listener's mouth.
    const { host, echoed } = fakeHost([], { atEof: true })
    const read = lineReader(host, quitLatch())
    expect(await read()).toBe('')
    expect(echoed).toEqual([])
  })

  it('serializes concurrent reads: one typed line answers exactly one ask', async () => {
    // peek/take is the Director's race primitive — one line wakes every
    // waiter. Concurrent permission asks must each consume their OWN line.
    const { host } = fakeHost(['y', 'n'])
    const read = lineReader(host, quitLatch())
    const [first, second] = await Promise.all([read(), read()])
    expect(first).toBe('y')
    expect(second).toBe('n')
  })

  it('/quit mid-onboarding fires the latch and fast-forwards every later read (the exit that was impossible)', async () => {
    // Ctrl-C in the TUI arrives as a typed /quit; the consuming reader used
    // to swallow it as an ANSWER, locking the user inside onboarding.
    const { host } = fakeHost(['/quit'])
    const quit = quitLatch()
    const read = lineReader(host, quit)
    expect(await read()).toBe('')
    expect(quit.requested).toBe(true)
    // No more scripted lines: without the latch this read would hang forever.
    expect(await read()).toBe('')
  })

  it('a quit latch already fired resolves reads instantly, like EOF', async () => {
    const { host } = fakeHost([])
    const quit = quitLatch()
    quit.fire()
    expect(await lineReader(host, quit)()).toBe('')
  })

  // A host whose lines can arrive AFTER a read already lost the race — the
  // shape behind the swallowed-quit defect: each read the latch (or EOF) had
  // already resolved left a pending peekLine callback behind, and when the
  // next line arrived that stale callback ran takeLine and destroyed it.
  function lateLineHost({ atEof = false } = {}): {
    host: Host
    lines: string[]
    wake: () => void
  } {
    const lines: string[] = []
    let wake: (() => void) | undefined
    const host: Host = {
      start: () => {},
      peekLine: () => new Promise((resolve) => (wake = () => resolve(lines[0]!))),
      takeLine: () => lines.shift(),
      eof: () => (atEof ? Promise.resolve() : new Promise(() => {})),
      onRadioSegment: () => {},
      onUserLine: () => {},
      info: () => {},
      banner: () => {},
    }
    return { host, lines, wake: () => wake?.() }
  }

  it('a line typed after the quit stays queued instead of being swallowed by a stale wake-up', async () => {
    const { host, lines, wake } = lateLineHost()
    const quit = quitLatch()
    const read = lineReader(host, quit)
    const pending = read()
    quit.fire()
    expect(await pending).toBe('')
    lines.push('/quit') // the second quit a stuck user types
    wake()
    await new Promise((resolve) => setImmediate(resolve))
    expect(lines).toEqual(['/quit']) // still there for whoever consumes next
  })

  it('a read resolved through EOF leaves a later line alone too (front-end detach/re-attach)', async () => {
    // The IpcHost fires eof when the front-end detaches and re-opens input on
    // re-attach: a read resolved by that eof must not leave a stale callback
    // armed to steal the first line the returning front-end sends.
    const { host, lines, wake } = lateLineHost({ atEof: true })
    const quit = quitLatch()
    const read = lineReader(host, quit)
    expect(await read()).toBe('') // resolved via the eof arm
    lines.push('/quit') // typed after a front-end re-attach
    wake()
    await new Promise((resolve) => setImmediate(resolve))
    expect(quit.requested).toBe(false) // the stale callback must not consume it
    expect(lines).toEqual(['/quit'])
  })
})

describe('cliPermission (spec 03-03 §3 — the entry authorization, no per-action asks)', () => {
  it("allows installs and writes without a question: the card's y was the consent", async () => {
    const { host, asks, infos } = fakeHost([], { docked: true })
    const permit = cliPermission(host, quitLatch())
    for (const [tool, input] of [
      ['Bash', { command: 'brew install yt-dlp' }],
      ['Bash', { command: 'curl -fsSL https://bun.sh/install | bash' }],
      ['Bash', { command: 'which -a yt-dlp; yt-dlp --version' }],
      ['Write', { file_path: '/tmp/x' }],
      ['Edit', { file_path: '/tmp/x' }],
      ['Read', { file_path: '/tmp/x' }],
      ['Glob', { pattern: '**/*.ts' }],
    ] as const) {
      expect(await permit(tool, input, askOptions)).toEqual({ behavior: 'allow' })
    }
    expect(asks).toEqual([]) // never a permission card
    expect(infos).toEqual([]) // and never a printed question either
  })

  it('a turn-abort halt denies the cut turn\'s calls — the belt behind interruptTurn', async () => {
    const { host } = fakeHost([])
    const result = await cliPermission(host, quitLatch(), () => true)('Bash', { command: 'ls' }, askOptions)
    expect(result).toMatchObject({ behavior: 'deny' })
  })

  it('keeps a dev-log record of everything it allowed', async () => {
    const debugs: string[] = []
    const { host } = fakeHost([])
    host.debug = (m) => void debugs.push(m)
    await cliPermission(host, quitLatch())('Bash', { command: 'brew install yt-dlp' }, askOptions)
    expect(debugs.join('\n')).toContain('brew install yt-dlp')
  })

  it('denies secret-bearing input outright, whatever the tool — with a reason the model can act on', async () => {
    // The one hard limit inside the authorization: a credential must never
    // enter the SDK transcript (spec 03-03 §7.2) — not the config files that
    // hold one, not a secret-shaped variable, not an environment dump.
    const { host, asks } = fakeHost([], { docked: true })
    const permit = cliPermission(host, quitLatch())
    for (const [tool, input] of [
      ['Read', { file_path: '/Users/zach/.murmur/voice.json' }],
      ['Read', { file_path: '/Users/zach/.personal/murmur/.env' }],
      ['Grep', { pattern: 'apiKey', path: '/Users/zach/.murmur/voice.json' }],
      ['Bash', { command: 'cat /Users/zach/.murmur/voice.json' }],
      ['Bash', { command: 'echo $MURMUR_TTS_API_KEY' }],
      ['Bash', { command: 'printenv OPENAI_API_KEY' }],
      ['Bash', { command: 'env | sort' }],
    ] as const) {
      const result = await permit(tool, input, askOptions)
      expect(result?.behavior, JSON.stringify(input)).toBe('deny')
      if (result?.behavior === 'deny') expect(result.message).toContain('credential')
    }
    expect(asks).toEqual([]) // denied, not asked about
  })

  it("murmur-owned tools are exempt: write_voice_config's needsApiKey is its design, not a leak", async () => {
    const { host } = fakeHost([])
    const result = await cliPermission(host, quitLatch())(
      'mcp__murmur__write_voice_config',
      { ttsUrl: 'https://api.fish.audio', needsApiKey: true },
      askOptions,
    )
    expect(result).toEqual({ behavior: 'allow' })
  })

  it('a fired quit latch denies — the session is being torn down', async () => {
    const quit = quitLatch()
    quit.fire()
    const { host } = fakeHost([])
    const result = await cliPermission(host, quit)('Bash', { command: 'ls' }, askOptions)
    expect(result).toMatchObject({ behavior: 'deny' })
  })
})

describe('cliConversation', () => {
  it('returns the typed reply; empty or /done or q ends it', async () => {
    const { host } = fakeHost(['  the quick fix please  ', '', '/done', 'Q'])
    const next = cliConversation(host, lineReader(host, quitLatch()), quitLatch())
    expect(await next()).toBe('the quick fix please')
    expect(await next()).toBeNull()
    expect(await next()).toBeNull()
    expect(await next()).toBeNull()
  })

  it('hands the busy light off with the keyboard: dark while it waits, lit while it works', async () => {
    // The guide's turns run a real model (and its WebFetch calls), which is
    // seconds of nothing on a screen that never moves — the same silence the
    // quit teardown was fixed for (spec 10 §3.4). The engine already knows
    // which side of the turn it is on; this is that knowledge on the wire.
    const { host, busy } = fakeHost(['use fish.audio'])
    const next = cliConversation(host, lineReader(host, quitLatch()), quitLatch())
    expect(await next()).toBe('use fish.audio')
    // Dark when the prompt opens (the listener is typing), lit again the
    // moment the reply is in and the guide has the turn back.
    expect(busy).toEqual([false, true])
  })

  it('does not relight the sign on the line that ENDS the conversation', async () => {
    // /done, an empty line, esc, EOF: no turn follows any of them, so a sign
    // lit here would burn through the SDK teardown and the closing re-probe
    // with nothing coming to clear it.
    const { host, busy } = fakeHost(['/done'])
    const next = cliConversation(host, lineReader(host, quitLatch()), quitLatch())
    expect(await next()).toBeNull()
    expect(busy).toEqual([false])
  })

  it('a fired quit latch ends the conversation without prompting for a reply', async () => {
    const { host, asks } = fakeHost([], { docked: true })
    const quit = quitLatch()
    quit.fire()
    const next = cliConversation(host, lineReader(host, quit), quit)
    expect(await next()).toBeNull()
    expect(asks).toEqual([])
  })

  it('keeps the reply prompt OUT of the dock — the conversation lives in the log and the input line', async () => {
    // A spotlight card reading only "your reply" carries no question — the
    // guide's actual words are in the log. The card is for onboarding
    // decisions; the per-turn prompt is an info line.
    const { host, asks, infos } = fakeHost(['sure'], { docked: true })
    const next = cliConversation(host, lineReader(host, quitLatch()), quitLatch())
    await next()
    expect(asks).toEqual([])
    expect(infos.join('\n')).toContain('/done')
  })

  it('marks the waiting window and resets the turn-abort flag each turn', async () => {
    // The Esc router reads these: waiting=true means Esc ends the conversation
    // (the guide is idle); turnAborted is a per-turn fact, cleared the moment a
    // new prompt opens (the next turn must not inherit a spent abort).
    const { host } = fakeHost([])
    const quit = quitLatch()
    const esc = escPulse()
    const flow = { waiting: false, turnAborted: true }
    const next = cliConversation(host, lineReader(host, quit, esc), quit, flow)
    const pending = next()
    await new Promise((r) => setImmediate(r))
    expect(flow.waiting).toBe(true)
    expect(flow.turnAborted).toBe(false) // reset by the new turn
    esc.fire()
    expect(await pending).toBeNull()
    expect(flow.waiting).toBe(false)
  })

  it('an esc while the guide waits ends the conversation — the Esc-Esc exit', async () => {
    const { host, infos } = fakeHost([])
    const quit = quitLatch()
    const esc = escPulse()
    const flow = { waiting: false, turnAborted: false }
    const next = cliConversation(host, lineReader(host, quit, esc), quit, flow)
    const pending = next()
    await new Promise((r) => setImmediate(r))
    esc.fire()
    expect(await pending).toBeNull()
    expect(quit.requested).toBe(false)
    expect(infos.join('\n')).toContain('/done') // the prompt named the exit before Esc took it
  })
})

// The visible face of a tool run (spec 03-03 bug fix): output indents under
// the "-> [tool]" line, long output keeps only the tail, errors are labeled.
describe('formatToolResult', () => {
  it('indents every line of a short result', () => {
    expect(formatToolResult('hello\nworld', false)).toBe('  hello\n  world')
  })

  it('an empty result still shows something', () => {
    expect(formatToolResult('   \n ', false)).toBe('  (no output)')
  })

  it('labels errors', () => {
    expect(formatToolResult('boom', true)).toBe('  [error]\n  boom')
  })

  it('keeps only the tail of a long result and says so', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const shown = formatToolResult(lines, false)
    expect(shown.split('\n')[0]).toBe('  ... (output trimmed, showing the tail)')
    expect(shown).toContain('  line 30')
    expect(shown).not.toContain('line 1\n')
    expect(shown.split('\n').length).toBe(13) // header + 12 tail lines
  })

  it('caps a single giant line by characters', () => {
    const shown = formatToolResult('x'.repeat(5000), false)
    expect(shown.split('\n')[0]).toBe('  ... (output trimmed, showing the tail)')
    expect(shown.length).toBeLessThan(1700)
  })
})
