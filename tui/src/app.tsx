// The four functional regions of spec 10 §3.3: status strip, program log, the
// alive band (pet + visualizer), and an input line that owns focus permanently.
//
// The warmth kit (§3.7) is wired here but authored elsewhere: the sprites are
// assets (pet.ts), the accents are a palette (palette.ts), the bars are
// arithmetic (bars.ts), and the DJ's words for the strip come over the wire from
// the engine's own prompt pool. This file only composes them — which is also why
// the art direction session (§6.1) can restyle murmur without touching logic.

import { useEffect, useRef, useState } from 'react'
import { useKeyboard, useRenderer, useTerminalDimensions, type InputProps } from '@opentui/react'
import type { InputRenderable } from '@opentui/core'

import type { EngineMessage, ProgramState, SettingsSnapshot } from '../../src/ipc.ts'
import { Bars, render } from './bars.ts'
import { circleOf, Constellation, panelWidth, penFor, type Run } from './constellation.ts'
import {
  cellSizeFrom,
  deleteFigures,
  encodeFigurePng,
  figurePen,
  figureScale,
  placeFigure,
} from './figure-image.ts'
import { accentFor, EMBER, INK, mix, PERIWINKLE, WARM, type Accent } from './palette.ts'
import { adjust, paneFacts, paneItems } from './settings-pane.ts'
import {
  awayGreeting,
  bandLayout,
  halve,
  loadPoses,
  POSE_FPS,
  POSE_NAMES,
  poseFor,
  splitNowPlaying,
  type PoseName,
  type Sprite,
} from './pet.ts'
import type { Wire } from './wire.ts'

// The program log is a view, not an archive — memory (spec 05) is where the
// program actually lives. Keep the tail a terminal can scroll through.
const LOG_MAX = 500

// The sprites, read once at start-up: they are committed text, not a resource
// that can change under a running client.
const POSES = loadPoses()

// The sky composition's max width (§6.1): the concept frames its page; an
// ultra-wide terminal centers that frame rather than stretching it.
const MAX_COLS = 184

// The narrow band draws the pet at half scale — the full 42x44 grid would eat
// a 24-row terminal whole (codex review, 2026-08-07).
const BAND_POSES = Object.fromEntries(
  POSE_NAMES.map((pose) => [pose, POSES[pose].map(halve)]),
) as Record<PoseName, Sprite[]>

// The alive band is as tall as the pet, and the bars fill it — one band, not two
// stacked strips (§3.3). Its height stays the pet's whether or not the pet is
// shown: the band is the bars' room, and it must not resize under a knob.
// Half-blocks fold two pixel rows per terminal row.
const BAND_ROWS = BAND_POSES.idle[0]!.length / 2

