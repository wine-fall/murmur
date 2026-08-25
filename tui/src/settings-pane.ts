// The settings pane's pure logic (spec 12 §3.5/§3.6): what the eight items
// say, which are adjustable right now, and what patch a keypress becomes. The
// pane exposes intent, never field names — the translation to engine knobs
// happens here and nowhere else in the client. Rendering lives in app.tsx.

import {
  LANGUAGE_MAX,
  MIX_EVERY_N,
  MIX_NAMES,
  type MixName,
  type Settings,
  type SettingsPatch,
  type SettingsSnapshot,
} from '../../src/ipc.ts'

// The mix gear presets are shared with the reply turn's change_settings tool
// (spec 12 §2.6); 'custom' is the pane's honest read-only position for a value
// no preset can express.
export type GearName = MixName | 'custom'

export function gearOf(values: Settings): GearName {
  if (values.cadenceMode !== 'every_n') return 'custom'
  return MIX_NAMES.find((name) => MIX_EVERY_N[name] === values.musicEveryN) ?? 'custom'
}

const GAP = { min: 0, max: 10, step: 0.5 }
const WINDOW = { min: 4, max: 48, step: 2 }

export type PaneItemKey =
  | 'anchors'
  | 'music'
  | 'gear'
  | 'gap'
  | 'voice'
  | 'language'
  | 'pet'
  | 'window'

// The one item a keypress cannot step through (spec 12 §3.9): a language is
// free text, so the pane edits it by typing. `adjust` returns null for it and
// the client opens an inline edit instead; this turns what was typed into the
// patch, or null when it is not worth sending.
export function languagePatch(typed: string): SettingsPatch | null {
  const name = typed.trim()
  if (name.length > LANGUAGE_MAX) return null
  // Empty is a real instruction: hand the language back to the persona.
  return { language: name }
}

export type PaneItem = {
  key: PaneItemKey
  label: string
  value: string
  enabled: boolean
  advanced: boolean
}

const onOff = (on: boolean): string => (on ? 'on' : 'off')

// Exactly eight, in a fixed order (spec 12 §1).
export function paneItems(snap: SettingsSnapshot): PaneItem[] {
  const v = snap.values
  const musicOn = snap.musicAvailable && v.musicEnabled
  return [
    { key: 'anchors', label: 'morning & night moments', value: onOff(v.anchorsEnabled), enabled: true, advanced: false },
    { key: 'music', label: 'music', value: onOff(v.musicEnabled), enabled: snap.musicAvailable, advanced: false },
    { key: 'gear', label: 'the mix', value: gearOf(v), enabled: musicOn, advanced: false },
    { key: 'gap', label: 'breathing room', value: `${v.gapSeconds.toFixed(1)}s`, enabled: true, advanced: false },
    // The mute works on any run with a speaker — it is the output gain, not a
    // voice-endpoint feature, so it never greys. The endpoint fact below still
    // explains "sound on but nobody speaks".
    { key: 'voice', label: 'sound', value: v.muted ? 'muted' : 'on', enabled: true, advanced: false },
    // No override = the persona's own word, and the pane says so rather than
    // inventing a value it does not know (spec 12 §3.9).
    { key: 'language', label: 'language', value: v.language ?? "the persona's own", enabled: true, advanced: false },
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
      return { muted: !v.muted }
    // Free text: the client opens an inline edit and sends languagePatch().
    case 'language':
      return null
    case 'gear': {
      const current = MIX_NAMES.indexOf(gearOf(v) as MixName)
      // From custom, any press lands on balanced: selecting a gear overwrites.
      const next = current === -1 ? 1 : current + dir
      const name = MIX_NAMES[next]
      if (name === undefined || next === current) return null
      return { cadenceMode: 'every_n', musicEveryN: MIX_EVERY_N[name] }
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
