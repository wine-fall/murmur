// The engine side of the TUI split (spec 10 §2.1/§2.3): a Host that speaks over
// a unix socket instead of a terminal.
//
// It is deliberately a THIN bridge. Host calls serialize onto the wire; lines
// arriving from the front-end feed the same LineQueue the CLI host uses, so the
// Director's peek/take race and the guide's consuming reader keep working
// untouched. No rendering decision lives here — that is the client's whole job.
//
// The radio outlives its face (§3.5): a front-end that dies takes nothing with
// it, the engine keeps broadcasting into the void, and a fresh attach is
// accepted at any time.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { devLogMirror, LineQueue, type AskKind, type FloorMode, type Host, type InfoTone } from './host.ts'
import {
  COMMANDS,
  decodeTuiMessage,
  encode,
  ndjson,
  PROTOCOL,
  type EngineMessage,
  type ProgramState,
  type SettingsPatch,
  type SettingsSnapshot,
} from './ipc.ts'
import { statusMicrocopy } from './prompts.ts'

// What a client that attaches mid-run is handed so it does not open on a blank
// screen — and so the first-run/guide questions asked while it was still
// booting are not lost (§3.2-B). Bounded: this is a courtesy backlog, not a
// transcript (the program log's real home is memory, spec 05).
const REPLAY_MAX = 200

// How long shutdown waits for the client's socket to close before forcing it.
// Quitting must never hang on a wedged front-end (§5.8: no orphans).
const CLOSE_GRACE_MS = 300

export type IpcHostOptions = {
  socketPath: string
  identity: { brain: string; voice: string }
  devLog?: string | undefined
}

// How the host reaches the settings authority (spec 12 §2.5): a snapshot thunk
// for the wire, and the store's set() for inbound patches. Wired by the app
// after the store exists — like the viz subscriber, the client can attach first.
export type SettingsBridge = {
  snapshot: () => SettingsSnapshot
  apply: (patch: SettingsPatch) => boolean
}

export class IpcHost implements Host {
  private queue = new LineQueue()
  private server: Server | null = null
  private client: Socket | null = null
  private sockets = new Set<Socket>()
  private replay: EngineMessage[] = []
  private pendingAsks: Extract<EngineMessage, { type: 'ask' }>[] = []
  private persona = ''
  private away: number | undefined
  private opts: IpcHostOptions
  private vizSubscriber: ((on: boolean, fps: number | undefined) => void) | null = null
  private vizWanted: { on: boolean; fps: number | undefined } | null = null
  private settingsBridge: SettingsBridge | null = null
  private interruptHandler: (() => void) | null = null
  private mode: FloorMode = 'radio'
  private mirror: (name: string, message: string) => void
  private markEof!: () => void
  private eofSeen: Promise<void>

  constructor(opts: IpcHostOptions) {
    this.opts = opts
    this.mirror = devLogMirror(opts.devLog ?? process.env.MURMUR_DEV_LOG)
    this.eofSeen = new Promise((resolve) => (this.markEof = resolve))
  }

