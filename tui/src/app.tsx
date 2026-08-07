// The four functional regions of spec 10 §3.3: status strip, program log, the
// alive band (pet + visualizer), and an input line that owns focus permanently.
//
// The warmth kit (§3.7) is wired here but authored elsewhere: the sprites are
// assets (pet.ts), the accents are a palette (palette.ts), the bars are
// arithmetic (bars.ts), and the DJ's words for the strip come over the wire from
// the engine's own prompt pool. This file only composes them — which is also why
// the art direction session (§6.1) can restyle murmur without touching logic.

import { useEffect, useRef, useState } from 'react'
import { useKeyboard, useTerminalDimensions, type InputProps } from '@opentui/react'
import type { InputRenderable } from '@opentui/core'

import type { EngineMessage, ProgramState, SettingsSnapshot } from '../../src/ipc.ts'
import { Bars, render } from './bars.ts'
import { Constellation, panelWidth, type Run } from './constellation.ts'
import { accentFor, INK, mix, type Accent } from './palette.ts'
import { adjust, paneFacts, paneItems } from './settings-pane.ts'
import {
  awayGreeting,
  bandLayout,
  cells,
  loadPoses,
  petPalette,
  POSE_FPS,
  poseFor,
  type PoseName,
} from './pet.ts'
import type { Wire } from './wire.ts'

// The program log is a view, not an archive — memory (spec 05) is where the
// program actually lives. Keep the tail a terminal can scroll through.
const LOG_MAX = 500

// The sprites, read once at start-up: they are committed text, not a resource
// that can change under a running client.
const POSES = loadPoses()

// The alive band is as tall as the pet, and the bars fill it — one band, not two
// stacked strips (§3.3). Its height stays the pet's whether or not the pet is
// shown: the band is the bars' room, and it must not resize under a knob.
const BAND_ROWS = POSES.idle[0]!.length / 2

// Whether the creature is part of that band is a live setting now (spec 12
// §3.7), so its layout is computed per render inside App — the env override
// stays, resolved in bandLayout itself.

// Half-block: the upper pixel is the ink, the lower is the ground behind it.
const HALF = '▀'

// How far the pet's ink fades toward the room while it sleeps.
const DOZE_FADE = 0.45

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

// Where the 24fps spectrum stream is handed off. A mutable sink rather than
// component state on purpose: frames must repaint the band WITHOUT re-rendering
// the program log above it, and there is still exactly one wire subscriber.
type VizSink = { current: ((bins: number[]) => void) | null }

// The spectrum strip (§3.6): eighth-block bars under a vertical gradient, the
// top row brightest. cava's look; the FFT behind it is the engine's.
function Visualizer({ sink, accent }: { sink: VizSink; accent: Accent }): React.ReactNode {
  const bars = useRef(new Bars())
  const [rows, setRows] = useState<string[]>([])

  useEffect(() => {
    sink.current = (bins) => {
      bars.current.push(bins)
      setRows(render(bars.current.levels(), BAND_ROWS))
    }
    return () => void (sink.current = null)
  }, [sink])

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      {Array.from({ length: BAND_ROWS }, (_, row) => (
        <text
          key={row}
          style={{ fg: mix(accent.dim, accent.bright, 1 - row / Math.max(BAND_ROWS - 1, 1)) }}
        >
          {rows[row] ?? ''}
        </text>
      ))}
    </box>
  )
}

// The pet (§3.7.1): one pose at a time, its frames looped at the pose's own rate.
function Pet({ pose, accent }: { pose: PoseName; accent: Accent }): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const frames = POSES[pose]

  useEffect(() => {
    setFrame(0)
    // A single-frame pose is a held expression, not an animation: the pose change
    // is the reaction, and a timer for it would only burn wakeups.
    if (frames.length < 2) return
    const timer = setInterval(
      () => setFrame((at) => (at + 1) % frames.length),
      1000 / POSE_FPS[pose],
    )
    return () => clearInterval(timer)
  }, [pose, frames])

  const grid = cells(frames[frame % frames.length]!, petPalette(accent, pose === 'doze' ? DOZE_FADE : 0))
  return (
    <box style={{ flexDirection: 'column' }}>
      {grid.map((row, y) => (
        <text key={y}>
          {row.map((cell, x) => (
            <span key={x} fg={cell.fg} bg={cell.bg}>
              {HALF}
            </span>
          ))}
        </text>
      ))}
    </box>
  )
}

// The wide-terminal sky (§6.1 quiet-constellation): starfield, particle mist,
// and the pet floating in it. Painted on its own clock — viz frames only feed
// the smoother, so the sky breathes (stars twinkle, the pet animates) even when
// the engine has nothing to say. Constellation is per-mount; the parent keys
// this component on its size, so a resize builds a fresh sky.
const SKY_FPS = 12

