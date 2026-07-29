// The four functional regions of spec 10 §3.3: status strip, program log,
// the alive band (visualizer + pet, still empty here), and an input line that
// owns focus permanently.
//
// Styling is deliberately restrained at this stage: the warmth kit (§3.7) and
// the art direction (§6.1) land on top of this skeleton, not inside it.

import { useEffect, useRef, useState } from 'react'
import { useKeyboard, type InputProps } from '@opentui/react'
import type { InputRenderable } from '@opentui/core'

import type { EngineMessage, ProgramState } from '../../src/ipc.ts'
import type { Wire } from './wire.ts'

// The program log is a view, not an archive — memory (spec 05) is where the
// program actually lives. Keep the tail a terminal can scroll through.
const LOG_MAX = 500

const INK = {
  bg: '#161310',
  dim: '#7d7166',
  text: '#e8ded2',
  radio: '#f2c078',
  user: '#9fc3a8',
  notice: '#8d8378',
  accent: '#d98e5f',
}

type Entry = { id: number; kind: 'segment' | 'user' | 'info'; text: string }

// Padded to one shared column: the two emoji do not render at the same width,
// so a fixed count of spaces after each leaves the log ragged.
const MARKER: Record<Entry['kind'], string> = {
  segment: '\u{1F399} ',
  user: '\u2328\uFE0F ',
  info: '\u00B7  ',
}

type Identity = { persona: string; brain: string; voice: string }

export type Subscribe = (listener: (message: EngineMessage) => void) => () => void

// The persona's own words for what the program is doing. A fixed local pool,
// zero tokens (§3.7.4) — the pool grows into prompts.ts with the warmth kit.
function status(state: ProgramState | null): string {
  if (state === null) return 'warming up...'
  if (state.awaitingReply) return 'turning to you — say anything'
  switch (state.kind) {
    case 'music':
      return `♪ ${state.nowPlaying ?? 'something for this hour'}`
    case 'talk':
      return 'on the air'
    case 'gap':
      return 'letting it breathe'
  }
}

export function App({ subscribe, wire }: { subscribe: Subscribe; wire: Wire }): React.ReactNode {
  const [identity, setIdentity] = useState<Identity>({ persona: '', brain: '', voice: '' })
  const [entries, setEntries] = useState<Entry[]>([])
  const [state, setState] = useState<ProgramState | null>(null)
  const input = useRef<InputRenderable>(null)
  const nextId = useRef(0)

  useEffect(() => {
    const append = (kind: Entry['kind'], text: string): void =>
      setEntries((prior) => [...prior, { id: nextId.current++, kind, text }].slice(-LOG_MAX))
    return subscribe((message) => {
      switch (message.type) {
        case 'hello':
          setIdentity({ persona: message.persona, brain: message.brain, voice: message.voice })
          break
        case 'segment':
          append('segment', message.text)
          break
        case 'userLine':
          append('user', message.text)
          break
        case 'info':
          append('info', message.text)
          break
        case 'state':
          setState(message.state)
          break
        case 'viz':
          // The visualizer band lands with the engine's FFT feed (§3.6).
          break
        case 'bye':
          // Shutdown is main.tsx's business: it owns the renderer, and the
          // terminal has to be handed back before the process goes.
          break
      }
    })
  }, [subscribe])

  // One shutdown path (§3.4): Ctrl-C is a /quit typed for you, so the engine
  // and the voice go down in order instead of the face dying alone.
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') wire.line('/quit')
  })

  const submit = (text: string): void => {
    if (input.current !== null) input.current.value = ''
    if (text.trim() !== '') wire.line(text)
  }

  return (
    <box style={{ flexDirection: 'column', height: '100%', backgroundColor: INK.bg }}>
      <box
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: INK.bg,
        }}
      >
        <text style={{ fg: INK.accent }}>{status(state)}</text>
        <text style={{ fg: INK.dim }}>
          {[identity.persona, state?.scene, state?.activity].filter(Boolean).join(' · ')}
        </text>
      </box>

      <scrollbox
        stickyScroll
        stickyStart="bottom"
        style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, rootOptions: { backgroundColor: INK.bg } }}
      >
        {entries.map((entry) => (
          <text
            key={entry.id}
            style={{
              fg:
                entry.kind === 'segment' ? INK.radio : entry.kind === 'user' ? INK.user : INK.notice,
            }}
          >
            {MARKER[entry.kind]}
            {entry.text}
          </text>
        ))}
      </scrollbox>

      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: INK.dim }}>{`${identity.brain} · ${identity.voice}`}</text>
      </box>

      <box
        style={{
          flexDirection: 'row',
          height: 1,
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: INK.bg,
        }}
      >
        <text style={{ fg: INK.accent }}>{'> '}</text>
        <input
          ref={input}
          focused
          placeholder="type to talk back"
          style={{
            flexGrow: 1,
            textColor: INK.text,
            placeholderColor: INK.dim,
            backgroundColor: INK.bg,
          }}
          // The reconciler wires an input's onSubmit to the ENTER event, which
          // carries the submitted string; the declared prop type inherits
          // Textarea's event-shaped signature on top of it (upstream, 0.4.5).
          onSubmit={submit as InputProps['onSubmit']}
        />
      </box>
    </box>
  )
}
