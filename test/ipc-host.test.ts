import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IpcHost, spawnTuiClient, TERMINAL_RESTORE } from '../src/ipc-host.ts'
import {
  PROTOCOL,
  decodeEngineMessage,
  encode,
  ndjson,
  type EngineMessage,
  type Settings,
  type SettingsPatch,
} from '../src/ipc.ts'
import { STATUS_MICROCOPY } from '../src/prompts.ts'

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

  vizSub(on: boolean, fps?: number): void {
    this.send(encode({ v: 1, type: 'vizSub', on, ...(fps !== undefined && { fps }) }))
  }

  set(patch: SettingsPatch): void {
    this.send(encode({ v: 1, type: 'settingsSet', patch }))
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

  it('mirrors received slash commands to the dev log — chat and answers stay out', async () => {
    // Commands are the diagnostics trail (quit latency, menu picks); any other
    // line may be a pasted secret and must never be persisted (spec 03-03 §7.2).
    const devLog = join(dir, 'dev.log')
    const logged = new IpcHost({
      socketPath: join(dir, 'logged.sock'),
      identity: { brain: 'stub', voice: 'stub' },
      devLog,
    })
    await logged.listen()
    try {
      const c = await FakeClient.open(join(dir, 'logged.sock'))
      clients.push(c)
      c.attach()
      c.line('/quit')
      c.line('sk-secret-pasted-key')
      // A leading slash is not a command: an ask answer may be an absolute
      // path, and chat may open with '/'. Only the engine's own grammar
      // (ipc.ts COMMANDS) is diagnostics.
      c.line('/Users/zach/.murmur/voice.json')
      c.line('/shrug whatever')
      await c.settle()
      const { readFileSync } = await import('node:fs')
      const log = readFileSync(devLog, 'utf8')
      expect(log).toContain('command received: /quit')
      expect(log).not.toContain('sk-secret-pasted-key')
      expect(log).not.toContain('/Users/zach')
      expect(log).not.toContain('/shrug')
    } finally {
      await logged.close()
    }
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
    host.onState({ kind: 'music', nowPlaying: 'a song' })
    host.debug?.('look-ahead depth=2')
    await c.settle()
    expect(c.types()).toEqual(['hello', 'segment', 'userLine', 'info', 'state'])
    // Diagnostics stay out of the TUI (spec 10 §3.9): debug never hits the wire.
    expect(c.received.some((m) => m.type === 'segment' && m.text.includes('depth'))).toBe(false)
  })

  it('carries a question to the client, and replays one asked before the attach', async () => {
    // The first-run seeds are asked while the TUI is still booting (§3.2-B):
    // a PENDING ask must reach a late-attaching client, or the dock opens
    // empty on the question that started the whole flow.
    host.ask('what should I call you?', 'question')
    const c = await client()
    c.attach()
    await c.settle()
    expect(c.received.at(-1)).toEqual({
      v: 1,
      type: 'ask',
      text: 'what should I call you?',
      kind: 'question',
    })
    host.ask('allow? [y/N]', 'consent')
    await c.settle()
    expect(c.received.at(-1)).toEqual({ v: 1, type: 'ask', text: 'allow? [y/N]', kind: 'consent' })
  })

  it('replays concurrently-pending asks in the order they were asked', async () => {
    // Two SDK permission requests can be in flight at once; lineReader answers
    // them in ask order, so the client must queue them in the same order
    // (codex review: a single-slot dock let an answer authorize the WRONG one).
    host.ask('run [Bash]: brew install yt-dlp\nallow? [y/N]', 'consent')
    host.ask('run [Bash]: brew install ffmpeg\nallow? [y/N]', 'consent')
    const c = await client()
    c.attach()
    await c.settle()
    const asks = c.received.filter((m) => m.type === 'ask').map((m) => m.text)
    expect(asks[0]).toContain('yt-dlp')
    expect(asks[1]).toContain('ffmpeg')
  })

  it('does not replay an answered ask — the dock must not reopen a settled question', async () => {
    // codex review: asks rode the general replay backlog with no clear event,
    // so a client attaching later re-docked questions from earlier in the run.
    const first = await client()
    first.attach()
    await first.settle()
    host.ask('what should I call you? (Enter skips)', 'question')
    first.line('call me smoke')
    await first.settle()
    expect(host.takeLine()).toBe('call me smoke')
    // A takeover attach (no detach in between): the answered question is gone.
    const second = await client()
    second.attach()
    await second.settle()
    expect(second.received.some((m) => m.type === 'ask')).toBe(false)
  })

  it('clears pending asks when the front-end dies — its readers all declined at EOF', async () => {
    const first = await client()
    first.attach()
    await first.settle()
    host.ask('paste your key:', 'question')
    first.close()
    await host.eof()
    const second = await client()
    second.attach()
    await second.settle()
    // The guide declined at EOF; re-docking the paste prompt would present a
    // dead question as live.
    expect(second.received.some((m) => m.type === 'ask')).toBe(false)
  })

  it('refreshIdentity re-greets the client, so a swapped voice shows on the identity line', async () => {
    const c = await client()
    c.attach()
    await c.settle()
    host.setMode('guide')
    host.refreshIdentity({ voice: 'hosted' })
    await c.settle()
    const hellos = c.received.filter((m) => m.type === 'hello')
    expect(hellos.at(-1)).toMatchObject({ voice: 'hosted', mode: 'guide' })
    // A later attach greets with the updated identity too.
    const second = await client()
    second.attach()
    await second.settle()
    expect(second.received.find((m) => m.type === 'hello')).toMatchObject({ voice: 'hosted' })
  })

  it('carries an info tone to the client — the flow-transition ink', async () => {
    const c = await client()
    c.attach()
    await c.settle()
    host.info('stopped — the setup guide is waiting for you', 'flow')
    await c.settle()
    expect(c.received.at(-1)).toEqual({
      v: 1,
      type: 'info',
      text: 'stopped — the setup guide is waiting for you',
      tone: 'flow',
    })
  })

  it('routes an interrupt to the registered flow and drops the pending asks on both sides', async () => {
    // Esc in the TUI: the running flow stops, its waiting questions are
    // dead — the engine forgets them and tells the client to close its cards.
    let fired = 0
    host.onInterrupt(() => fired++)
    host.ask('paste your key:', 'question')
    const c = await client()
    c.attach()
    await c.settle()
    c.send(encode({ v: 1, type: 'interrupt' }))
    await c.settle()
    expect(fired).toBe(1)
    expect(c.received.at(-1)).toEqual({ v: 1, type: 'askDrop' })
    // Nothing pending survives for a later attach.
    const second = await client()
    second.attach()
    await second.settle()
    expect(second.received.some((m) => m.type === 'ask')).toBe(false)
  })

  it('an interrupt with no flow to stop is ignored — no askDrop, no crash', async () => {
    host.onInterrupt(null)
    host.ask('what should I call you?', 'question')
    const c = await client()
    c.attach()
    await c.settle()
    c.send(encode({ v: 1, type: 'interrupt' }))
    await c.settle()
    // The first-run seeds still wait on their reader: the card must stand.
    expect(c.received.some((m) => m.type === 'askDrop')).toBe(false)
    const second = await client()
    second.attach()
    await second.settle()
    expect(second.received.some((m) => m.type === 'ask')).toBe(true)
  })

  it('broadcasts the floor mode, and hands the CURRENT mode to a late attach', async () => {
    // The conversation-partner boundary (spec 10 §3.4): a front-end attaching
    // mid-setup must open on the guide's face, not the radio's.
    const first = await client()
    first.attach()
    await first.settle()
    host.setMode('guide')
    await first.settle()
    expect(first.received.at(-1)).toEqual({ v: 1, type: 'mode', who: 'guide' })
    const second = await client()
    second.attach()
    await second.settle()
    const hello = second.received.find((m) => m.type === 'hello')
    expect(hello).toMatchObject({ mode: 'guide' })
    host.setMode('radio')
    await second.settle()
    expect(second.received.at(-1)).toEqual({ v: 1, type: 'mode', who: 'radio' })
  })

  it('sends the busy sign live, and never replays a finished turn to a late attach', async () => {
    // The sign says "the partner is working RIGHT NOW" (spec 10 §3.4). In the
    // replay backlog it would be a lie with no expiry: a client attaching
    // after the turn ended would open under a sign for work that is over,
    // with nothing coming to clear it.
    const first = await client()
    first.attach()
    await first.settle()
    host.setBusy(true)
    await first.settle()
    expect(first.received.at(-1)).toEqual({ v: 1, type: 'busy', on: true })
    host.setBusy(false)
    await first.settle()
    expect(first.received.at(-1)).toEqual({ v: 1, type: 'busy', on: false })

    host.setBusy(true)
    const second = await client()
    second.attach()
    await second.settle()
    expect(second.received.filter((m) => m.type === 'busy')).toEqual([])
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

  // spec 10 §3.6: the visualizer subscription. The bridge only routes it — the
  // FFT and the pacing are the engine's (src/viz.ts).
  describe('the visualizer subscription', () => {
    function subscriptions(): (readonly [boolean, number | undefined])[] {
      const seen: (readonly [boolean, number | undefined])[] = []
      host.setVizSubscriber((on, fps) => void seen.push([on, fps]))
      return seen
    }

    it('hands an attached client subscription straight to the feed', async () => {
      const seen = subscriptions()
      const c = await client()
      c.attach()
      c.vizSub(true, 30)
      c.vizSub(false)
      await c.settle()
      expect(seen).toEqual([
        [true, 30],
        [false, undefined],
      ])
    })

    it('honors a subscription that arrived before the feed was wired up', async () => {
      // The client is spawned in buildHost, before runApp has built the audio
      // engine the feed taps — so it can subscribe while there is nobody to tell.
      // It asks exactly once, on mount: dropping that leaves the strip dead for
      // the whole session.
      const c = await client()
      c.attach()
      c.vizSub(true, 30)
      await c.settle()
      const seen = subscriptions()
      expect(seen).toEqual([[true, 30]])
    })

    it('ignores a subscription from a client that never attached', async () => {
      const seen = subscriptions()
      const c = await client()
      c.vizSub(true, 30)
      await c.settle()
      expect(seen).toEqual([])
    })

    it('unsubscribes when the front-end goes away, so frames stop being computed', async () => {
      const seen = subscriptions()
      const c = await client()
      c.attach()
      c.vizSub(true)
      await c.settle()
      c.close()
      await c.settle()
      expect(seen.at(-1)).toEqual([false, undefined])
    })

    it('sends frames to the attached client', async () => {
      const c = await client()
      c.attach()
      await c.settle()
      host.sendViz([0, 0.5, 1])
      await c.settle()
      expect(c.received.at(-1)).toEqual({ v: 1, type: 'viz', bins: [0, 0.5, 1] })
    })

    it('never replays frames to a later attach — the backlog is program, not audio', async () => {
      // §2.3: the replay exists so the Q&A questions survive a booting client.
      // Stale spectrum frames would flood it and mean nothing by arrival.
      host.info('a notice')
      for (let i = 0; i < 50; i++) host.sendViz([i / 50])
      const c = await client()
      c.attach()
      await c.settle()
      expect(c.types()).toEqual(['hello', 'info'])
    })

    it('frames sent with nobody attached are simply dropped', async () => {
      expect(() => host.sendViz([1])).not.toThrow()
    })
  })

  // spec 10 §3.7: the warmth kit's two engine-side pieces — the DJ's words for
  // the status strip, and how long the room was empty.
  describe('the warmth kit', () => {
    it('sends the DJ line for the strip alongside every state', async () => {
      const c = await client()
      c.attach()
      await c.settle()
      host.onState({ kind: 'music', nowPlaying: 'a song' })
      await c.settle()
      const state = c.received.at(-1)
      expect(state).toMatchObject({ type: 'state' })
      expect(state?.type === 'state' && state.microcopy).toBeTruthy()
      expect(STATUS_MICROCOPY.music).toContain(state?.type === 'state' ? state.microcopy : '')
    })

    it('carries the absence in the handshake, to whoever attaches', async () => {
      host.banner('a night host', { brain: 'stub', voice: 'stub', away: 21_600 })
      const c = await client()
      c.attach()
      await c.settle()
      // The greeting a late client gets must know the same absence as the first.
      expect(c.received[0]).toMatchObject({ type: 'hello', persona: 'a night host', away: 21_600 })
    })

    it('says nothing about an absence there is no history for', async () => {
      host.banner('a night host', { brain: 'stub', voice: 'stub' })
      const c = await client()
      c.attach()
      await c.settle()
      expect(c.received[0]).not.toHaveProperty('away')
    })
  })

  // spec 12 §2.5: the settings bridge. The host routes; the store (wired by the
  // app) is the single authority — a successful set is broadcast by the store's
  // own change event, so the host answers only what would otherwise go silent.
  describe('the settings bridge (spec 12)', () => {
    const VALUES: Settings = {
      anchorsEnabled: true,
      musicEnabled: true,
      cadenceMode: 'every_n',
      musicEveryN: 2,
      gapSeconds: 2,
      recentWindow: 12,
      muted: false,
      tuiPet: true,
    }

    function wire(applyOk = true): SettingsPatch[] {
      const applied: SettingsPatch[] = []
      host.setSettings({
        snapshot: () => ({ values: VALUES, home: '/tmp/m', voiceConfigured: true, musicAvailable: true }),
        apply: (patch) => {
          applied.push(patch)
          return applyOk
        },
      })
      return applied
    }

    it('sends a snapshot after hello on every attach', async () => {
      wire()
      const c = await client()
      c.attach()
      await c.settle()
      expect(c.types()).toEqual(['hello', 'settings'])
      expect(c.received[1]).toMatchObject({ type: 'settings', home: '/tmp/m', values: VALUES })
    })

    it('routes a set to the store; a rejected patch is answered with truth', async () => {
      const applied = wire(false)
      const c = await client()
      c.attach()
      await c.settle()
      c.set({ musicEnabled: false })
      await c.settle()
      expect(applied).toEqual([{ musicEnabled: false }])
      // The rejection's only reply is a fresh (unchanged) snapshot.
      expect(c.types().filter((t) => t === 'settings')).toHaveLength(2)
    })

    it('leaves the broadcast of a successful set to the store change event', async () => {
      const applied = wire(true)
      const c = await client()
      c.attach()
      await c.settle()
      c.set({ gapSeconds: 4 })
      await c.settle()
      expect(applied).toEqual([{ gapSeconds: 4 }])
      expect(c.types().filter((t) => t === 'settings')).toHaveLength(1) // the attach one
      host.sendSettings() // what the app's onChange wiring performs
      await c.settle()
      expect(c.types().filter((t) => t === 'settings')).toHaveLength(2)
    })

    it('showSettings answers /settings with an open-flagged snapshot', async () => {
      wire()
      const c = await client()
      c.attach()
      await c.settle()
      host.showSettings()
      await c.settle()
      expect(c.received.at(-1)).toMatchObject({ type: 'settings', open: true })
    })

    it('snapshots never enter the replay backlog', async () => {
      wire()
      host.info('a notice')
      host.sendSettings()
      host.sendSettings()
      const c = await client()
      c.attach()
      await c.settle()
      // One snapshot — the attach one — not the two stale broadcasts.
      expect(c.types()).toEqual(['hello', 'info', 'settings'])
    })

    it('a set before the bridge is wired is dropped without a crash', async () => {
      const c = await client()
      c.attach()
      await c.settle()
      c.set({ tuiPet: false })
      await c.settle()
      expect(c.types()).toEqual(['hello'])
    })

    it('ignores a set from a client that never attached', async () => {
      const applied = wire()
      const c = await client()
      c.set({ musicEnabled: false })
      await c.settle()
      expect(applied).toEqual([])
    })
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

describe('spawnTuiClient (the terminal handed back when the face dies badly)', () => {
  const tty = (): {
    out: { isTTY: boolean; writes: string[]; write: (s: string) => boolean }
    stdin: { isTTY: boolean; raw: boolean[]; setRawMode: (on: boolean) => void }
  } => {
    const out = {
      isTTY: true,
      writes: [] as string[],
      write(s: string): boolean {
        out.writes.push(s)
        return true
      },
    }
    const stdin = {
      isTTY: true,
      raw: [] as boolean[],
      setRawMode(on: boolean): void {
        stdin.raw.push(on)
      },
    }
    return { out, stdin }
  }

  it('restores the terminal when the client exits abnormally', async () => {
    const { out, stdin } = tty()
    const gone = new Promise<string>((resolve) =>
      spawnTuiClient({
        bunCmd: 'node',
        entry: '-e',
        socketPath: 'process.exit(3)',
        onGone: resolve,
        tty: { out, stdin },
      }),
    )
    expect(await gone).toContain('code 3')
    expect(out.writes.join('')).toBe(TERMINAL_RESTORE)
    expect(stdin.raw).toEqual([false])
  })

  it('leaves a cleanly exited client to its own restore', async () => {
    const { out, stdin } = tty()
    const gone = new Promise<string>((resolve) =>
      spawnTuiClient({
        bunCmd: 'node',
        entry: '-e',
        socketPath: 'process.exit(0)',
        onGone: resolve,
        tty: { out, stdin },
      }),
    )
    expect(await gone).toContain('code 0')
    expect(out.writes).toEqual([])
    expect(stdin.raw).toEqual([])
  })

  it('does not write escapes at a non-tty', async () => {
    const { out, stdin } = tty()
    out.isTTY = false
    stdin.isTTY = false
    const gone = new Promise<string>((resolve) =>
      spawnTuiClient({
        bunCmd: 'node',
        entry: '-e',
        socketPath: 'process.exit(3)',
        onGone: resolve,
        tty: { out, stdin },
      }),
    )
    expect(await gone).toContain('code 3')
    expect(out.writes).toEqual([])
    expect(stdin.raw).toEqual([])
  })
})