  // Bind the socket. Called before the engine starts talking, so nothing the
  // startup checks or first run emit is spoken into a socket that is not there.
  async listen(): Promise<void> {
    const path = this.opts.socketPath
    mkdirSync(dirname(path), { recursive: true })
    // A crashed run leaves the socket file behind and bind would fail on it.
    // ponytail: unconditional unlink — a second engine takes over the NAME
    // only; an already-attached client keeps its connection to the first.
    if (existsSync(path)) await unlink(path).catch(() => {})
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      server.once('error', onError)
      server.listen(path, () => {
        server.off('error', onError)
        resolve()
      })
    })
    server.on('error', (err) => this.mirror('tui', `socket error: ${String(err)}`))
    this.server = server
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let attached = false
    const feed = ndjson((line) => {
      const message = decodeTuiMessage(line)
      if (message === null) {
        this.mirror('tui', 'dropped an unreadable line from the front-end')
        return
      }
      if (message.type === 'attach') {
        if (message.protocol !== PROTOCOL) {
          this.mirror('tui', `front-end speaks protocol ${message.protocol}; turning it away`)
          socket.end(encode({ v: 1, type: 'bye' }))
          return
        }
        attached = true
        this.adopt(socket)
        return
      }
      // Everything before a valid attach is noise from a peer we have not
      // agreed a protocol with.
      if (!attached) return
      if (message.type === 'line') {
        // Commands are diagnostics-worthy (quit latency, menu picks). Chat
        // and ask answers stay out of the log — an answer may be a pasted
        // secret (spec 03-03 §7.2), and a leading slash alone is not a
        // command: only the engine's own grammar (COMMANDS) qualifies.
        const trimmed = message.text.trim()
        if (COMMANDS.some((c) => trimmed === c.name || trimmed.startsWith(`${c.name} `))) {
          this.mirror('tui', `command received: ${trimmed}`)
        }
        // The oldest pending ask is what this line answers, if any is —
        // lineReader consumes in exactly this order.
        this.pendingAsks.shift()
        this.queue.push(message.text)
      }
      if (message.type === 'interrupt') {
        // Esc from the front-end: stop the registered flow and bury its
        // pending questions — engine-side here, client-side via askDrop. With
        // no flow registered (first-run seeds, the broadcast) it is noise:
        // the cards must stand for the reader still waiting on them.
        if (this.interruptHandler !== null) {
          this.mirror('tui', 'interrupt received: stopping the running flow')
          this.pendingAsks = []
          // Straight to the client, NOT send(): askDrop is a live moment, and
          // the replay backlog must not close a future attach's fresh cards.
          if (this.client !== null) this.write(this.client, { v: 1, type: 'askDrop' })
          this.interruptHandler()
        } else {
          this.mirror('tui', 'interrupt received with no flow to stop; ignored')
        }
      }
      if (message.type === 'vizSub') this.wantViz(message.on, message.fps)
      if (message.type === 'settingsSet') {
        // A successful set is broadcast by the store's own change event (the
        // app wires onChange -> sendSettings); the host answers only what
        // would otherwise go silent, so the pane always converges on truth.
        const applied = this.settingsBridge?.apply(message.patch) ?? false
        if (!applied) this.sendSettings()
      }
    })
    socket.on('data', (chunk: string) => feed(chunk))
    // A front-end that vanished mid-write is not an engine problem.
    socket.on('error', () => {})
    socket.on('close', () => {
      this.sockets.delete(socket)
      if (this.client !== socket) return
      this.client = null
      this.mirror('tui', 'front-end detached; the radio plays on')
      // A front-end that is gone is a front-end that is not watching: the
      // visualizer stops computing frames without waiting to be told (§3.6).
      this.wantViz(false, undefined)
      // No more input will come from a front-end that is gone: a consuming
      // reader (guide / first run) declines instead of wedging, exactly as it
      // does on stdin EOF. A later attach re-opens input; eof is one-shot.
      // Every pending question just got declined with it — nothing to replay.
      this.pendingAsks = []
      this.markEof()
    })
  }

  private adopt(socket: Socket): void {
    if (this.client !== null && this.client !== socket) this.client.end()
    this.client = socket
    this.write(socket, { v: 1, type: 'hello', ...this.greeting() })
    for (const message of this.replay) this.write(socket, message)
    // Only the questions still awaiting an answer, oldest first (§3.2-B).
    for (const message of this.pendingAsks) this.write(socket, message)
    // Every attach gets a fresh snapshot (spec 12 §2.5) — which is exactly why
    // snapshots stay out of the replay backlog above. The floor mode rides in
    // `hello` for the same reason: current state, never replay.
    this.sendSettings()
  }

  // The handshake payload, built in one place so a client that attaches late
  // learns the same identity — and the same absence (§3.7.3) — as the first one.
  private greeting(): Omit<Extract<EngineMessage, { type: 'hello' }>, 'v' | 'type'> {
    return {
      protocol: PROTOCOL,
      persona: this.persona,
      ...this.opts.identity,
      ...(this.away !== undefined && { away: this.away }),
      ...(this.mode !== 'radio' && { mode: this.mode }),
    }
  }

  private write(socket: Socket, message: EngineMessage): void {
    if (socket.destroyed) return
    socket.write(encode(message))
  }

  private send(message: EngineMessage): void {
    this.replay.push(message)
    if (this.replay.length > REPLAY_MAX) this.replay.shift()
    if (this.client !== null) this.write(this.client, message)
  }

  // Who to tell when a front-end subscribes to (or drops) the spectrum feed
  // (§3.6). Set after construction because the audio engine the feed taps is
  // built later than the host that carries its frames — and the client is
  // spawned before that, so it can subscribe while this is still null.
  setVizSubscriber(subscriber: (on: boolean, fps: number | undefined) => void): void {
    this.vizSubscriber = subscriber
    // Honor a subscription that beat the engine here. The client asks exactly
    // once, on mount, so dropping it would leave the strip dead for the session.
    if (this.vizWanted !== null) subscriber(this.vizWanted.on, this.vizWanted.fps)
  }

  // The latest thing an attached front-end asked for, remembered so it survives
  // arriving before the feed exists.
  private wantViz(on: boolean, fps: number | undefined): void {
    this.vizWanted = { on, fps }
    this.vizSubscriber?.(on, fps)
  }

  // One FFT frame. Deliberately NOT through send(): the replay backlog exists so
  // a booting client still sees the questions it was asked (§2.3), and spectrum
  // frames would both flood it out and be meaningless by the time they arrived.
  sendViz(bins: number[]): void {
    if (this.client !== null) this.write(this.client, { v: 1, type: 'viz', bins })
  }

  setSettings(bridge: SettingsBridge): void {
    this.settingsBridge = bridge
  }

  // The current snapshot, straight to the attached client — also NOT through
  // send(): an attach is answered with a fresh one, so a replayed stale copy
  // could only ever arrive after (and contradict) it.
  sendSettings(opts: { open?: boolean } = {}): void {
    if (this.settingsBridge === null || this.client === null) return
    this.write(this.client, {
      v: 1,
      type: 'settings',
      ...this.settingsBridge.snapshot(),
      ...(opts.open === true && { open: true as const }),
    })
  }

  // A typed /settings (spec 12 §3.6): the Director asks, the pane opens.
  showSettings(): void {
    this.sendSettings({ open: true })
  }

  // --- Host ---------------------------------------------------------------- //

  start(): void {}

  eof(): Promise<void> {
    return this.eofSeen
  }

  peekLine(): Promise<string> {
    return this.queue.peek()
  }

  takeLine(): string | undefined {
    return this.queue.take()
  }

  banner(personaFirstLine: string, opts: { brain: string; voice: string; away?: number }): void {
    const { away, ...identity } = opts
    this.persona = personaFirstLine
    this.opts.identity = identity
    this.away = away
    this.send({ v: 1, type: 'hello', ...this.greeting() })
  }

  onRadioSegment(text: string): void {
    this.send({ v: 1, type: 'segment', text })
    this.mirror('radio', text)
  }

  onUserLine(text: string): void {
    this.send({ v: 1, type: 'userLine', text })
    this.mirror('user', text)
  }

  info(message: string, tone?: InfoTone): void {
    this.send({ v: 1, type: 'info', text: message, ...(tone !== undefined && { tone }) })
    this.mirror('host', message)
  }

  // A marked question (spec 10 §3.2-B). Deliberately NOT through send(): the
  // general replay backlog has no notion of "answered", and replaying a
  // settled question would reopen the dock on it (codex review). Pending asks
  // live in their own queue — a typed line answers the oldest (mirroring
  // lineReader's serialized order), detach clears them all (every reader
  // declined at EOF) — and an attach is handed only what is still pending.
  ask(text: string, kind: AskKind): void {
    const message = { v: 1, type: 'ask', text, kind } as const
    this.pendingAsks.push(message)
    if (this.client !== null) this.write(this.client, message)
    this.mirror('host', text)
  }

  onInterrupt(handler: (() => void) | null): void {
    this.interruptHandler = handler
  }

  // A live identity change (the /setup recall swapped the voice provider):
  // re-greet the attached client so the identity line tells the truth, and
  // let every later attach greet with it too.
  refreshIdentity(patch: Partial<IpcHostOptions['identity']>): void {
    this.opts.identity = { ...this.opts.identity, ...patch }
    if (this.client !== null) this.write(this.client, { v: 1, type: 'hello', ...this.greeting() })
  }

  // The floor holder (spec 10 §3.4). Straight to the client, NOT send(): mode
  // is a state, and a replayed stale mode would repaint the wrong face on a
  // later attach — adopt() hands the current one instead.
  setMode(who: FloorMode): void {
    this.mode = who
    if (this.client !== null) this.write(this.client, { v: 1, type: 'mode', who })
    this.mirror('tui', `floor: ${who}`)
  }

  onState(state: ProgramState): void {
    // The strip's words ride along with the state that earns them (§3.7.4).
    this.send({ v: 1, type: 'state', state, microcopy: statusMicrocopy(state) })
  }

  // Diagnostics never reach the TUI (§3.9): the dev log stays the one place
  // they live, and the program log renders user content only.
  debug(message: string): void {
    this.mirror('director', message)
  }

  // The front-end process is gone — including the case where it died before it
  // ever opened the socket (a bad entry, missing client packages). Nothing will
  // type again, so a consuming reader (guide / first run) has to decline rather
  // than wait forever on a listener who cannot answer.
  frontEndGone(reason: string): void {
    this.mirror('tui', reason)
    this.pendingAsks = []
    this.markEof()
  }

  // --- shutdown ------------------------------------------------------------ //

  async close(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    const open = [...this.sockets]
    const closed = Promise.all(
      open.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', () => resolve())
            // Only the attached client is owed a goodbye; a half-open peer that
            // never attached just gets the FIN.
            if (socket === this.client) socket.end(encode({ v: 1, type: 'bye' }))
            else socket.end()
          }),
      ),
    )
    this.client = null
    await Promise.race([closed, sleep(CLOSE_GRACE_MS)])
    for (const socket of open) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await unlink(this.opts.socketPath).catch(() => {})
    this.markEof()
  }
}

