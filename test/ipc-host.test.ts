import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcHost } from '../src/ipc-host.ts'
import { PROTOCOL, decodeEngineMessage, encode, ndjson, type EngineMessage } from '../src/ipc.ts'

// A stand-in TUI: the fast layer proves the bridge, never a rendered frame.
class FakeClient {
  readonly received: EngineMessage[] = []
  private socket: Socket

  private constructor(socket: Socket) {
    this.socket = socket
    const feed = ndjson((line) => {
      const message = decodeEngineMessage(line)
      if (message !== null) this.received.push(message)
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => feed(chunk))
    socket.on('error', () => {})
  }

  static async open(path: string): Promise<FakeClient> {
    const socket = connect(path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return new FakeClient(socket)
  }

  send(text: string): void {
    this.socket.write(text)
  }

  attach(protocol = PROTOCOL): void {
    this.send(encode({ v: 1, type: 'attach', protocol }))
  }

  line(text: string): void {
    this.send(encode({ v: 1, type: 'line', text }))
  }

  close(): void {
    this.socket.destroy()
  }

  types(): string[] {
    return this.received.map((m) => m.type)
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  }
}

describe('IpcHost (spec 10 §2.1/§2.3)', () => {
  let dir: string
  let socketPath: string
  let host: IpcHost
  let clients: FakeClient[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'murmur-ipc-'))
    socketPath = join(dir, 'tui.sock')
    clients = []
    host = new IpcHost({ socketPath, identity: { brain: 'stub', voice: 'stub' } })
    await host.listen()
  })

  afterEach(async () => {
    for (const client of clients) client.close()
    await host.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function client(): Promise<FakeClient> {
    const c = await FakeClient.open(socketPath)
    clients.push(c)
    return c
  }

  it('greets an attaching client with hello', async () => {
    const c = await client()
    c.attach()
    await c.settle()
    expect(c.received[0]).toEqual({
      v: 1,
      type: 'hello',
      protocol: PROTOCOL,
      persona: '',
      brain: 'stub',
      voice: 'stub',
    })
  })

  it('replays the program the listener missed before attaching', async () => {
    // The first-run questions and preflight notices are emitted BEFORE the TUI
    // finishes booting (spec 10 §3.2-B); losing them would strand the Q&A.
    host.info('checking yt-dlp...')
    host.banner('a night host', { brain: 'stub', voice: 'stub' })
    host.onRadioSegment('good evening.')
    const c = await client()
    c.attach()
    await c.settle()
    expect(c.types()).toEqual(['hello', 'info', 'hello', 'segment'])
    expect(c.received.at(-1)).toEqual({ v: 1, type: 'segment', text: 'good evening.' })
    expect(c.received[2]).toMatchObject({ type: 'hello', persona: 'a night host' })
  })

  it('broadcasts program, echo, notices and state to the attached client', async () => {
    const c = await client()
    c.attach()
    await c.settle()
    host.onRadioSegment('a segment')
    host.onUserLine('a reply')
    host.info('a notice')
    host.onState({ kind: 'music', nowPlaying: 'a song', awaitingReply: false })
    host.debug?.('look-ahead depth=2')
    await c.settle()
    expect(c.types()).toEqual(['hello', 'segment', 'userLine', 'info', 'state'])
    // Diagnostics stay out of the TUI (spec 10 §3.9): debug never hits the wire.
    expect(c.received.some((m) => m.type === 'segment' && m.text.includes('depth'))).toBe(false)
  })

  it('feeds a submitted line into the same queue the CLI host uses', async () => {
    const c = await client()
    c.attach()
    await c.settle()
    c.line('are you there')
    expect(await host.peekLine()).toBe('are you there')
    expect(host.takeLine()).toBe('are you there')
    expect(host.takeLine()).toBeUndefined()
  })

  it('ignores traffic from a client that has not attached', async () => {
    const c = await client()
    c.line('too early')
    await c.settle()
    expect(host.takeLine()).toBeUndefined()
  })

  it('turns away a client speaking another protocol version', async () => {
    const c = await client()
    c.attach(PROTOCOL + 1)
    await c.settle()
    expect(c.types()).toEqual(['bye'])
    c.line('ignored')
    await c.settle()
    expect(host.takeLine()).toBeUndefined()
  })

  it('drops malformed and unknown lines without dying', async () => {
    const c = await client()
    c.attach()
    c.send('{not json\n')
    c.send(`${JSON.stringify({ v: 1, type: 'fromTheFuture' })}\n`)
    c.line('still works')
    await c.settle()
    expect(await host.peekLine()).toBe('still works')
  })

  it('keeps broadcasting when the front-end dies, and accepts a fresh attach', async () => {
    const first = await client()
    first.attach()
    await first.settle()
    first.close()
    await first.settle()
    // The radio plays on: broadcasting into the void must not throw.
    expect(() => host.onRadioSegment('nobody is watching')).not.toThrow()
    const second = await client()
    second.attach()
    await second.settle()
    host.onRadioSegment('someone came back')
    await second.settle()
    expect(second.received[0]).toMatchObject({ type: 'hello' })
    expect(second.received.at(-1)).toEqual({ v: 1, type: 'segment', text: 'someone came back' })
  })

  it('resolves eof when the front-end goes away, so a Q&A read declines instead of wedging', async () => {
    const c = await client()
    c.attach()
    await c.settle()
    let ended = false
    void host.eof().then(() => (ended = true))
    c.close()
    await c.settle()
    expect(ended).toBe(true)
  })

  it('says bye and leaves no socket file behind on close', async () => {
    const c = await client()
    c.attach()
    await c.settle()
    await host.close()
    await c.settle()
    expect(c.types().at(-1)).toBe('bye')
    expect(existsSync(socketPath)).toBe(false)
  })

  it('takes over a socket file left by a crashed run', async () => {
    await host.close()
    writeFileSync(socketPath, 'stale')
    const fresh = new IpcHost({ socketPath, identity: { brain: 'stub', voice: 'stub' } })
    await fresh.listen()
    const c = await FakeClient.open(socketPath)
    clients.push(c)
    c.attach()
    await c.settle()
    expect(c.types()).toEqual(['hello'])
    await fresh.close()
  })
})
