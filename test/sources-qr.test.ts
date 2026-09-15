// The scan loop shared by the QR sign-ins (spec 14 §2.8): draw the code,
// poll on a fixed cadence, stop on confirmation, expiry, patience or Esc.
import { describe, expect, it } from 'vitest'

import { QR_CANCEL_POLL_MS, QR_POLL_MS, QR_TIMEOUT_MS, scanToSignIn, type QrPoll } from '../src/music/sources/qr.ts'
import { quitLatch } from '../src/setup/guide.ts'

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

  // The card's footer follows the scan (spec 10 §3.2-E): 'scanned' means the
  // phone has the code and the person has not confirmed yet, which is a
  // different wait and reads as one. Reported on CHANGE, so a three-minute
  // wait does not redraw the code ninety times.
  it('reports each status change once, so the card can say what is being waited on', async () => {
    const seen: string[] = []
    const { poll } = polls({ status: 'waiting' }, { status: 'waiting' }, { status: 'scanned' }, { status: 'scanned' }, { status: 'confirmed', value: 'c' })
    await scanToSignIn({ show: () => {}, issue: async () => ({ url: 'u' }), poll, onStatus: (s) => seen.push(s), ...clock() })
    expect(seen).toEqual(['waiting', 'scanned', 'confirmed'])
  })

  it('a confirmation that carries nothing is not a sign-in', async () => {
    const { poll } = polls({ status: 'confirmed' })
    expect(await scanToSignIn({ show: () => {}, issue: async () => ({ url: 'u' }), poll, ...clock() })).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('scanToSignIn and a typed /quit (spec 14 §3.1)', () => {
  it('wakes out of the wait a quarter second after the latch, not at the end of the cadence', async () => {
    // No read is open while a code is on screen, so the engine's latch — what
    // a typed /quit and the TUI's Ctrl-C both fire — is the only way out.
    const quit = quitLatch()
    const c = clock()
    const result = await scanToSignIn({
      show: () => {},
      issue: async () => ({ url: 'u' }),
      poll: async () => ({ status: 'waiting' }),
      now: c.now,
      sleep: async (ms) => {
        quit.fire()
        await c.sleep(ms)
      },
      cancelled: () => quit.requested,
    })
    expect(result).toEqual({ ok: false, reason: 'cancelled' })
    expect(c.at()).toBeLessThanOrEqual(QR_CANCEL_POLL_MS)
  })
})
