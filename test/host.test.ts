import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { packageVersion } from '../src/config.ts'
import { ask, CliHost, LineQueue, type AskKind, type Host } from '../src/host.ts'

describe('LineQueue', () => {
  it('peek does not consume; take does', async () => {
    const q = new LineQueue()
    q.push('one')
    expect(await q.peek()).toBe('one')
    expect(await q.peek()).toBe('one')
    expect(q.take()).toBe('one')
    expect(q.take()).toBeUndefined()
  })

  it('a line typed while audio wins the race is not lost', async () => {
    const q = new LineQueue()
    // Race an "audio" promise against peek; audio wins, peek stays pending.
    const raced = await Promise.race([
      Promise.resolve('audio'),
      q.peek().then(() => 'line'),
    ])
    expect(raced).toBe('audio')
    // The line arrives later and is still there for the next consumer.
    q.push('kept')
    expect(await q.peek()).toBe('kept')
    expect(q.take()).toBe('kept')
  })

  it('wakes multiple waiters when a line arrives', async () => {
    const q = new LineQueue()
    const a = q.peek()
    const b = q.peek()
    q.push('x')
    expect(await a).toBe('x')
    expect(await b).toBe('x')
  })

  it('abandoned race losers share one pending promise (no waiter leak)', () => {
    // Regression (codex review): every race the Director loses must not add a
    // fresh waiter — an always-on idle run would grow one per segment/gap.
    const q = new LineQueue()
    const first = q.peek()
    for (let i = 0; i < 100; i++) expect(q.peek()).toBe(first)
  })
})

describe('ask', () => {
  function bareHost(): Host & { infos: string[] } {
    const infos: string[] = []
    return {
      infos,
      start: () => {},
      peekLine: () => new Promise(() => {}),
      takeLine: () => undefined,
      onRadioSegment: () => {},
      onUserLine: () => {},
      info: (m) => void infos.push(m),
      banner: () => {},
    }
  }

  it('routes to host.ask when the front-end has a question surface', () => {
    const asks: { text: string; kind: AskKind }[] = []
    const host = bareHost()
    host.ask = (text, kind) => void asks.push({ text, kind })
    ask(host, 'allow? [y/N]', 'consent')
    expect(asks).toEqual([{ text: 'allow? [y/N]', kind: 'consent' }])
    expect(host.infos).toEqual([])
  })

  it('falls back to info on a host without one (plain front-end)', () => {
    const host = bareHost()
    ask(host, 'what should I call you?', 'question')
    expect(host.infos).toEqual(['what should I call you?'])
  })
})

describe('CliHost', () => {
  it('reads lines from the input stream; EOF is not quit', async () => {
    const input = new PassThrough()
    const host = new CliHost(input)
    host.start()
    input.write('hello\n')
    expect(await host.peekLine()).toBe('hello')
    expect(host.takeLine()).toBe('hello')
    input.end() // EOF: no crash, no synthetic quit line
    await new Promise((r) => setTimeout(r, 10))
    expect(host.takeLine()).toBeUndefined()
  })

  it('signals EOF once the input ends (the guide declines instead of blocking)', async () => {
    const input = new PassThrough()
    const host = new CliHost(input)
    host.start()
    input.end()
    await host.eof() // resolves; a live stdin would keep this pending forever
  })

  it('mirrors program lines into the dev log in devwatch format', async () => {
    // `make logs` tails this file in a second terminal; each line must carry
    // the "HH:MM:SS LEVEL name:" prefix devwatch's level filter parses.
    const dir = await mkdtemp(join(tmpdir(), 'murmur-devlog-'))
    const devLog = join(dir, 'dev.log')
    try {
      const host = new CliHost(new PassThrough(), { devLog })
      host.info('checking music')
      host.onRadioSegment('hello there')
      host.onUserLine('hi back')
      // debug is dev-log-only (spec 04 §3.3 refill diagnostics): mirrored under
      // the director name, never printed to the console program.
      host.debug('talk.refill need=1')
      const lines = (await readFile(devLog, 'utf8')).trimEnd().split('\n')
      expect(lines).toHaveLength(4)
      expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO host: checking music$/)
      expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2} INFO radio: hello there$/)
      expect(lines[2]).toMatch(/^\d{2}:\d{2}:\d{2} INFO user: hi back$/)
      expect(lines[3]).toMatch(/^\d{2}:\d{2}:\d{2} INFO director: talk\.refill need=1$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes no dev log when the knob is unset', () => {
    const host = new CliHost(new PassThrough())
    host.info('quiet') // must not throw or create files
  })

  it('names its own version in the banner (the bug form asks for it)', () => {
    const host = new CliHost(new PassThrough())
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    try {
      host.banner('a night host', { brain: 'stub', voice: 'stub' })
    } finally {
      log.mockRestore()
    }
    expect(lines.join('\n')).toContain(`v${packageVersion()}`)
  })
})
