// The client end of the wire (spec 10 §2.3). The schemas are NOT redefined
// here: they are imported from the engine's src/ipc.ts, which is the single
// source of truth for the protocol. This file is only the socket plumbing.

import { connect, type Socket } from 'node:net'

import {
  decodeEngineMessage,
  encode,
  ndjson,
  PROTOCOL,
  type EngineMessage,
  type TuiMessage,
} from '../../src/ipc.ts'

export type Wire = {
  send: (message: TuiMessage) => void
  line: (text: string) => void
  close: () => void
}

export type WireHandlers = {
  onMessage: (message: EngineMessage) => void
  // The engine went away (or was never there). The front-end has nothing left
  // to render; the radio, if it is still running, does not care.
  onClose: (reason: string) => void
}

export function connectEngine(socketPath: string, handlers: WireHandlers): Wire {
  const socket: Socket = connect(socketPath)
  socket.setEncoding('utf8')
  const feed = ndjson((line) => {
    const message = decodeEngineMessage(line)
    // Unknown or malformed: dropped, exactly as the engine drops ours. A newer
    // engine's additions must never take the face down.
    if (message !== null) handlers.onMessage(message)
  })
  socket.on('connect', () => socket.write(encode({ v: 1, type: 'attach', protocol: PROTOCOL })))
  socket.on('data', (chunk: string) => feed(chunk))
  socket.on('error', (err) => handlers.onClose(String(err)))
  socket.on('close', () => handlers.onClose('engine closed the connection'))
  const send = (message: TuiMessage): void => {
    if (!socket.destroyed) socket.write(encode(message))
  }
  return {
    send,
    line: (text) => send({ v: 1, type: 'line', text }),
    close: () => socket.destroy(),
  }
}
