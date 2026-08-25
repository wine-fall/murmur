// The four functional regions of spec 10 §3.3: status strip, program log, the
// alive band (pet + visualizer), and an input line that owns focus permanently.
//
// The warmth kit (§3.7) is wired here but authored elsewhere: the sprites are
// assets (pet.ts), the accents are a palette (palette.ts), the bars are
// arithmetic (bars.ts), and the DJ's words for the strip come over the wire from
// the engine's own prompt pool. This file only composes them — which is also why
// the art direction session (§6.1) can restyle murmur without touching logic.

import { useEffect, useRef, useState } from 'react'
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions, type InputProps } from '@opentui/react'
import type { InputRenderable } from '@opentui/core'

import type { EngineMessage, ProgramState, SettingsSnapshot } from '../../src/ipc.ts'
import { Bars, render } from './bars.ts'
import { cardLines, cardTitle, cardTopRow, commandMatches, isCommand, outbound, type Ask } from './dock.ts'
import { circleOf, Constellation, penFor, sceneSplit, WIDE_MIN, type Run } from './constellation.ts'
import {
  cellSizeFrom,
  deleteFigures,
  encodeFigurePng,
  figurePen,
  figureScale,
  placeFigure,
  stagePlan,
} from './figure-image.ts'
import { encodeWavePng, waveGeomFor, waveRowsFor, WAVE_FPS } from './wave-image.ts'
import { identPinned, TAGLINE, WORDMARK } from './logo.ts'
import { accentFor, CARD, CHIP, EMBER, hush, INK, mix, PERIWINKLE, QUIET, WARM, type Accent } from './palette.ts'
import { cells, clock, fit, progressBar } from './progress.ts'
import { adjust, languagePatch, paneFacts, paneItems } from './settings-pane.ts'
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

// The log scrolls, but wears no rail: the sky composition (§6.1) is a night
// with nothing in it but the program. It must ride in as a PROP — the
// reconciler applies props through the setters, and only ScrollBar's `visible`
// setter pins the bar against its own size recalculation. Hoisted for a stable
// reference, so a render does not re-assign the bars and repaint for nothing.
const NO_SCROLLBAR = { visible: false } as const

// The sprites, read once at start-up: they are committed text, not a resource
// that can change under a running client.
const POSES = loadPoses()

// The sky composition's max width (§6.1): the concept frames its page; an
// ultra-wide terminal centers that frame rather than stretching it.
const MAX_COLS = 184

// The now-playing rail (§3.3). Fixed, so the line does not breathe as one
// track's title gives way to another's — and it rides the SAME row as the
// title: the scene band owns a fixed row count, and a row that appears with a
// song would shift the sky out from under the raster layers' absolute anchors.
const RAIL_CELLS = 18

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

// The raster layer's copy of palette.hush(): while a question is on the card
// the figure and the ripple step down the same 0.55 toward the night as every
// text cell, instead of leaving the stage.
const HUSH_FADE = 0.55

type Entry = { id: number; kind: 'segment' | 'user' | 'info' | 'flow'; text: string }