// What the engine writes to bring the terminal back when the front-end dies
// without restoring it: pop the kitty keyboard flags, bracketed paste and
// focus reporting off, leave the alternate screen, reset colors, show the
// cursor. Everything here is a no-op on a terminal already restored.
export const TERMINAL_RESTORE = '\x1b[<u\x1b[?2004l\x1b[?1004l\x1b[?1049l\x1b[0m\x1b[?25h'

// The slice of the tty the restore touches, injectable for tests.
type Tty = {
  out: { isTTY?: boolean; write: (data: string) => boolean }
  stdin: { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
}

// Launch the front-end (spec 10 §2.2: Bun is a provisioned binary, not a stack
// migration — nothing about it reaches the engine's own toolchain). The client
// inherits stdio: it OWNS the terminal from here on — which is why an abnormal
// exit (a crash skipped OpenTUI's own restore) makes the engine hand the
// terminal back itself: without this, the tty stays in raw mode on the
// alternate screen with nobody reading keys, and even Ctrl-C is dead.
export function spawnTuiClient(opts: {
  bunCmd: string
  entry: string
  socketPath: string
  // Called once when the client is gone for any reason — a clean exit, a crash,
  // or a spawn that never got off the ground.
  onGone?: (reason: string) => void
  tty?: Tty
}): ChildProcess {
  const child = spawn(opts.bunCmd, [opts.entry, opts.socketPath], { stdio: 'inherit' })
  let reported = false
  const gone = (reason: string): void => {
    if (reported) return
    reported = true
    opts.onGone?.(reason)
  }
  // An unhandled 'error' would take the engine down with the face.
  child.on('error', (err) => gone(`front-end failed to start: ${String(err)}`))
  child.on('exit', (code) => {
    if (code !== 0) {
      const { out, stdin } = opts.tty ?? { out: process.stdout, stdin: process.stdin }
      if (out.isTTY === true) out.write(TERMINAL_RESTORE)
      if (stdin.isTTY === true) stdin.setRawMode?.(false)
    }
    gone(`front-end exited (code ${String(code)})`)
  })
  return child
}
