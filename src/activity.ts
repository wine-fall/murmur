// Presence sensing (spec 07 §2.1/§3.1): "is the listener around?", derived
// from local idle time only — never keystroke content, never a log of what
// they were doing (master §3.1 privacy boundary).
//
// Three states are enough to drive every pacing policy; more would be knobs
// nobody can tune by ear. Consumers depend on ActivitySensor, never on where
// the signal came from, so a richer source later is a new implementation
// behind the same seam.

import { execFile } from 'node:child_process'

export const ACTIVITIES = ['engaged', 'present', 'away'] as const

export type Activity = (typeof ACTIVITIES)[number]

export interface ActivitySensor {
  // Pure given the sensor's recorded state: the caller supplies the clock, so
  // every threshold is unit-testable without wall-clock waits.
  state(now: Date): Activity
  // Milliseconds since the last observed sign of life; null = never observed.
  idleMs(now: Date): number | null
  // Called on every typed line (the always-available signal).
  noteInput(at: Date): void
}

// By-ear tunable thresholds (spec 04 §3.3 precedent: behavioral shape as
// module constants, not config).
export const ENGAGED_MS = 5 * 60_000
export const PRESENT_MS = 30 * 60_000

// Idle milliseconds reported by the OS, or null when it cannot say.
export type IdleProbe = () => Promise<number | null>

export type IdleSensorOptions = {
  probe?: IdleProbe
  log?: (message: string) => void
}

export class IdleSensor implements ActivitySensor {
  private lastInputMs: number | null = null
  // The last landed probe reading, anchored at the boundary that asked for it —
  // the idle it implies ages forward from there, so a probe that stops
  // answering decays instead of pinning the listener "present" forever. The
  // anchor comes from the caller's clock, never Date.now(), so the whole sensor
  // stays clock-injected.
  private probedIdleMs: number | null = null
  private probedAtMs = 0
  private kickedAtMs = 0
  private inFlight = false

  private probe: IdleProbe | undefined
  private log: (message: string) => void

  constructor({ probe, log = () => {} }: IdleSensorOptions = {}) {
    this.probe = probe
    this.log = log
  }

  noteInput(at: Date): void {
    this.lastInputMs = at.getTime()
  }

  idleMs(now: Date): number | null {
    const t = now.getTime()
    const fromInput = this.lastInputMs === null ? null : t - this.lastInputMs
    const fromProbe = this.probedIdleMs === null ? null : this.probedIdleMs + (t - this.probedAtMs)
    if (fromInput === null) return fromProbe
    if (fromProbe === null) return fromInput
    return Math.min(fromInput, fromProbe) // the most recent sign of life wins
  }

  // Read at a segment boundary. Answers from recorded state — synchronously,
  // always — and kicks the OS probe for the NEXT boundary in the background
  // (§3.1: no timer, no polling loop, and the radio never waits on it).
  state(now: Date): Activity {
    this.kickProbe(now)
    const idle = this.idleMs(now)
    // Never observed: a fresh session where nobody has typed must not open in
    // the quiet mode.
    if (idle === null) return 'present'
    if (idle < ENGAGED_MS) return 'engaged'
    if (idle < PRESENT_MS) return 'present'
    return 'away'
  }

  // Single-flight and fully detached: a probe that throws or hangs past its own
  // timeout leaves the sensor on murmur's own input recency (§3.8).
  private kickProbe(now: Date): void {
    if (this.probe === undefined || this.inFlight) return
    this.inFlight = true
    this.kickedAtMs = now.getTime()
    this.probe()
      .then(
        (idle) => {
          if (idle === null) return
          this.probedIdleMs = idle
          this.probedAtMs = this.kickedAtMs
        },
        (err: unknown) => this.log(`activity: idle probe failed (${String(err)})`),
      )
      .finally(() => (this.inFlight = false))
  }
}

// Bounded ioreg read: `-r -k` returns just the node carrying the key (a few KB)
// instead of the whole IOHIDSystem subtree.
const PROBE_TIMEOUT_MS = 1_500

// The macOS v1 probe (spec 07 §2.1): a plain subprocess read of HIDIdleTime —
// no entitlements, no accessibility permission, no content. Other platforms get
// undefined and the input-recency fallback.
export function osIdleProbe(platform: string = process.platform): IdleProbe | undefined {
  if (platform !== 'darwin') return undefined
  return () =>
    new Promise((resolve, reject) => {
      execFile(
        'ioreg',
        ['-c', 'IOHIDSystem', '-r', '-k', 'HIDIdleTime'],
        { timeout: PROBE_TIMEOUT_MS },
        (err, stdout) => {
          if (err !== null) return reject(err)
          const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout)
          resolve(match === null ? null : Number(match[1]) / 1e6) // ns -> ms
        },
      )
    })
}

// A non-empty but invalid override warns and degrades to the sensor — a typo
// must never break the radio (same posture as MURMUR_SCENE, spec 04 §3.4).
export function currentActivity(
  sensor: ActivitySensor,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Activity {
  const override = env.MURMUR_ACTIVITY?.trim()
  if (override) {
    if ((ACTIVITIES as readonly string[]).includes(override)) return override as Activity
    console.warn(
      `warning: ignoring invalid MURMUR_ACTIVITY=${JSON.stringify(override)} ` +
        `(expected one of ${ACTIVITIES.join(', ')})`,
    )
  }
  return sensor.state(now)
}