// Padded to one shared column: the two emoji do not render at the same width,
// so a fixed count of spaces after each leaves the log ragged.
const MARKER: Record<Entry['kind'], string> = {
  segment: '\u{1F399} ',
  user: '\u2328\uFE0F ',
  info: '\u00B7  ',
  flow: '\u25A0 ', // the state-transition block: a stopped flow must not drown
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

// The wide-terminal sky (§6.1 quiet-constellation): the radial wave and the
// pet floating over the empty night. Painted on its own clock — viz frames
// only feed the smoother, so the sky breathes (the pet animates) even when
// the engine has nothing to say. Constellation is per-mount; the parent keys
// this component on its size, so a resize builds a fresh sky.
const SKY_FPS = 12

function SkyPanel({
  sink,
  accent,
  pose,
  showPet,
  charWave,
  width,
  rows,
}: {
  sink: VizSink
  accent: Accent
  pose: PoseName
  showPet: boolean
  // The block wave yields to the raster ripple when the graphics channel
  // carries the spectrum instead; the sprite stays either way.
  charWave: boolean
  width: number
  rows: number
}): React.ReactNode {
  const bars = useRef(new Bars())
  const sky = useRef<Constellation | null>(null)
  const tick = useRef(0)
  const [painted, setPainted] = useState<Run[][]>([])
  if (sky.current === null) sky.current = new Constellation(width, rows, penFor(process.env))

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
          charWave ? bars.current.levels() : [],
          accent,
          showPet ? frames[at]! : null,
          pose === 'doze' ? DOZE_FADE : 0,
        ),
      )
    }, 1000 / SKY_FPS)
    return () => clearInterval(timer)
  }, [accent, pose, frames, showPet, charWave])

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
  // Who holds the floor (spec 10 §3.4): the radio, or the setup guide. The
  // engine owns the switch; this client only paints it — strip, identity
  // line, input ink — so the listener always knows who is listening.
  const [mode, setMode] = useState<'radio' | 'guide'>('radio')
  // The rail advances on this client's own clock (§3.3): the engine sends the
  // track's length and its start once, and a tick a second is all the traffic a
  // playing song costs. Nothing ticks when nothing is playing.
  const [now, setNow] = useState(() => Date.now())
  const [paneOpen, setPaneOpen] = useState(false)
  const [paneAt, setPaneAt] = useState(0)
  // The language item is free text (spec 12 §3.9), so it is the one pane row
  // that opens an editor instead of stepping. Non-null = that editor is up and
  // owns every key until Enter commits or Esc backs out.
  const [paneEdit, setPaneEdit] = useState<string | null>(null)
  const pane = useRef({ open: false, at: 0, snap: null as SettingsSnapshot | null, edit: null as string | null })
  pane.current = { open: paneOpen, at: paneAt, snap: settings, edit: paneEdit }
  // The absence the pet greets (§3.7.3). It stands until the program itself has
  // something to say, so the welcome is never cut short by a timer.
  const [greeting, setGreeting] = useState<string | null>(null)
  // The pending questions (§3.2-B), oldest first: the engine marked them, so
  // they do not scroll away with the log. The card shows the head — the one
  // the next typed line answers (lineReader consumes in ask order; a
  // single-slot dock could show B while the answer lands on A, codex review).
  // Questions carry a client-side ordinal for the card title's light counter.
  const [asks, setAsks] = useState<(Ask & { no?: number })[]>([])
  const questionNo = useRef(0)
  const input = useRef<InputRenderable>(null)
  // The line being typed, mirrored for the slash-command menu (§3.2-C): a `/`
  // prefix opens the engine's commands as a small panel over the input, and an
  // exact command warms the ink. Esc hides the menu until the line changes.
  const [typed, setTyped] = useState('')
  const [menuAt, setMenuAt] = useState(0)
  const [menuHidden, setMenuHidden] = useState(false)
  const retype = (value: string): void => {
    setTyped(value)
    setMenuAt(0)
    setMenuHidden(false)
  }
  const matches = commandMatches(typed)
  const menuOpen = matches.length > 0 && !menuHidden && !paneOpen && asks.length === 0
  const menuSel = Math.min(menuAt, Math.max(0, matches.length - 1))
  // Mirrored for the keyboard handler and submit, like the pane's ref.
  const menu = useRef({ open: false, at: 0, count: 0, selected: '' })
  menu.current = {
    open: menuOpen,
    at: menuSel,
    count: matches.length,
    selected: matches[menuSel]?.name ?? '',
  }
  const nextId = useRef(0)
  const vizSink = useRef<((bins: number[]) => void) | null>(null)
  // The ripple's own smoother: the raster wave paints on its own clock in an
  // effect, so it cannot share the SkyPanel's per-component Bars.
  const waveBars = useRef(new Bars())

  useEffect(() => {
    const append = (kind: Entry['kind'], text: string): void =>
      setEntries((prior) => [...prior, { id: nextId.current++, kind, text }].slice(-LOG_MAX))
    return subscribe((message) => {
      switch (message.type) {
        case 'hello':
          setIdentity({ persona: message.persona, brain: message.brain, voice: message.voice })
          setGreeting(awayGreeting(message.away))
          setMode(message.mode ?? 'radio')
          break
        case 'segment':
          append('segment', message.text)
          break
        case 'userLine':
          append('user', message.text)
          break
        case 'info':
          append(message.tone === 'flow' ? 'flow' : 'info', message.text)
          break
        case 'ask':
          // The log keeps the record (the card clears on answer); the card
          // carries the affordance.
          append('info', message.text)
          setAsks((queue) => [
            ...queue,
            message.kind === 'question' ? { ...message, no: ++questionNo.current } : message,
          ])
          break
        case 'mode':
          setMode(message.who)
          break
        case 'askDrop':
          // The flow behind the cards was stopped (Esc): every pending
          // question died with it. The log already keeps the record.
          setAsks([])
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
          waveBars.current.push(message.bins)
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
  // Bracketed paste arrives as its own event, not through useKeyboard, and the
  // input line is unfocused while the pane is open — so without this, pasting a
  // language name into the pane's editor was silently dropped (codex review).
  usePaste((event) => {
    const { open, edit } = pane.current
    if (!open || edit === null) return
    const pasted = new TextDecoder().decode(event.bytes)
    // One line only: a multi-line paste is a mis-paste, and the field is a name.
    setPaneEdit(edit + pasted.replace(/[\r\n]+/g, ' ').trimEnd())
  })

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') return wire.line('/quit')
    // The command menu takes the arrows while it is up (the single-line input
    // has no use for them); Enter stays with the input's own submit, which
    // reads the selection from the ref. Tab completes the highlighted command
    // into the line without running it — the line then IS the command, so the
    // menu closes and the ember ink carries the confirmation.
    if (!pane.current.open && menu.current.open) {
      if (key.name === 'escape') return setMenuHidden(true)
      if (key.name === 'up') return setMenuAt(Math.max(0, menu.current.at - 1))
      if (key.name === 'down') return setMenuAt(Math.min(menu.current.count - 1, menu.current.at + 1))
      if (key.name === 'tab') {
        if (input.current !== null) input.current.value = menu.current.selected
        return retype(menu.current.selected)
      }
    }
    const { open, at, snap, edit } = pane.current
    if (open && edit !== null) {
      // Esc backs out of the edit only — the pane stays up, so a mistyped
      // language never costs the listener the whole pane.
      if (key.name === 'escape') return setPaneEdit(null)
      if (key.name === 'return') {
        const patch = languagePatch(edit)
        if (patch !== null) wire.send({ v: 1, type: 'settingsSet', patch })
        return setPaneEdit(null)
      }
      if (key.name === 'backspace') return setPaneEdit(edit.slice(0, -1))
      // Printable only: a bare letter arrives as its own sequence, while every
      // control/chord carries a modifier or a multi-char escape sequence.
      if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ') {
        return setPaneEdit(edit + key.sequence)
      }
      return
    }
    if (!open || snap === null) {
      // Esc with nothing client-local to close asks the engine to stop the
      // running flow (spec 10 §3.4) — the guide winds down like a coding
      // agent's; with nothing stoppable the engine treats it as noise.
      if (key.name === 'escape') wire.send({ v: 1, type: 'interrupt' })
      return
    }
    if (key.name === 'escape') {
      setPaneEdit(null)
      return setPaneOpen(false)
    }
    const items = paneItems(snap)
    if (key.name === 'up') return setPaneAt(Math.max(0, at - 1))
    if (key.name === 'down') return setPaneAt(Math.min(items.length - 1, at + 1))
    if (['left', 'right', 'space', 'return'].includes(key.name)) {
      const item = items[at]!
      // Seed the editor with the override in force, or empty when the persona
      // still owns the language — there is no text to correct in that case.
      if (item.key === 'language') return setPaneEdit(snap.values.language ?? '')
      const patch = adjust(snap, item.key, key.name === 'left' ? -1 : 1)
      if (patch !== null) wire.send({ v: 1, type: 'settingsSet', patch })
    }
  })

  const submit = (text: string): void => {
    if (input.current !== null) input.current.value = ''
    const chosen = menu.current.open ? menu.current.selected : null
    retype('')
    // Enter on the open menu runs the highlighted command, not the prefix.
    if (chosen !== null) return wire.line(chosen)
    const line = outbound(text, asks.length > 0)
    if (line === null) return
    setAsks((queue) => queue.slice(1))
    wire.line(line)
  }

  // The hour's accent, swapped whenever the engine reports a new scene (§3.7.2).
  const accent = accentFor(state?.scene)
  // The spotlight dim (§3.2-B as built): while a question is on the card, the
  // room steps down one notch — the card and the answer field keep the light.
  const hushed = asks.length > 0
  const lit = (color: string): string => (hushed ? hush(color) : color)
  const roomAccent: Accent = hushed
    ? { dim: hush(accent.dim), bright: hush(accent.bright) }
    : accent
  // The raster layer sits ABOVE text cells; while the card is up, the figure
  // and the ripple stay on stage hushed like the room — a sky that goes dark
  // under every consent reads as the interface breaking — yielding only the
  // rows the card itself needs (spec 10 §3.2-B).
  const hushRef = useRef(hushed)
  hushRef.current = hushed
  const pose = greeting !== null ? 'wake' : poseFor(state)
  // The §6.1 breakpoint: wide terminals stack the sky as a full-width scene
  // band over the log (scene:log ≈ 2:1 — the listener is here for the radio,
  // not the transcript); narrow ones keep the classic bottom band. Same four
  // regions either way (§3.3) — only the composition moves.
  const dims = useTerminalDimensions()
  // The composition has a max width: past it, a wide terminal gets symmetric
  // margins instead of a stretched scene.
  const cols = Math.min(dims.width, MAX_COLS)
  const gutter = Math.floor((dims.width - cols) / 2)
  const wide = cols >= WIDE_MIN
  // Where the spotlight card begins, for the raster paint loops: they keep
  // the stage hushed above this row and yield it below (null = no card). The
  // command menu borrows the same yield — a kitty image composites above text
  // cells, so its rows (matches + border + footer, anchored 2 above bottom)
  // must be clear of rasters too.
  const cardTop =
    asks.length > 0
      ? cardTopRow(asks[0]!.text, cols, dims.height)
      : menuOpen
        ? Math.max(1, dims.height - 2 - (matches.length + 3))
        : null
  const cardTopRef = useRef(cardTop)
  cardTopRef.current = cardTop
  // In the sky composition the strip is one centred line over a full-width
  // rule (concept 04), and now-playing lives under the scene; in the band
  // composition the strip stays two-sided and carries now-playing itself.
  const guideFloor = mode === 'guide'
  const strip =
    !wide
      ? [guideFloor ? 'in the workshop' : (greeting ?? microcopy ?? 'warming up...'), state?.nowPlaying]
          .filter((part) => part !== undefined && part !== '')
          .join('  ♪ ')
      : [
          guideFloor ? 'in the workshop' : (greeting ?? microcopy ?? 'murmur is on the air'),
          guideFloor ? 'the setup guide has the floor' : state?.scene,
          guideFloor ? undefined : (state?.activity ?? 'here'),
        ]
          .filter((part) => part !== undefined && part !== '')
          .join(' · ')
  // A track with a known length is the only thing that earns a rail: a live
  // stream (or an extractor that omits the duration) keeps the bare title.
  const track =
    state?.kind === 'music' && state.startedAt !== undefined && (state.durationS ?? 0) > 0
      ? { startedAt: state.startedAt, durationS: state.durationS! }
      : null
  useEffect(() => {
    if (track === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
    // The identity of the TRACK, not of the object: a re-emit during the song
    // (a typed line refreshing presence) must not restart the interval.
  }, [track?.startedAt, track?.durationS])
  const elapsedS = track === null ? 0 : (now - track.startedAt) / 1000

  // The alive band's composition follows the live pet setting (spec 12 §3.7),
  // with the env override resolved inside bandLayout.
  const band = bandLayout(process.env, settings?.values.tuiPet)
  const items = paneOpen && settings !== null ? paneItems(settings) : null
  // Rows left once the strip, its rule, now-playing, identity, and input take
  // theirs, split scene-over-log at 2:1. The scene spans the frame minus its
  // one-cell side padding.
  const { scene: sceneRows, log: logRows } = sceneSplit(Math.max(dims.height - 5, 10))
  const sceneWidth = cols - 2
  // Whether the scene band holds the stage. The settings pane always reclaims
  // its rows (a mode the listener opened is their own full attention). The
  // spotlight card takes none: it floats over the room (§3.2-B), so the sky
  // stays on stage dimmed beneath it — only the raster layers yield, and only
  // where the card's own rows reach (stagePlan / waveRowsFor via the refs).
  const sceneShown = wide && !paneOpen
  // The station ident stays on stage in the wide composition — pinned
  // between the scene and the log when the log can spare the rows, so the
  // guide's tool narration cannot scroll it away; the narrow band keeps the
  // classic in-log ident that the program scrolls away itself.
  const pinnedIdent = identPinned(wide, logRows)
  const sceneShownRef = useRef(sceneShown)
  sceneShownRef.current = sceneShown
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
  // The pose rides a ref so a pose change swaps the NEXT transmitted frame in
  // place (same image id) instead of tearing the effect down: delete + resettle
  // blanked the figure for over half a second on every state change — the
  // start-of-broadcast flash. Only a real relayout re-runs the effect.
  const poseRef = useRef(pose)
  poseRef.current = pose
  useEffect(() => {
    if (!wide || figMode !== 'image' || !band.pet) return
    let loop: ReturnType<typeof setInterval> | undefined
    const settle = setTimeout(() => {
      const cell = cellSizeFrom(renderer.resolution, dims.width, dims.height)
      const spriteCols = POSES.idle[0]![0]!.length
      const scale = figureScale(cell?.width ?? 0, spriteCols)
      // Every pose shares the sprite grid, so geometry is computed once and a
      // pose's PNGs are encoded on first use.
      const pngCache = new Map<string, Buffer[]>()
      const pngsFor = (name: PoseName, hushedNow: boolean): Buffer[] => {
        const key = hushedNow ? `${name}:hushed` : name
        let pngs = pngCache.get(key)
        if (pngs === undefined) {
          const fade = Math.max(name === 'doze' ? DOZE_FADE : 0, hushedNow ? HUSH_FADE : 0)
          pngs = POSES[name].map((frame) => encodeFigurePng(frame, scale, fade))
          pngCache.set(key, pngs)
        }
        return pngs
      }
      const imgCols = Math.ceil((spriteCols * scale) / (cell?.width ?? 8))
      const imgRows = Math.ceil((POSES.idle[0]!.length * scale) / (cell?.height ?? 16))
      const centerRow = 2 + circleOf(sceneWidth * 2, sceneRows * 4).cy / 4
      const sceneLeft = gutter + 1
      const col = Math.max(1, Math.round(sceneLeft + sceneWidth / 2 - imgCols / 2) + 1)
      const row = Math.max(1, Math.round(centerRow - imgRows / 2) + 1)
      // Retransmitting under one id replaces the frame in place — the pose
      // loop is a stream of tiny PNGs, each pose advancing at its own rate
      // against one shared clock.
      const started = performance.now()
      let shown = ''
      const paint = (): void => {
        const plan = sceneShownRef.current
          ? stagePlan(hushRef.current, cardTopRef.current, row, imgRows)
          : 'off'
        if (plan === 'off') {
          if (shown !== '') {
            shown = ''
            rawOut.writeOut(deleteFigures())
          }
          return
        }
        const name = poseRef.current
        const pngs = pngsFor(name, plan === 'hushed')
        const at = Math.floor(((performance.now() - started) / 1000) * POSE_FPS[name])
        const key = `${name}:${at % pngs.length}:${plan}`
        if (key === shown) return
        shown = key
        rawOut.writeOut(placeFigure(pngs[at % pngs.length]!, row, col, 1))
      }
      paint()
      loop = setInterval(paint, 1000 / Math.max(...Object.values(POSE_FPS)))
    }, 600)
    return () => {
      clearTimeout(settle)
      clearInterval(loop)
      rawOut.writeOut(deleteFigures())
    }
  }, [wide, cols, gutter, sceneRows, sceneWidth, figMode, band.pet, renderer, dims.width, dims.height])

  // The grain-ripple wave (§6.1): on a kitty-graphics terminal the spectrum
  // rides the same channel as the figure — stardust ripples in device pixels
  // over the whole panel (image id 2, under the figure's z). Silence
  // transmits one transparent frame and then stays quiet.
  const accentRef = useRef(accent)
  accentRef.current = accent
  // The block wave holds the panel until the ripple proves it can run: a
  // terminal that will not report its cell pixel size cannot be given a
  // full-panel raster (a guessed cell size paints the wrong area at the wrong
  // scale), so it keeps the character wave instead.
  const [rasterWave, setRasterWave] = useState(false)
  useEffect(() => {
    if (!wide || figMode !== 'image') return
    let loop: ReturnType<typeof setInterval> | undefined
    let tick = 0
    let wasSilent = false
    const settle = setTimeout(() => {
      const cell = cellSizeFrom(renderer.resolution, dims.width, dims.height)
      if (cell === null) return
      setRasterWave(true)
      const geom = waveGeomFor(sceneWidth, sceneRows, cell)
      const col = gutter + 2
      const row = 3
      let hidden = false
      const paint = (): void => {
        const hushedNow = hushRef.current
        const rows = sceneShownRef.current
          ? waveRowsFor(hushedNow, cardTopRef.current, row, sceneRows)
          : 0
        if (rows === 0) {
          if (!hidden) {
            hidden = true
            // d=A drops the figure too; its own loop self-heals in one beat.
            rawOut.writeOut(deleteFigures())
          }
          wasSilent = false
          return
        }
        hidden = false
        const levels = waveBars.current.levels()
        const silent = levels.every((level) => level === 0)
        if (silent && wasSilent) return
        wasSilent = silent
        // The clipped geometry ends the raster above the card; the hushed
        // color is the room's own step down, so the ripple dims with it.
        const g = rows === sceneRows ? geom : waveGeomFor(sceneWidth, rows, cell)
        const bright = hushedNow ? hush(accentRef.current.bright) : accentRef.current.bright
        rawOut.writeOut(placeFigure(encodeWavePng(levels, tick++, g, bright), row, col, 2, 0))
      }
      paint()
      loop = setInterval(paint, 1000 / WAVE_FPS)
    }, 600)
    return () => {
      clearTimeout(settle)
      clearInterval(loop)
      setRasterWave(false)
      // d=A also drops the figure; its own effect shares these deps and
      // repaints, and a stray delete self-heals within one 12fps beat.
      rawOut.writeOut(deleteFigures())
    }
  }, [wide, cols, gutter, sceneRows, sceneWidth, figMode, renderer, dims.width, dims.height])

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
      {!wide ? (
        <box
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: INK.bg,
          }}
        >
          <text style={{ fg: guideFloor ? lit(WARM) : roomAccent.bright }}>{strip}</text>
          <text style={{ fg: lit(INK.dim) }}>
            {[identity.persona, state?.scene, state?.activity].filter(Boolean).join(' · ')}
          </text>
        </box>
      ) : (
        <box style={{ flexDirection: 'column' }}>
          <box style={{ flexDirection: 'row', justifyContent: 'center', height: 1 }}>
            <text style={{ fg: guideFloor ? lit(WARM) : roomAccent.bright }}>{strip}</text>
          </box>
          <text style={{ fg: lit(mix(INK.dim, INK.bg, 0.45)) }}>{'─'.repeat(cols)}</text>
        </box>
      )}

      {/* The scene band (§3.3 stacked): the sky spans the frame with the log
          beneath it — the radio's face first, its words second. Now-playing
          sits under the scene as the §6.1 centred tricolor line. The band
          steps off the stage only when sceneShown says its rows belong to an
          overlay instead. */}
      {sceneShown && (
        <box
          style={{
            flexDirection: 'column',
            paddingLeft: 1,
            paddingRight: 1,
            // The scene owns its rows outright: without a fixed height the
            // log's content pushes yoga to shrink the band from under the
            // raster anchors, which are computed from sceneRows.
            height: sceneRows + 1,
            flexShrink: 0,
          }}
        >
          <SkyPanel
            key={`${sceneWidth}x${sceneRows}`}
            sink={vizSink}
            accent={roomAccent}
            pose={pose}
            showPet={band.pet && figMode === 'sprite'}
            charWave={!rasterWave}
            width={sceneWidth}
            rows={sceneRows}
          />
          <box style={{ flexDirection: 'row', justifyContent: 'center' }}>
            {state?.nowPlaying !== undefined && state.nowPlaying !== '' ? (
              (() => {
                const rail = track === null ? null : progressBar(elapsedS, track.durationS, RAIL_CELLS)
                const times = track === null ? '' : `  ${clock(elapsedS)} / ${clock(track.durationS)}`
                // One row, always: the band's rows are fixed (§3.3), so a label
                // long enough to wrap takes a row the sky is standing on — and
                // the raster layers stay anchored to the rows it left. The
                // budget is the frame minus the band's padding, the note, and
                // whatever the rail and its clocks are using.
                const split = splitNowPlaying(
                  fit(state.nowPlaying, cols - 4 - (rail === null ? 0 : 3 + RAIL_CELLS + cells(times))),
                )
                return (
                  <text>
                    <span fg={lit(PERIWINKLE)}>{'♪ '}</span>
                    {split !== null ? (
                      <>
                        <span fg={lit(EMBER)}>{split.head}</span>
                        <span fg={lit(INK.dim)}>{' —— '}</span>
                        <span fg={lit(INK.notice)}>{split.rest}</span>
                      </>
                    ) : (
                      <span fg={lit(INK.notice)}>
                        {fit(
                          state.nowPlaying,
                          cols - 4 - (rail === null ? 0 : 3 + RAIL_CELLS + cells(times)),
                        )}
                      </span>
                    )}
                    {rail !== null && track !== null && (
                      <>
                        <span fg={lit(INK.dim)}>{'   '}</span>
                        <span fg={lit(PERIWINKLE)}>{rail.played}</span>
                        <span fg={lit(mix(INK.dim, INK.bg, 0.35))}>{rail.rest}</span>
                        <span fg={lit(INK.dim)}>{times}</span>
                      </>
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

      {/* flexBasis 0: the log's rows are whatever the column has LEFT, never
          its content height — a content-sized basis overflows the column once
          the log outgrows its viewport, and yoga then shaves the strip block
          above the scene band. The band shifts up one row while the raster
          layers stay anchored to absolute rows, and the wave's rectangle lands
          on the band's last text row — slicing the wordmark / now-playing. */}
      <box style={{ flexGrow: 1, flexBasis: 0, flexDirection: 'row' }}>
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
                {`${index === paneAt ? '▸ ' : '  '}${item.label.padEnd(24)}${
                  // The open editor shows what is being typed, with a caret, so
                  // the row is the field rather than a stale value beside one.
                  paneEdit !== null && item.key === 'language' ? `${paneEdit}▏` : item.value
                }`}
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
        <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        {pinnedIdent && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginTop: 1,
              marginBottom: 1,
              flexShrink: 0,
            }}
          >
            {WORDMARK.map((row, at) => (
              <text key={at} style={{ fg: lit(INK.text) }}>
                {row}
              </text>
            ))}
            <text style={{ fg: lit(INK.dim) }}>{TAGLINE}</text>
          </box>
        )}
        <scrollbox
          stickyScroll
          stickyStart="bottom"
          scrollbarOptions={NO_SCROLLBAR}
          style={{
            flexGrow: 1,
            paddingLeft: !wide ? 1 : 2,
            paddingRight: 1,
            rootOptions: { backgroundColor: INK.bg },
          }}
        >
          {/* The station ident (§3.3 as built): pinned above in the wide
              composition; opening the log — scrolled away by the program
              itself — everywhere else. */}
          {!pinnedIdent && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginTop: 1,
              marginBottom: 2,
            }}
          >
            {WORDMARK.map((row, at) => (
              <text key={at} style={{ fg: lit(INK.text) }}>
                {row}
              </text>
            ))}
            <box style={{ marginTop: 1 }}>
              <text style={{ fg: lit(INK.dim) }}>{TAGLINE}</text>
            </box>
          </box>
          )}
          {entries.map((entry) => (
            // The sky composition lets the log breathe — one blank line between
            // entries, the poem spacing of §6.1, no icon markers (the speaker
            // lives in the color), the newest broadcast line carrying a bullet.
            // The band composition stays dense with its marker column.
            <box key={entry.id} style={{ marginBottom: !wide ? 0 : 1 }}>
              <text
                style={{
                  fg: lit(
                    entry.kind === 'segment'
                      ? accent.bright
                      : entry.kind === 'user'
                        ? INK.user
                        : entry.kind === 'flow'
                          ? WARM
                          : INK.notice,
                  ),
                }}
              >
                {!wide
                  ? MARKER[entry.kind]
                  : entry.id === latestSegment
                    ? '● '
                    : entry.kind === 'flow'
                      ? '■ '
                      : entry.kind === 'info'
                        ? '· '
                        : ''}
                {entry.text}
              </text>
            </box>
          ))}
        </scrollbox>
        </box>
      )}

      </box>

      {!wide && (
        <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1, height: BAND_ROWS }}>
          {band.pet && <Pet pose={pose} />}
          <box style={{ flexGrow: 1, paddingLeft: band.vizPadLeft }}>
            <Visualizer sink={vizSink} accent={roomAccent} />
          </box>
        </box>
      )}

      {/* Persona rides the identity line: the wide strip is the program's
          words, but WHO is on air must survive in the status region (§3.3). */}
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
        <text style={{ fg: guideFloor ? lit(WARM) : lit(INK.dim) }}>
          {guideFloor
            ? ['setup guide', identity.brain].filter(Boolean).join(' · ')
            : [identity.persona, identity.brain, identity.voice].filter(Boolean).join(' · ')}
        </text>
      </box>

      {/* The spotlight card (§3.2-B as built): the oldest pending ask grows
          into a centered rounded card while the room around it is hushed.
          It FLOATS — absolutely positioned over the log, one gap row above
          the bottom rule, taking no rows from the layout: the room behind it
          dims but never rearranges. Kind picks the frame: warm for a
          question, periwinkle for a consent — the listener's color, because
          the decision is theirs. */}
      {/* The command menu (§3.2-C): the engine's commands as a small panel
          floating over the room, anchored where the spotlight card floats —
          above the input, never rearranging it. Arrows choose, Enter runs the
          highlighted command, Tab completes it into the line, Esc puts it
          away until the line changes. */}
      {menuOpen &&
        (() => {
          const nameCol = Math.max(...matches.map((c) => c.name.length))
          return (
            <box
              style={{
                border: true,
                borderStyle: 'rounded',
                borderColor: mix(PERIWINKLE, INK.bg, 0.35),
                flexDirection: 'column',
                position: 'absolute',
                left: gutter + 1,
                bottom: 2,
                zIndex: 100,
                paddingLeft: 1,
                paddingRight: 1,
                backgroundColor: CARD,
              }}
            >
              {matches.map((command, at) => (
                <text key={command.name} style={{ bg: at === menuSel ? CHIP : CARD }}>
                  <span fg={at === menuSel ? EMBER : PERIWINKLE}>
                    {` ${command.name.padEnd(nameCol)}`}
                  </span>
                  <span fg={at === menuSel ? INK.text : INK.notice}>{`  ${command.blurb} `}</span>
                </text>
              ))}
              <text style={{ fg: QUIET }}>{' tab completes · enter runs · esc hides'}</text>
            </box>
          )
        })()}
      {asks.length > 0 &&
        (() => {
          const head = asks[0]!
          const consent = head.kind === 'consent'
          const frame = consent ? PERIWINKLE : WARM
          const lines = cardLines(head.text)
          const facts = lines.some((l) => l.role === 'ready' || l.role === 'gap')
          const width = Math.min(Math.floor(cols * 0.55), cols - 4)
          const ROLE_FG = {
            main: INK.text,
            note: INK.notice,
            ready: INK.user,
            gap: INK.notice,
            option: INK.notice,
          } as const
          // The divider stands between the facts and the choices: above the
          // first option row when the card carries its own, else above the
          // closing invite (legacy checklist shape).
          const divideAt = lines.some((l) => l.role === 'option')
            ? lines.findIndex((l) => l.role === 'option')
            : lines.length - 1
          return (
            <box
              title={cardTitle(head.kind, head.no ?? 0, facts)}
              style={{
                border: true,
                borderStyle: 'rounded',
                borderColor: frame,
                titleColor: consent ? PERIWINKLE : EMBER,
                flexDirection: 'column',
                position: 'absolute',
                // Yoga anchors absolute insets to the parent's border box, so
                // the ultrawide gutter must be added back to stay centered.
                left: gutter + Math.floor((cols - width) / 2),
                bottom: 2,
                zIndex: 100,
                width,
                paddingLeft: 2,
                paddingRight: 2,
                paddingTop: 1,
                paddingBottom: 1,
                backgroundColor: CARD,
              }}
            >
              {lines.map((line, at) => (
                <box key={at} style={{ flexDirection: 'column' }}>
                  {/* Facts above, the decision below — the divider says so. */}
                  {facts && at === divideAt && (
                    <text style={{ fg: hush(INK.dim) }}>{'─'.repeat(Math.max(width - 6, 1))}</text>
                  )}
                  {line.role === 'option' ? (
                    // One choice per line, its key on a chip — each answer key
                    // must read as an option, Enter never as a silent default.
                    <text>
                      <span fg={INK.text} bg={CHIP}>{` ${line.text.split(' - ')[0]} `}</span>
                      <span fg={ROLE_FG.option}>{`  ${line.text.split(' - ').slice(1).join(' - ')}`}</span>
                    </text>
                  ) : (
                    <text style={{ fg: ROLE_FG[line.role] }}>
                      {line.role === 'ready' ? 'ok  ' : line.role === 'gap' ? '--  ' : ''}
                      {line.text}
                    </text>
                  )}
                </box>
              ))}
              {consent ? (
                facts ? null : (
                  <box style={{ marginTop: 1 }}>
                    <text>
                      <span fg={INK.notice}>{'y - go ahead'}</span>
                      <span fg={INK.notice}>{'   '}</span>
                      <span fg={INK.text} bg={CHIP}>{' > N - not now '}</span>
                      <span fg={INK.notice}>{' (Enter)'}</span>
                    </text>
                  </box>
                )
              ) : (
                <box style={{ marginTop: 1 }}>
                  <text style={{ fg: QUIET }}>{'Enter skips'}</text>
                </box>
              )}
              {/* The answer is typed INTO the card (user decision, 2026-08-11):
                  same single input, permanent focus — it just sits where the
                  question is while one is open. */}
              <box style={{ flexDirection: 'row', marginTop: 1 }}>
                <text style={{ fg: PERIWINKLE }}>{'> '}</text>
                <input
                  ref={input}
                  focused={!paneOpen}
                  placeholder={
                    consent
                      ? facts
                        ? 'y / Enter / n - the options above'
                        : 'y or Enter - one key decides'
                      : 'your answer - enter sends'
                  }
                  style={{
                    flexGrow: 1,
                    textColor: PERIWINKLE,
                    focusedTextColor: PERIWINKLE,
                    placeholderColor: mix(PERIWINKLE, INK.bg, 0.4),
                    backgroundColor: CARD,
                    focusedBackgroundColor: CARD,
                  }}
                  onSubmit={submit as InputProps['onSubmit']}
                />
              </box>
            </box>
          )
        })()}

      {/* While a question is open, the answer field lives in the card; the
          bottom row keeps only its quiet rule so the frame stays closed. */}
      {asks.length === 0 ? (
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
              (§6.1): prompt, typed text, and the resting invitation alike. A
              line the engine will take as a command warms to ember instead. */}
          <text style={{ fg: guideFloor ? WARM : PERIWINKLE }}>{'> '}</text>
          <input
            ref={input}
            focused={!paneOpen}
            placeholder={
              paneOpen
                ? 'settings open — esc to return'
                : guideFloor
                  ? 'talking to the setup guide · esc interrupts · /done hands back'
                  : 'type to talk back · / for commands'
            }
            style={{
              // The sky composition bounds the field and lets a quiet rule carry
              // the rest of the row (concept 04's input line); long input scrolls
              // inside the field. The band composition keeps the full width.
              ...(!wide ? { flexGrow: 1 } : { width: Math.min(56, cols - 8) }),
              // The field is permanently focused (§3.2), so the focused pair is
              // the ink that actually paints; the base pair keeps them honest.
              textColor: isCommand(typed) ? EMBER : guideFloor ? WARM : PERIWINKLE,
              focusedTextColor: isCommand(typed) ? EMBER : guideFloor ? WARM : PERIWINKLE,
              placeholderColor: mix(guideFloor ? WARM : PERIWINKLE, INK.bg, 0.4),
              backgroundColor: INK.bg,
              focusedBackgroundColor: INK.bg,
            }}
            onInput={retype}
            // The reconciler wires an input's onSubmit to the ENTER event, which
            // carries the submitted string; the declared prop type inherits
            // Textarea's event-shaped signature on top of it (upstream, 0.4.5).
            onSubmit={submit as InputProps['onSubmit']}
          />
          {wide && (
            <box style={{ flexGrow: 1, paddingLeft: 1 }}>
              <text style={{ fg: lit(mix(INK.dim, INK.bg, 0.45)) }}>{'─'.repeat(cols)}</text>
            </box>
          )}
        </box>
      ) : (
        <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: lit(mix(INK.dim, INK.bg, 0.45)) }}>{'─'.repeat(cols)}</text>
        </box>
      )}
    </box>
  )
}
