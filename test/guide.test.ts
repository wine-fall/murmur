import { describe, expect, it } from 'vitest'

import { cliConversation, cliPermission, lineReader } from '../src/guide.ts'
import type { Host } from '../src/host.ts'

// A host with scripted keyboard lines (the same stdin the Director uses).
// atEof simulates a closed stdin (non-interactive run): no lines, ever.
function fakeHost(lines: string[] = [], { atEof = false } = {}): { host: Host; infos: string[] } {
  const infos: string[] = []
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
  return { host, infos }
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
})
