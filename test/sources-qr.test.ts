// The scan loop shared by the QR sign-ins (spec 14 §2.8): draw the code,
// poll on a fixed cadence, stop on confirmation, expiry, patience or Esc.
import { describe, expect, it } from 'vitest'

import { QR_POLL_MS, QR_TIMEOUT_MS, scanToSignIn, type QrPoll } from '../src/music/sources/qr.ts'

function clock(start = 0): { now: () => Date; sleep: (ms: number) => Promise<void>; at: () => number } {
  let t = start
  return { now: () => new Date(t), sleep: async (ms) => void (t += ms), at: () => t }
}

function polls(...steps: QrPoll<string>[]): { poll: () => Promise<QrPoll<string>>; count: () => number } {
  let i = 0
  return {
    poll: async () => steps[Math.min(i++, steps.length - 1)]!,
    count: () => i,
  }
}

describe('scanToSignIn (spec 14 §2.8)', () => {
  it('shows the code once and hands back what the confirmation carried', async () => {
    const shown: string[] = []
    const { poll, count } = polls({ status: 'waiting' }, { status: 'scanned' }, { status: 'confirmed', value: 'the-cookie' })
    const result = await scanToSignIn({ show: (url) => shown.push(url), issue: async () => ({ url: 'https://scan.me/x' }), poll, ...clock() })
    expect(result).toEqual({ ok: true, value: 'the-cookie' })
    expect(shown).toEqual(['https://scan.me/x'])
    expect(count()).toBe(3)
  })

  it('waits QR_POLL_MS between polls and gives up after QR_TIMEOUT_MS', async () => {
    const c = clock()
    const { poll, count } = polls({ status: 'waiting' })
    const result = await scanToSignIn({ show: () => {}, issue: async () => ({ url: 'u' }), poll, ...c })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    expect(c.at()).toBeGreaterThanOrEqual(QR_TIMEOUT_MS)
    expect(count()).toBe(QR_TIMEOUT_MS / QR_POLL_MS)
  })

  it('a code the platform says is expired is a timeout, not a silent hang', async () => {
    const { poll } = polls({ status: 'expired' })
    expect(await scanToSignIn({ show: () => {}, issue: async () => ({ url: 'u' }), poll, ...clock() })).toEqual({ ok: false, reason: 'timeout' })
  })

  it('Esc stops it, before the first poll and between polls', async () => {
    const before = await scanToSignIn({ show: () => {}, issue: async () => ({ url: 'u' }), poll: polls({ status: 'waiting' }).poll, cancelled: () => true, ...clock() })
    expect(before).toEqual({ ok: false, reason: 'cancelled' })
    let scans = 0
    const mid = await scanToSignIn({
      show: () => {},
      issue: async () => ({ url: 'u' }),
      poll: polls({ status: 'waiting' }).poll,
      cancelled: () => scans++ > 0,
      ...clock(),
    })
    expect(mid).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('a confirmation that carries nothing is not a sign-in', async () => {
    const { poll } = polls({ status: 'confirmed' })
    expect(await scanToSignIn({ show: () => {}, issue: async () => ({ url: 'u' }), poll, ...clock() })).toEqual({ ok: false, reason: 'timeout' })
  })
})
