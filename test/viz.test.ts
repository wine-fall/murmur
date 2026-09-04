// The visualizer feed (spec 10 §3.6): the DSP-to-bars reduction and the
// attach-aware gating. Both are deterministic, so both live in the fast layer —
// no audio device, no TUI, no Bun (§3.9).

import { afterEach, describe, expect, it, vi } from 'vitest'

import { logBins, VizFeed, VIZ_BINS, VIZ_FPS } from '../src/audio/viz.ts'

// One FFT frame: silent everywhere except the named bins, which are loud.
function frame(size: number, loud: Record<number, number>): Float32Array {
  const db = new Float32Array(size).fill(Number.NEGATIVE_INFINITY)
  for (const [index, value] of Object.entries(loud)) db[Number(index)] = value
  return db
}

describe('logBins (spec 10 §3.6: ~24-32 log-spaced magnitude bins)', () => {
  it('reduces a frame to the asked-for number of bars', () => {
    expect(logBins(frame(512, {}))).toHaveLength(VIZ_BINS)
    expect(logBins(frame(512, {}), 32)).toHaveLength(32)
    expect(VIZ_BINS).toBeGreaterThanOrEqual(24)
    expect(VIZ_BINS).toBeLessThanOrEqual(32)
  })

  it('reads silence as flat zero, including the -Infinity an offline render emits', () => {
    expect(logBins(frame(512, {}))).toEqual(Array.from({ length: VIZ_BINS }, () => 0))
    const nan = new Float32Array(512).fill(Number.NaN)
    expect(logBins(nan).every((bar) => bar === 0)).toBe(true)
  })

  it('clamps a frame louder than the ceiling to full-height bars', () => {
    const hot = new Float32Array(512).fill(0)
    expect(logBins(hot).every((bar) => bar === 1)).toBe(true)
  })

  it('puts a low tone in the low bars and a high tone in the high bars', () => {
    const low = logBins(frame(512, { 1: 0 }))
    expect(low[0]).toBe(1)
    expect(low.at(-1)).toBe(0)

    const high = logBins(frame(512, { 511: 0 }))
    expect(high.at(-1)).toBe(1)
    expect(high[0]).toBe(0)
  })

  it('leaves no input bin unrepresented — every band is non-empty', () => {
    // The log spacing crowds the low end, where a naive geometric split hands
    // several bands the same (or no) input bin and the bars go dead.
    const size = 512
    for (let bin = 1; bin < size; bin++) {
      const bars = logBins(frame(size, { [bin]: 0 }))
      expect(bars.some((bar) => bar > 0), `bin ${bin} lit no bar`).toBe(true)
    }
  })

  it('survives a degenerate frame instead of returning junk', () => {
    expect(logBins(new Float32Array(0))).toEqual([])
    expect(logBins(frame(512, {}), 0)).toEqual([])
  })
})

describe('VizFeed (spec 10 §3.6: free when unwatched, §5.5)', () => {
  afterEach(() => vi.useRealTimers())

  function feed(opts: { fps?: number } = {}) {
    const sent: number[][] = []
    let taps = 0
    let reads = 0
    const it = new VizFeed({
      tap: () => {
        taps += 1
        return () => {
          reads += 1
          return frame(512, { 1: 0 })
        }
      },
      send: (bins) => void sent.push(bins),
      ...opts,
    })
    return { it, sent, taps: () => taps, reads: () => reads }
  }

  it('never touches the audio graph while nobody is subscribed', () => {
    vi.useFakeTimers()
    const f = feed()
    vi.advanceTimersByTime(1000)
    expect(f.taps()).toBe(0)
    expect(f.reads()).toBe(0)
    expect(f.sent).toEqual([])
  })

  it('sends frames at the subscribed rate once a front-end asks', () => {
    vi.useFakeTimers()
    const f = feed()
    f.it.set(true, 20)
    vi.advanceTimersByTime(1000)
    expect(f.sent.length).toBe(20)
    expect(f.sent[0]).toHaveLength(VIZ_BINS)
    expect(f.taps()).toBe(1)
  })

  it('defaults to the spec rate when the front-end names none', () => {
    vi.useFakeTimers()
    const f = feed()
    f.it.set(true)
    vi.advanceTimersByTime(1000)
    // A whole-millisecond period cannot divide a second exactly at 24fps.
    expect(f.sent.length).toBeGreaterThan(VIZ_FPS - 2)
    expect(f.sent.length).toBeLessThanOrEqual(VIZ_FPS)
  })

  it('stops reading the moment the front-end unsubscribes or goes away', () => {
    vi.useFakeTimers()
    const f = feed()
    f.it.set(true, 20)
    vi.advanceTimersByTime(500)
    const sentWhileWatched = f.sent.length
    expect(sentWhileWatched).toBeGreaterThan(0)
    f.it.set(false)
    const readsWhileWatched = f.reads()
    vi.advanceTimersByTime(2000)
    expect(f.sent.length).toBe(sentWhileWatched)
    expect(f.reads()).toBe(readsWhileWatched)
  })

  it('re-subscribing replaces the ticker instead of stacking a second one', () => {
    vi.useFakeTimers()
    const f = feed()
    f.it.set(true, 20)
    f.it.set(true, 20)
    f.it.set(true, 20)
    vi.advanceTimersByTime(1000)
    expect(f.sent.length).toBe(20)
    // The tap is opened once: one analyser, however often a client resubscribes.
    expect(f.taps()).toBe(1)
  })

  it('clamps an absurd or unusable rate rather than melting the engine', () => {
    vi.useFakeTimers()
    const fast = feed()
    fast.it.set(true, 10_000)
    vi.advanceTimersByTime(1000)
    expect(fast.sent.length).toBeLessThanOrEqual(60)
    fast.it.stop()

    const bad = feed()
    bad.it.set(true, Number.NaN)
    vi.advanceTimersByTime(1000)
    expect(bad.sent.length).toBeGreaterThan(VIZ_FPS - 2)
    expect(bad.sent.length).toBeLessThanOrEqual(VIZ_FPS)
    bad.it.stop()
  })

  it('stop() is safe on a feed that was never subscribed', () => {
    const f = feed()
    expect(() => f.it.stop()).not.toThrow()
  })
})
