// The client end of the wire (spec 10 §2.3). Pure socket plumbing — no OpenTUI,
// no React — so the fast layer can hold the one thing about it that is easy to
// get wrong and impossible to see: the ORDER of the first bytes.

import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decodeTuiMessage, ndjson, PROTOCOL, type TuiMessage } from '../src/ipc.ts'
import { connectEngine } from '../tui/src/wire.ts'

describe('connectEngine', () => {
  let dir: string
  let socketPath: string
  let server: Server
  let received: TuiMessage[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'murmur-wire-'))
    socketPath = join(dir, 'tui.sock')
    received = []
    server = createServer((socket) => {
      socket.setEncoding('utf8')
      const feed = ndjson((line) => {
        const message = decodeTuiMessage(line)
        if (message !== null) received.push(message)
      })
      socket.on('data', (chunk: string) => feed(chunk))
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  }

  it('puts the handshake on the wire before anything else the client says', async () => {
    // The engine drops every message that arrives before a valid attach (§2.3),
    // and the visualizer subscription is sent once, on mount. A socket flushes
    // writes queued during connect in ISSUE order, so an attach deferred to the
    // 'connect' event loses to a subscription issued a tick later — and the
    // spectrum strip stays blank for the whole session.
    const wire = connectEngine(socketPath, { onMessage: () => {}, onClose: () => {} })
    wire.send({ v: 1, type: 'vizSub', on: true })
    await settle()
    expect(received.map((m) => m.type)).toEqual(['attach', 'vizSub'])
    expect(received[0]).toEqual({ v: 1, type: 'attach', protocol: PROTOCOL })
    wire.close()
  })

  it('sends a submitted line as a line message', async () => {
    const wire = connectEngine(socketPath, { onMessage: () => {}, onClose: () => {} })
    wire.line('are you there')
    await settle()
    expect(received.at(-1)).toEqual({ v: 1, type: 'line', text: 'are you there' })
    wire.close()
  })

  it('reports a socket that was never there instead of throwing', async () => {
    const closed: string[] = []
    connectEngine(join(dir, 'no-engine-here.sock'), {
      onMessage: () => {},
      onClose: (reason) => void closed.push(reason),
    })
    await settle()
    expect(closed.length).toBeGreaterThan(0)
  })
})
