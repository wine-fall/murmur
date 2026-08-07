// The settings layer (spec 12): the listener's knobs, persisted at
// $MURMUR_HOME/settings.json and held live by the engine-owned SettingsStore —
// the single mutation path for the TUI pane today and any agent tool later.
//
// The file is hand-editable AND panel-written, so reads salvage per key: one
// broken value is dropped alone (a lost mute state is a real harm), good keys
// survive, unknown keys are ignored. Writes are temp-file + rename (the
// voice-config discipline) so a reader never sees a torn file; no secret ever
// lives here, so no permission ceremony.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SettingsPatchSchema, SettingsValuesSchema, type Settings, type SettingsPatch } from './ipc.ts'

export const SETTINGS_FILE = 'settings.json'

type Log = (message: string) => void

// Everything on disk is Partial: absence means "the user never touched this
// knob", which falls through to the layer below at boot (spec 12 §2.2).
export function readSettingsFile(path: string, log: Log = () => {}): Partial<Settings> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log(`settings: ${path} is not JSON; ignoring it`)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) {
    log(`settings: ${path} is not an object; ignoring it`)
    return {}
  }
  const values: Partial<Settings> = {}
  for (const key of Object.keys(SettingsValuesSchema.shape) as (keyof Settings)[]) {
    if (!(key in parsed)) continue
    const checked = SettingsValuesSchema.shape[key].safeParse(
      (parsed as Record<string, unknown>)[key],
    )
    if (checked.success) Object.assign(values, { [key]: checked.data })
    else log(`settings: ignoring unusable ${key} in ${path}`)
  }
  return values
}

export function writeSettingsFile(path: string, values: Partial<Settings>): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
}

export type SettingsStoreDeps = {
  path: string
  // The merged boot Config's values — flags and env respected as the start.
  initial: Settings
  // The file's keys at boot: what the user has explicitly set, and therefore
  // what set() persists around. Never grows a key the user did not touch.
  touched: Partial<Settings>
  // What `voice` resolves to when the mute key is cleared (spec 12 §3.4):
  // endpoint configured => hosted, else stub. A thunk because the endpoint can
  // arrive mid-boot through the setup conversation.
  derivedVoice: () => 'stub' | 'hosted'
  log?: Log
}

// The single settings authority (spec 12 §2.4). Layering is boot-time only:
// a set() here is the newest user intent and wins over whatever flags said at
// launch (§2.3).
export class SettingsStore {
  private live: Settings
  private touched: Partial<Settings>
  private deps: SettingsStoreDeps
  private listeners: ((next: Settings) => void)[] = []

  constructor(deps: SettingsStoreDeps) {
    this.deps = deps
    this.live = { ...deps.initial }
    this.touched = { ...deps.touched }
  }

  current(): Settings {
    return { ...this.live }
  }

  onChange(listener: (next: Settings) => void): void {
    this.listeners.push(listener)
  }

  // Validate -> apply -> persist -> notify. False = nothing applied (an empty
  // or invalid patch); the caller answers with an unchanged snapshot so the
  // pane always shows truth.
  set(patch: SettingsPatch): boolean {
    const checked = SettingsPatchSchema.safeParse(patch)
    if (!checked.success) return false
    const entries = Object.entries(checked.data).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return false
    for (const [key, value] of entries) {
      if (key === 'voice' && value === null) {
        // Unmute: back to the derived voice, and the file forgets the key.
        delete this.touched.voice
        this.live.voice = this.deps.derivedVoice()
        continue
      }
      Object.assign(this.live, { [key]: value })
      Object.assign(this.touched, { [key]: value })
    }
    try {
      writeSettingsFile(this.deps.path, this.touched)
    } catch (err) {
      // The live change stands even if the disk does not: the radio obeys the
      // listener now, and the loss is only next boot's default.
      this.deps.log?.(`settings: could not persist (${String(err)})`)
    }
    const next = this.current()
    for (const listener of this.listeners) listener(next)
    return true
  }
}
