import { describe, expect, it, vi } from 'vitest'

import {
  currentActivity,
  ENGAGED_MS,
  IdleSensor,
  PRESENT_MS,
  type IdleProbe,
} from '../src/director/activity.ts'

const T0 = new Date('2026-07-03T12:00:00')
const at = (ms: number) => new Date(T0.getTime() + ms)

describe('IdleSensor — thresholds (spec 07 §2.1)', () => {
  it('maps idle time to the three states, boundaries pinned', () => {
    const sensor = new IdleSensor()
    sensor.noteInput(T0)
    expect(sensor.state(T0)).toBe('engaged')
    expect(sensor.state(at(ENGAGED_MS - 1))).toBe('engaged')
    expect(sensor.state(at(ENGAGED_MS))).toBe('present')
    expect(sensor.state(at(PRESENT_MS - 1))).toBe('present')
    expect(sensor.state(at(PRESENT_MS))).toBe('away')
    expect(sensor.idleMs(at(1_000))).toBe(1_000)
  })

  it('a never-observed sensor is present, not away (no cold start in quiet mode)', () => {
    const sensor = new IdleSensor()
    expect(sensor.idleMs(T0)).toBeNull()
    expect(sensor.state(T0)).toBe('present')
  })

  it('a later typed line moves the state back to engaged', () => {
    const sensor = new IdleSensor()
    sensor.noteInput(T0)
    expect(sensor.state(at(PRESENT_MS))).toBe('away')
    sensor.noteInput(at(PRESENT_MS))
    expect(sensor.state(at(PRESENT_MS))).toBe('engaged')
  })
})

describe('IdleSensor — the OS probe (spec 07 §3.1, acceptance 2)', () => {
  it('takes the most recent of the typed line and the probe', async () => {
    const probe: IdleProbe = async () => 1_000
    const sensor = new IdleSensor({ probe })
    sensor.noteInput(T0)
    sensor.state(at(PRESENT_MS)) // boundary read kicks the probe
    await vi.waitFor(() => expect(sensor.idleMs(at(PRESENT_MS))).toBe(1_000))
    // The probe saw life 1s before that boundary -> engaged, not away.
    expect(sensor.state(at(PRESENT_MS))).toBe('engaged')
    // ...and its result ages forward from the moment it landed.
    expect(sensor.state(at(PRESENT_MS + PRESENT_MS))).toBe('away')
  })

  it('a probe that throws leaves the sensor on murmur input recency', async () => {
    const probe: IdleProbe = async () => {
      throw new Error('ioreg missing')
    }
    const sensor = new IdleSensor({ probe })
    sensor.noteInput(T0)
    sensor.state(T0)
    await new Promise((r) => setTimeout(r, 5))
    expect(sensor.state(at(PRESENT_MS))).toBe('away')
    expect(sensor.idleMs(at(1_000))).toBe(1_000)
  })

  it('a hanging probe never delays a boundary and is not re-fired while in flight', () => {
    let calls = 0
    const probe: IdleProbe = () => {
      calls++
      return new Promise(() => {}) // never settles
    }
    const sensor = new IdleSensor({ probe })
    sensor.noteInput(T0)
    // Every read returns synchronously from recorded state, whatever the probe does.
    for (let i = 0; i < 5; i++) expect(sensor.state(at(i))).toBe('engaged')
    expect(calls).toBe(1) // single-flight: no pile-up of hung probes
  })

  it('no probe at all is the plain input-recency sensor', () => {
    const sensor = new IdleSensor()
    sensor.noteInput(T0)
    expect(sensor.state(at(ENGAGED_MS))).toBe('present')
  })
})

describe('currentActivity — the MURMUR_ACTIVITY override (spec 07 §3.7)', () => {
  const sensor = new IdleSensor()

  it('forces the state when set to a known value', () => {
    expect(currentActivity(sensor, T0, { MURMUR_ACTIVITY: 'away' })).toBe('away')
    expect(currentActivity(sensor, T0, { MURMUR_ACTIVITY: ' engaged ' })).toBe('engaged')
  })

  it('warns and degrades to the real sensor on an invalid value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(currentActivity(sensor, T0, { MURMUR_ACTIVITY: 'asleep' })).toBe('present')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('unset reads the sensor', () => {
    expect(currentActivity(sensor, T0, {})).toBe('present')
  })
})