function SkyPanel({
  sink,
  accent,
  pose,
  showPet,
  width,
  rows,
}: {
  sink: VizSink
  accent: Accent
  pose: PoseName
  showPet: boolean
  width: number
  rows: number
}): React.ReactNode {
  const bars = useRef(new Bars())
  const sky = useRef<Constellation | null>(null)
  const tick = useRef(0)
  const [painted, setPainted] = useState<Run[][]>([])
  if (sky.current === null) sky.current = new Constellation(width, rows)

  useEffect(() => {
    sink.current = (bins) => bars.current.push(bins)
    return () => void (sink.current = null)
  }, [sink])

  const frames = POSES[pose]
  useEffect(() => {
    const timer = setInterval(() => {
      tick.current++
      const at = Math.floor(tick.current / (SKY_FPS / POSE_FPS[pose])) % frames.length
      const pet = showPet
        ? cells(frames[at]!, petPalette(accent, pose === 'doze' ? DOZE_FADE : 0))
        : null
      setPainted(sky.current!.frame(bars.current.levels(), accent, pet))
    }, 1000 / SKY_FPS)
    return () => clearInterval(timer)
  }, [accent, pose, frames, showPet])

  return (
    <box style={{ flexDirection: 'column' }}>
      {painted.map((runs, y) => (
        <text key={y}>
          {runs.map((run, at) => (
            <span key={at} fg={run.fg} bg={run.bg ?? INK.bg}>
              {run.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  )
}

export function App({ subscribe, wire }: { subscribe: Subscribe; wire: Wire }): React.ReactNode {
  const [identity, setIdentity] = useState<Identity>({ persona: '', brain: '', voice: '' })
  const [entries, setEntries] = useState<Entry[]>([])
  const [state, setState] = useState<ProgramState | null>(null)
  // The DJ's line for the strip, authored engine-side (§3.7.4).
  const [microcopy, setMicrocopy] = useState<string | null>(null)
  // The settings pane (spec 12 §3.6). The snapshot is engine truth; the pane
  // renders it and sends patches, never local optimism. Mirrored into a ref so
  // the keyboard handler always sees the current pane, not a stale closure.
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [paneOpen, setPaneOpen] = useState(false)
  const [paneAt, setPaneAt] = useState(0)
  const pane = useRef({ open: false, at: 0, snap: null as SettingsSnapshot | null })
  pane.current = { open: paneOpen, at: paneAt, snap: settings }
  // The absence the pet greets (§3.7.3). It stands until the program itself has
  // something to say, so the welcome is never cut short by a timer.
  const [greeting, setGreeting] = useState<string | null>(null)
  const input = useRef<InputRenderable>(null)
  const nextId = useRef(0)
  const vizSink = useRef<((bins: number[]) => void) | null>(null)

  useEffect(() => {
    const append = (kind: Entry['kind'], text: string): void =>
      setEntries((prior) => [...prior, { id: nextId.current++, kind, text }].slice(-LOG_MAX))
    return subscribe((message) => {
      switch (message.type) {
        case 'hello':
          setIdentity({ persona: message.persona, brain: message.brain, voice: message.voice })
          setGreeting(awayGreeting(message.away))
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
          setMicrocopy(message.microcopy ?? null)
          setGreeting(null)
          break
        case 'settings':
          setSettings({
            values: message.values,
            home: message.home,
            voiceConfigured: message.voiceConfigured,
            musicAvailable: message.musicAvailable,
          })
          // Only the snapshot answering a typed /settings opens the pane; a
          // broadcast refresh just keeps an open one true.
          if (message.open === true) setPaneOpen(true)
          break
        case 'viz':
          vizSink.current?.(message.bins)
          break
        case 'bye':
          // Shutdown is main.tsx's business: it owns the renderer, and the
          // terminal has to be handed back before the process goes.
          break
      }
    })
  }, [subscribe])

  // Ask for the spectrum, and give it back on the way out (§3.6): the engine
  // computes nothing for a front-end that is not watching. The rate is left to
  // the engine's default rather than restated here.
  useEffect(() => {
    wire.send({ v: 1, type: 'vizSub', on: true })
    return () => wire.send({ v: 1, type: 'vizSub', on: false })
  }, [wire])

  // One shutdown path (§3.4): Ctrl-C is a /quit typed for you, so the engine
  // and the voice go down in order instead of the face dying alone. While the
  // settings pane is open, keys route to it (spec 12 §3.6 — the sanctioned
  // exception to the input line's permanent focus): Esc returns, arrows move,
  // space/enter/arrows adjust; every change goes over the wire immediately.
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') return wire.line('/quit')
    const { open, at, snap } = pane.current
    if (!open || snap === null) return
    if (key.name === 'escape') return setPaneOpen(false)
    const items = paneItems(snap)
    if (key.name === 'up') return setPaneAt(Math.max(0, at - 1))
    if (key.name === 'down') return setPaneAt(Math.min(items.length - 1, at + 1))
    if (['left', 'right', 'space', 'return'].includes(key.name)) {
      const patch = adjust(snap, items[at]!.key, key.name === 'left' ? -1 : 1)
      if (patch !== null) wire.send({ v: 1, type: 'settingsSet', patch })
    }
  })

  const submit = (text: string): void => {
    if (input.current !== null) input.current.value = ''
    if (text.trim() !== '') wire.line(text)
  }

  // The hour's accent, swapped whenever the engine reports a new scene (§3.7.2).
  const accent = accentFor(state?.scene)
  const pose = greeting !== null ? 'wake' : poseFor(state)
  // The §6.1 breakpoint: wide terminals compose the alive band as a sky panel
  // beside the log; narrow ones keep the classic bottom band. Same four
  // regions either way (§3.3) — only the composition moves.
  const dims = useTerminalDimensions()
  const skyWidth = panelWidth(dims.width)
  // In the sky composition now-playing lives under the panel as its own quiet
  // line; in the band composition it stays in the strip.
  const strip = [
    greeting ?? microcopy ?? 'warming up...',
    skyWidth === null ? state?.nowPlaying : undefined,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join('  ♪ ')
  // The alive band's composition follows the live pet setting (spec 12 §3.7),
  // with the env override resolved inside bandLayout.
  const band = bandLayout(process.env, settings?.values.tuiPet)
  const items = paneOpen && settings !== null ? paneItems(settings) : null
  // Rows left for the sky once the strip, identity, input, and now-playing
  // lines take theirs.
  const skyRows = Math.max(dims.height - 4, 4)

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
        <text style={{ fg: accent.bright }}>{strip}</text>
        <text style={{ fg: INK.dim }}>
          {[identity.persona, state?.scene, state?.activity].filter(Boolean).join(' · ')}
        </text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: 'row' }}>
      {items !== null && settings !== null ? (
        <box style={{ flexGrow: 1, flexDirection: 'column', paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
          <text style={{ fg: accent.bright }}>settings</text>
          <text style={{ fg: INK.dim }}> </text>
          {items.map((item, index) => (
            <box key={item.key} style={{ flexDirection: 'column' }}>
              {item.advanced && items.findIndex((i) => i.advanced) === index && (
                <text style={{ fg: INK.dim }}>{'  ── advanced ──'}</text>
              )}
              <text
                style={{
                  fg: index === paneAt ? accent.bright : item.enabled ? INK.text : INK.dim,
                }}
              >
                {`${index === paneAt ? '▸ ' : '  '}${item.label.padEnd(24)}${item.value}`}
              </text>
            </box>
          ))}
          <text style={{ fg: INK.dim }}> </text>
          {paneFacts(settings).map((fact) => (
            <text key={fact.label} style={{ fg: INK.dim }}>
              {`  ${fact.label.padEnd(24)}${fact.value}`}
            </text>
          ))}
          <text style={{ fg: INK.dim }}> </text>
          <text style={{ fg: INK.dim }}>{'  ↑↓ move · ←→/space adjust · esc back'}</text>
        </box>
      ) : (
        <scrollbox
          stickyScroll
          stickyStart="bottom"
          style={{
            flexGrow: 1,
            paddingLeft: skyWidth === null ? 1 : 2,
            paddingRight: 1,
            rootOptions: { backgroundColor: INK.bg },
          }}
        >
          {entries.map((entry) => (
            // The sky composition lets the log breathe — one blank line between
            // entries, the poem spacing of §6.1. The band composition stays dense.
            <box key={entry.id} style={{ marginBottom: skyWidth === null ? 0 : 1 }}>
              <text
                style={{
                  fg:
                    entry.kind === 'segment'
                      ? accent.bright
                      : entry.kind === 'user'
                        ? INK.user
                        : INK.notice,
                }}
              >
                {MARKER[entry.kind]}
                {entry.text}
              </text>
            </box>
          ))}
        </scrollbox>
      )}

      {skyWidth !== null && (
        <box style={{ width: skyWidth, flexDirection: 'column', paddingRight: 1 }}>
          <SkyPanel
            key={`${skyWidth}x${skyRows}`}
            sink={vizSink}
            accent={accent}
            pose={pose}
            showPet={band.pet}
            width={skyWidth - 1}
            rows={skyRows}
          />
          <text style={{ fg: accent.dim }}>
            {state?.nowPlaying !== undefined && state.nowPlaying !== ''
              ? `♪ ${state.nowPlaying}`
              : ''}
          </text>
        </box>
      )}
      </box>

      {skyWidth === null && (
        <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1, height: BAND_ROWS }}>
          {band.pet && <Pet pose={pose} accent={accent} />}
          <box style={{ flexGrow: 1, paddingLeft: band.vizPadLeft }}>
            <Visualizer sink={vizSink} accent={accent} />
          </box>
        </box>
      )}

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
        <text style={{ fg: accent.bright }}>{'> '}</text>
        <input
          ref={input}
          focused={!paneOpen}
          placeholder={paneOpen ? 'settings open — esc to return' : 'type to talk back'}
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
