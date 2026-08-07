// The settings pane's pure logic (spec 12 §3.5/§3.6): what the seven items
// say, which are adjustable right now, and what patch a keypress becomes. The
// pane exposes intent, never field names — the translation to engine knobs
// happens here and nowhere else in the client. Rendering lives in app.tsx.

import type { Settings, SettingsPatch, SettingsSnapshot } from '../../src/ipc.ts'

// The mix gear (spec 12 §3.5): three presets the pane can write, plus the
// honest read-only position for values the pane cannot express.
const GEARS = [
  { name: 'more music', musicEveryN: 1 },
  { name: 'balanced', musicEveryN: 2 },
  { name: 'more talk', musicEveryN: 4 },
] as const

export type GearName = (typeof GEARS)[number]['name'] | 'custom'

export function gearOf(values: Settings): GearName {
  if (values.cadenceMode !== 'every_n') return 'custom'
  return GEARS.find((gear) => gear.musicEveryN === values.musicEveryN)?.name ?? 'custom'
}

const GAP = { min: 0, max: 10, step: 0.5 }
const WINDOW = { min: 4, max: 48, step: 2 }

export type PaneItemKey = 'anchors' | 'music' | 'gear' | 'gap' | 'voice' | 'pet' | 'window'

export type PaneItem = {
  key: PaneItemKey
  label: string
  value: string
  enabled: boolean
  advanced: boolean
}

const onOff = (on: boolean): string => (on ? 'on' : 'off')

// Exactly seven, in a fixed order (spec 12 §1 — the ceiling, not a tranche).
export function paneItems(snap: SettingsSnapshot): PaneItem[] {
  const v = snap.values
  const musicOn = snap.musicAvailable && v.musicEnabled
  return [
    { key: 'anchors', label: 'morning & night moments', value: onOff(v.anchorsEnabled), enabled: true, advanced: false },
    { key: 'music', label: 'music', value: onOff(v.musicEnabled), enabled: snap.musicAvailable, advanced: false },
    { key: 'gear', label: 'the mix', value: gearOf(v), enabled: musicOn, advanced: false },
    { key: 'gap', label: 'breathing room', value: `${v.gapSeconds.toFixed(1)}s`, enabled: true, advanced: false },
    { key: 'voice', label: 'voice', value: v.voice === 'stub' ? 'muted' : 'on', enabled: snap.voiceConfigured, advanced: false },
    { key: 'pet', label: 'pixel pet', value: onOff(v.tuiPet), enabled: true, advanced: false },
    { key: 'window', label: 'memory span', value: String(v.recentWindow), enabled: true, advanced: true },
  ]
}

// The read-only lines under the advanced divider (spec 12 §1): facts, never
// secrets — the endpoint's existence, not the endpoint.
export function paneFacts(snap: SettingsSnapshot): { label: string; value: string }[] {
  return [
    { label: 'stored at', value: snap.home },
    { label: 'voice endpoint', value: snap.voiceConfigured ? 'configured' : 'not configured' },
  ]
}

function stepped(
  current: number,
  dir: -1 | 1,
  range: { min: number; max: number; step: number },
): number | null {
  const next = Math.min(range.max, Math.max(range.min, current + dir * range.step))
  return next === current ? null : next
}

// One keypress on one item -> the patch to send, or null when there is nothing
// to do (a greyed item, a stepper at its bound). Toggles flip on any direction;
// space/enter callers pass dir 1.
export function adjust(snap: SettingsSnapshot, key: PaneItemKey, dir: -1 | 1): SettingsPatch | null {
  const item = paneItems(snap).find((entry) => entry.key === key)
  if (item === undefined || !item.enabled) return null
  const v = snap.values
  switch (key) {
    case 'anchors':
      return { anchorsEnabled: !v.anchorsEnabled }
    case 'music':
      return { musicEnabled: !v.musicEnabled }
    case 'pet':
      return { tuiPet: !v.tuiPet }
    case 'voice':
      // Mute writes 'stub'; unmute clears the key so the engine re-derives
      // (spec 12 §3.4) — 'hosted' is never written from here.
      return v.voice === 'stub' ? { voice: null } : { voice: 'stub' }
    case 'gear': {
      const current = GEARS.findIndex((gear) => gear.name === gearOf(v))
      // From custom, any press lands on balanced: selecting a gear overwrites.
      const next = current === -1 ? 1 : current + dir
      const gear = GEARS[next]
      if (gear === undefined || next === current) return null
      return { cadenceMode: 'every_n', musicEveryN: gear.musicEveryN }
    }
    case 'gap': {
      const next = stepped(v.gapSeconds, dir, GAP)
      return next === null ? null : { gapSeconds: next }
    }
    case 'window': {
      const next = stepped(v.recentWindow, dir, WINDOW)
      return next === null ? null : { recentWindow: next }
    }
  }
}