// Whether the creature is part of that band is a live setting now (spec 12
// §3.7), so its layout is computed per render inside App — the env override
// stays, resolved in bandLayout itself.

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
function Pet({ pose }: { pose: PoseName }): React.ReactNode {
  const [frame, setFrame] = useState(0)
  const frames = BAND_POSES[pose]

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

  const fade = pose === 'doze' ? DOZE_FADE : 0
  const cream = mix(INK.text, INK.bg, fade)
  const warm = mix(WARM, INK.bg, fade)
  const ember = mix(EMBER, INK.bg, fade)
  const ink = (key: string | undefined): string =>
    key === 'x' ? cream : key === 'w' ? warm : key === 's' ? ember : INK.bg
  const sprite = frames[frame % frames.length]!
  const rows: React.ReactNode[] = []
  for (let top = 0; top + 1 < sprite.length; top += 2) {
    rows.push(
      <text key={top}>
        {[...sprite[top]!].map((_, x) => (
          <span key={x} fg={ink(sprite[top]![x])} bg={ink(sprite[top + 1]![x])}>
            {'▀'}
          </span>
        ))}
      </text>,
    )
  }
  return <box style={{ flexDirection: 'column' }}>{rows}</box>
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
  if (sky.current === null) sky.current = new Constellation(width, rows, 1, penFor(process.env))

  useEffect(() => {
    sink.current = (bins) => bars.current.push(bins)
    return () => void (sink.current = null)
  }, [sink])

  const frames = POSES[pose]
  useEffect(() => {
    const timer = setInterval(() => {
      tick.current++
      const at = Math.floor(tick.current / (SKY_FPS / POSE_FPS[pose])) % frames.length
      setPainted(
        sky.current!.frame(
          bars.current.levels(),
          accent,
          showPet ? frames[at]! : null,
          pose === 'doze' ? DOZE_FADE : 0,
        ),
      )
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
  // The composition has a max width: past it, a wide terminal gets symmetric
  // margins instead of a log pinned to the left edge and a stretched sky.
  const cols = Math.min(dims.width, MAX_COLS)
  const gutter = Math.floor((dims.width - cols) / 2)
  const skyWidth = panelWidth(cols)
  // In the sky composition the strip is one centred line over a full-width
  // rule (concept 04), and now-playing lives under the panel; in the band
  // composition the strip stays two-sided and carries now-playing itself.
  const strip =
    skyWidth === null
      ? [greeting ?? microcopy ?? 'warming up...', state?.nowPlaying]
          .filter((part) => part !== undefined && part !== '')
          .join('  ♪ ')
      : [
          greeting ?? microcopy ?? 'murmur is on the air',
          state?.scene,
          state?.activity ?? 'here',
        ]
          .filter((part) => part !== undefined && part !== '')
          .join(' · ')
  // The alive band's composition follows the live pet setting (spec 12 §3.7),
  // with the env override resolved inside bandLayout.
  const band = bandLayout(process.env, settings?.values.tuiPet)
  const items = paneOpen && settings !== null ? paneItems(settings) : null
  // Rows left for the sky once the strip, its rule, identity, input, and
  // now-playing take theirs.
  const skyRows = Math.max(dims.height - 5, 4)
  // The newest broadcast line carries the bullet (concept 04); older lines
  // stand back.
  const latestSegment = entries.findLast((entry) => entry.kind === 'segment')?.id

  // The raster figure (§6.1): a kitty-graphics terminal draws the whisper-girl
  // as a real PNG at the design's own pixel pitch — the sky stays characters,
  // only the figure earns pixels. Scale comes from the renderer's own pixel
  // report; placement re-runs on any relayout, after the text frame settles.
  //
  // Every escape byte goes through the renderer's writeOut — the ONE channel
  // serialized with the render thread. OpenTUI intercepts process.stdout.write
  // (capture-stdout mode), so writing there would feed the payload back into
  // the renderer as text. writeOut is typed private upstream pending a public
  // graphics API (opentui#92); this is the sanctioned narrow reach around it.
  const figMode = figurePen(process.env)
  const renderer = useRenderer()
  const rawOut = renderer as unknown as { writeOut(data: string): void }
  useEffect(() => {
    if (skyWidth === null || figMode !== 'image' || !band.pet) return
    let loop: ReturnType<typeof setInterval> | undefined
    const settle = setTimeout(() => {
      const cell = cellSizeFrom(renderer.resolution, dims.width, dims.height)
      const frames = POSES[pose]
      const spriteCols = frames[0]![0]!.length
      const scale = figureScale(cell?.width ?? 0, spriteCols)
      const fade = pose === 'doze' ? DOZE_FADE : 0
      const pngs = frames.map((frame) => encodeFigurePng(frame, scale, fade))
      const imgCols = Math.ceil((spriteCols * scale) / (cell?.width ?? 8))
      const imgRows = Math.ceil((frames[0]!.length * scale) / (cell?.height ?? 16))
      const centerRow = 2 + circleOf((skyWidth - 1) * 2, skyRows * 4).cy / 4
      const panelLeft = gutter + cols - skyWidth
      const col = Math.max(1, Math.round(panelLeft + (skyWidth - 1) / 2 - imgCols / 2) + 1)
      const row = Math.max(1, Math.round(centerRow - imgRows / 2) + 1)
      // Retransmitting under one id replaces the frame in place — the pose
      // loop is a stream of tiny PNGs at the pose's own rate.
      let at = 0
      const paint = (): void => rawOut.writeOut(placeFigure(pngs[at++ % pngs.length]!, row, col, 1))
      paint()
      if (pngs.length > 1) loop = setInterval(paint, 1000 / POSE_FPS[pose])
    }, 600)
    return () => {
      clearTimeout(settle)
      clearInterval(loop)
      rawOut.writeOut(deleteFigures())
    }
  }, [skyWidth, cols, gutter, skyRows, figMode, band.pet, pose, renderer, dims.width, dims.height])

  return (
    <box
      style={{
        flexDirection: 'column',
        height: '100%',
        backgroundColor: INK.bg,
        paddingLeft: gutter,
        paddingRight: gutter,
      }}
    >
      {skyWidth === null ? (
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
      ) : (
        <box style={{ flexDirection: 'column' }}>
          <box style={{ flexDirection: 'row', justifyContent: 'center', height: 1 }}>
            <text style={{ fg: accent.bright }}>{strip}</text>
          </box>
          <text style={{ fg: mix(INK.dim, INK.bg, 0.45) }}>{'─'.repeat(cols)}</text>
        </box>
      )}

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
            // entries, the poem spacing of §6.1, no icon markers (the speaker
            // lives in the color), the newest broadcast line carrying a bullet.
            // The band composition stays dense with its marker column.
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
                {skyWidth === null
                  ? MARKER[entry.kind]
                  : entry.id === latestSegment
                    ? '● '
                    : entry.kind === 'info'
                      ? '· '
                      : ''}
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
            showPet={band.pet && figMode === 'sprite'}
            width={skyWidth - 1}
            rows={skyRows}
          />
          {/* Centred, in the concept's colors: violet note, ember artist,
              cool title. A title without a dash stays one cool phrase. */}
          <box style={{ flexDirection: 'row', justifyContent: 'center' }}>
            {state?.nowPlaying !== undefined && state.nowPlaying !== '' ? (
              (() => {
                const split = splitNowPlaying(state.nowPlaying)
                return (
                  <text>
                    <span fg={PERIWINKLE}>{'♪ '}</span>
                    {split !== null ? (
                      <>
                        <span fg={EMBER}>{split.head}</span>
                        <span fg={INK.dim}>{' —— '}</span>
                        <span fg={INK.notice}>{split.rest}</span>
                      </>
                    ) : (
                      <span fg={INK.notice}>{state.nowPlaying}</span>
                    )}
                  </text>
                )
              })()
            ) : (
              <text> </text>
            )}
          </box>
        </box>
      )}
      </box>

      {skyWidth === null && (
        <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1, height: BAND_ROWS }}>
          {band.pet && <Pet pose={pose} />}
          <box style={{ flexGrow: 1, paddingLeft: band.vizPadLeft }}>
            <Visualizer sink={vizSink} accent={accent} />
          </box>
        </box>
      )}

      {/* Persona rides the identity line: the wide strip is the program's
          words, but WHO is on air must survive in the status region (§3.3). */}
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: INK.dim }}>
          {[identity.persona, identity.brain, identity.voice].filter(Boolean).join(' · ')}
        </text>
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
        {/* The listener's channel is periwinkle — the room's one cold accent
            (§6.1): prompt, typed text, and the resting invitation alike. */}
        <text style={{ fg: PERIWINKLE }}>{'> '}</text>
        <input
          ref={input}
          focused={!paneOpen}
          placeholder={paneOpen ? 'settings open — esc to return' : 'type to talk back'}
          style={{
            // The sky composition bounds the field and lets a quiet rule carry
            // the rest of the row (concept 04's input line); long input scrolls
            // inside the field. The band composition keeps the full width.
            ...(skyWidth === null ? { flexGrow: 1 } : { width: Math.min(56, cols - 8) }),
            textColor: PERIWINKLE,
            placeholderColor: mix(PERIWINKLE, INK.bg, 0.4),
            backgroundColor: INK.bg,
          }}
          // The reconciler wires an input's onSubmit to the ENTER event, which
          // carries the submitted string; the declared prop type inherits
          // Textarea's event-shaped signature on top of it (upstream, 0.4.5).
          onSubmit={submit as InputProps['onSubmit']}
        />
        {skyWidth !== null && (
          <box style={{ flexGrow: 1, paddingLeft: 1 }}>
            <text style={{ fg: mix(INK.dim, INK.bg, 0.45) }}>{'─'.repeat(cols)}</text>
          </box>
        )}
      </box>
    </box>
  )
}
