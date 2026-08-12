import { describe, expect, it } from 'vitest'

import {
  cliConversation,
  cliPermission,
  isReadOnlyCommand,
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
): { host: Host; infos: string[]; asks: { text: string; kind: AskKind }[] } {
  const infos: string[] = []
  const asks: { text: string; kind: AskKind }[] = []
  const host: Host = {
    start: () => {},
    peekLine: () => (lines.length > 0 ? Promise.resolve(lines[0]!) : new Promise(() => {})),
    takeLine: () => lines.shift(),
    eof: () => (atEof ? Promise.resolve() : new Promise(() => {})),
    onRadioSegment: () => {},
    onUserLine: () => {},
    info: (m) => void infos.push(m),
    banner: () => {},
  }
  if (docked) host.ask = (text, kind) => void asks.push({ text, kind })
  return { host, infos, asks }
}

const askOptions = {
  signal: new AbortController().signal,
  toolUseID: 'tool-use-1',
  requestId: 'request-1',
}

describe('lineReader (codex-review regressions)', () => {
  it('EOF resolves reads as empty (= decline), so a non-interactive run never blocks', async () => {
    const { host } = fakeHost([], { atEof: true })
    const read = lineReader(host)
    expect(await read()).toBe('')
    expect(await read()).toBe('')
  })

  it('serializes concurrent reads: one typed line answers exactly one ask', async () => {
    // peek/take is the Director's race primitive — one line wakes every
    // waiter. Concurrent permission asks must each consume their OWN line.
    const { host } = fakeHost(['y', 'n'])
    const read = lineReader(host)
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
})

describe('cliPermission (spec 03-03 §2 — route the ask, never own the semantics)', () => {
  it('prints the tool and its command, y allows', async () => {
    const { host, infos } = fakeHost(['y'])
    const ask = cliPermission(host, lineReader(host))
    const result = await ask('Bash', { command: 'brew install yt-dlp' }, askOptions)
    expect(result).toEqual({ behavior: 'allow' })
    expect(infos.join('\n')).toContain('Bash')
    expect(infos.join('\n')).toContain('brew install yt-dlp')
  })

  it('anything but yes denies (the default is NO)', async () => {
    const { host } = fakeHost([''])
    const ask = cliPermission(host, lineReader(host))
    const result = await ask('Write', { file_path: '/etc/hosts' }, askOptions)
    expect(result).toMatchObject({ behavior: 'deny' })
  })

  it('docks the whole consent — tool, command, and the y/N — as ONE ask', async () => {
    // The dock replaces the log's adjacency, so the question it pins must be
    // self-contained: an "allow?" with the command left behind in the log
    // would ask the user to approve something they cannot see.
    const { host, asks, infos } = fakeHost(['y'], { docked: true })
    const ask = cliPermission(host, lineReader(host))
    await ask('Bash', { command: 'brew install yt-dlp' }, askOptions)
    expect(asks).toHaveLength(1)
    expect(asks[0]!.kind).toBe('consent')
    expect(asks[0]!.text).toContain('Bash')
    expect(asks[0]!.text).toContain('brew install yt-dlp')
    expect(asks[0]!.text).toContain('[y/N]')
    expect(infos).toEqual([])
  })
})

// The card's 'y' already covered LOOKING (the user asked to be walked through
// a fix); what still needs per-action consent is CHANGE. Pure investigation
// flows without another ask — a wall of y/N for `which` and `--version` reads
// as noise and buries the one confirm that matters.
describe('cliPermission — read-only investigation flows without asking (spec 03-03 §7.1)', () => {
  it('auto-allows the diagnostics the guide actually runs, without touching the keyboard', async () => {
    // No scripted lines: if any of these asked, the read would hang the test.
    const { host, asks } = fakeHost([], { docked: true })
    const ask = cliPermission(host, lineReader(host))
    for (const command of [
      'which -a yt-dlp; echo "---"; yt-dlp --version; echo "---"; ls -l "$(which yt-dlp)"',
      'echo "exit: $?"; echo "---"; brew info yt-dlp | head -5',
      'uv tool list && pipx list',
      'ffmpeg -version',
      'brew --prefix && brew list --versions yt-dlp',
    ]) {
      expect(await ask('Bash', { command }, askOptions)).toEqual({ behavior: 'allow' })
    }
    expect(asks).toEqual([])
  })

  it('secret-bearing reads stay behind consent, whatever the tool (codex review)', async () => {
    // The out-of-band secret flow (§7.2) exists so credentials never enter the
    // SDK transcript; an auto-allowed read of the config or the env would put
    // them there without anyone agreeing to it.
    const { host, asks } = fakeHost(['', '', '', ''], { docked: true })
    const ask = cliPermission(host, lineReader(host))
    for (const [tool, input] of [
      ['Bash', { command: 'echo $MURMUR_TTS_API_KEY' }],
      ['Read', { file_path: '/Users/zach/.murmur/voice.json' }],
      ['Read', { file_path: '/Users/zach/.personal/murmur/.env' }],
      ['Grep', { pattern: 'apiKey', path: '/Users/zach/.murmur/voice.json' }],
    ] as const) {
      expect(await ask(tool, input, askOptions)).toMatchObject({ behavior: 'deny' })
    }
    expect(asks).toHaveLength(4)
  })

  it('read-only builtins pass without a question; Write and Edit still ask', async () => {
    const { host, asks } = fakeHost(['n'], { docked: true })
    const ask = cliPermission(host, lineReader(host))
    expect(await ask('Read', { file_path: '/tmp/x' }, askOptions)).toEqual({ behavior: 'allow' })
    expect(await ask('Glob', { pattern: '**/*.ts' }, askOptions)).toEqual({ behavior: 'allow' })
    expect(await ask('Grep', { pattern: 'x' }, askOptions)).toEqual({ behavior: 'allow' })
    expect(asks).toEqual([])
    expect(await ask('Write', { file_path: '/tmp/x' }, askOptions)).toMatchObject({
      behavior: 'deny',
    })
    expect(asks).toHaveLength(1)
  })

  it('anything that can mutate still asks: the consent stays on the change', async () => {
    const { host, infos } = fakeHost(['y', ''])
    const ask = cliPermission(host, lineReader(host))
    expect(await ask('Bash', { command: 'brew upgrade yt-dlp' }, askOptions)).toEqual({
      behavior: 'allow',
    })
    expect(await ask('Bash', { command: 'brew install ffmpeg' }, askOptions)).toMatchObject({
      behavior: 'deny',
    })
    expect(infos.join('\n')).toContain('brew upgrade yt-dlp')
  })
})

describe('isReadOnlyCommand — the conservative classifier', () => {
  it('refuses unknown heads, redirects, chained mutations, and mutating substitutions', () => {
    for (const command of [
      'brew upgrade yt-dlp',
      'rm -rf /tmp/x',
      'echo hi > /tmp/x', // a redirect writes
      'ls $(curl example.com)', // unknown head inside $()
      'which yt-dlp && brew upgrade yt-dlp', // one bad segment poisons the chain
      'ls & rm -rf /tmp/x', // a single & backgrounds; the second head must be seen
      'yt-dlp https://example.com', // beyond --version, yt-dlp downloads
      'echo `rm -rf /tmp/x`', // backticks are substitution too
      '', // nothing is not a read
      'brew outdated yt-dlp', // brew auto-updates its own metadata first (codex review)
      'echo $MURMUR_TTS_API_KEY', // env expansion can surface a credential (codex review)
      'ls "$HOME/.murmur"', // same: parameter expansion is not provably a read
      'cat voice.json', // the secret-bearing config never auto-reads
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false)
    }
  })

  it('accepts version reads and package queries', () => {
    for (const command of [
      'yt-dlp --version',
      'ffmpeg -version',
      'brew list',
      'brew --prefix',
      'pwd',
      'uname -a',
      'command -v yt-dlp',
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true)
    }
  })
})

describe('cliConversation', () => {
  it('returns the typed reply; empty or /done or q ends it', async () => {
    const { host } = fakeHost(['  the quick fix please  ', '', '/done', 'Q'])
    const next = cliConversation(host, lineReader(host))
    expect(await next()).toBe('the quick fix please')
    expect(await next()).toBeNull()
    expect(await next()).toBeNull()
    expect(await next()).toBeNull()
  })

  it('docks the reply prompt as a question', async () => {
    const { host, asks } = fakeHost(['sure'], { docked: true })
    const next = cliConversation(host, lineReader(host))
    await next()
    expect(asks).toEqual([{ text: expect.stringContaining('/done'), kind: 'question' }])
  })
})
