// The TUI client process (spec 10 §2.2): TypeScript on OpenTUI, executed by
// Bun, spawned by the engine. It owns the terminal and nothing else — every
// semantic (commands, talkback, the Q&A flows) stays engine-side.
//
//   bun tui/src/main.tsx <socket-path>
//
// Owning the terminal means GIVING IT BACK. Every exit runs through leave()
// below: a bare process.exit skips OpenTUI's restore and strands the terminal
// in mouse-reporting mode, where every mouse move types escape codes into the
// user's shell.
//
// Env knob, for the §5.1 IME gate: MURMUR_TUI_KITTY_KEYBOARD=0 turns the kitty
// keyboard protocol off, which is the one lever if system-IME composition
// misbehaves under it (§3.1 risk 2). It has to be an all-false options object,
// not null: core 0.4.5 reads `useKittyKeyboard ?? {}`, so null would silently
// mean "the defaults", i.e. still on.

import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'

import type { EngineMessage } from '../../src/host/ipc.ts'
import { App, type Subscribe } from './app.tsx'
import { connectEngine } from './wire.ts'

const socketPath = process.argv[2]
if (socketPath === undefined) {
  console.error('usage: bun tui/src/main.tsx <socket-path>')
  process.exit(2)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false, // Ctrl-C is /quit (§3.4), not a client-only exit
  // Keyboard-driven by design (master §3.6; §1 rules out mouse dashboards).
  // Never arming mouse reporting is also the cheapest way not to leak it.
  useMouse: false,
  ...(process.env.MURMUR_TUI_KITTY_KEYBOARD === '0' && {
    useKittyKeyboard: { disambiguate: false, alternateKeys: false },
  }),
})

// Alternate-scroll mode (spec 10 §3.4): in the alternate screen with mouse
// reporting off, the terminal turns a wheel notch into an Up/Down arrow press.
// That is the whole wheel feature — the log reads the arrows like any other
// key (app.tsx), no mouse tracking is armed, and the terminal's own text
// selection stays exactly as the listener knows it. Written through the
// renderer's writeOut: OpenTUI intercepts process.stdout, which would feed the
// escape back into the frame as text.
const rawOut = renderer as unknown as { writeOut(data: string): void }
// Saved and restored rather than switched off: alternate-scroll is the
// listener's own terminal setting, and a plain `?1007l` on the way out would
// leave it disabled for whatever they run next. XTSAVE/XTRESTORE needs no
// reply to read, and a terminal that ignores the pair just keeps the mode on.
const ALT_SCROLL_ON = '\u001b[?1007s\u001b[?1007h'
const ALT_SCROLL_OFF = '\u001b[?1007r'
rawOut.writeOut(ALT_SCROLL_ON)

// The single exit path: hand the terminal back, then go. Idempotent, because
// `bye` and the socket closing behind it both arrive.
let leaving = false
function leave(code: number, reason?: string): never | void {
  if (leaving) return
  leaving = true
  try {
    renderer.destroy()
    // Disarm AFTER the restore, and on the real stdout: writeOut queues into
    // the render thread, which is gone by the time a quit gets here, and the
    // stdout interception that made writeOut necessary went with it.
    process.stdout.write(ALT_SCROLL_OFF)
  } catch {
    // A half-set-up renderer must not turn a quit into a crash.
  }
  if (reason !== undefined) console.error(`murmur: ${reason}`)
  process.exit(code)
}

// The engine's backstop kill (spec 10 §3.5) must not skip the restore either.
process.on('SIGTERM', () => leave(0))
process.on('SIGINT', () => leave(0))

// The socket attaches while OpenTUI is still starting, so the engine's replay
// (§2.3 — the notices and questions asked before the client existed) can land
// BEFORE React mounts and could subscribe. Hold it until someone is listening;
// after that, straight through.
const listeners = new Set<(message: EngineMessage) => void>()
const pending: EngineMessage[] = []
const subscribe: Subscribe = (listener) => {
  listeners.add(listener)
  const backlog = pending.splice(0)
  for (const message of backlog) listener(message)
  return () => void listeners.delete(listener)
}

const wire = connectEngine(socketPath, {
  onMessage: (message) => {
    // Process lifecycle lives here, not in a component: `bye` means the engine
    // is going down, and the face goes with it.
    if (message.type === 'bye') return leave(0)
    if (listeners.size === 0) pending.push(message)
    else for (const listener of listeners) listener(message)
  },
  // No engine, nothing to show. Say why on the way out, on the plain terminal —
  // the alternate screen is already gone by then.
  onClose: (reason) => leave(1, reason),
})

createRoot(renderer).render(<App subscribe={subscribe} wire={wire} />)
