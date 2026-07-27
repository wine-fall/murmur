import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { CliHost, LineQueue } from '../src/host.ts'

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
})
