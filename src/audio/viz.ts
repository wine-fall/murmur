// The visualizer feed (spec 10 §3.6): turn one FFT magnitude frame into bars,
// and pace those frames only while a front-end is watching.
//
// The DSP lives engine-side, the pretty lives client-side — so this module ends
// at "an array of 0..1 heights". Glyphs, smoothing, gradients and peak hold are
// the TUI's business (tui/src/bars.ts).
//
// Nothing here imports the audio graph or the wire: the tap is a callback and
// the sink is a callback, which is also why the whole thing is unit-testable
// with no device and no socket (§3.9).

export const VIZ_BINS = 28
export const VIZ_FPS = 24

// A front-end may negotiate the rate (§3.6). Bounds, not preferences: below 1fps
// there is no animation to see, above 60 there is no terminal that shows it and
// the engine is just burning FFTs next to the audio thread.
const FPS_MIN = 1
const FPS_MAX = 60

// The dB window mapped onto 0..1 bar height. Read against the analyser defaults
// (min -100, max -30 dB): the floor sits above the room noise so a quiet bed
// does not paint full bars, the ceiling below 0 so ordinary music reaches the
// top. By-ear knobs (§6: visualizer styling).
const FLOOR_DB = -72
const CEIL_DB = -24

function clampFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) return VIZ_FPS
  return Math.min(Math.max(Math.round(fps), FPS_MIN), FPS_MAX)
}

// Aggregate an FFT magnitude frame (dB, low frequency first) into log-spaced
// bars in 0..1.
//
// Log spacing because pitch is logarithmic: split linearly and four fifths of
// the bars land above 5 kHz, where music has almost nothing to show. Bin 0 is
// skipped — DC carries no pitch and would swamp the first bar. A band takes the
// LOUDEST bin under it rather than the mean: a mean over the wide high bands
// buries every transient, and bars are read as peaks anyway.
//
// Non-finite bins (-Infinity for a silent band, NaN out of an offline render)
// read as silence rather than poisoning the bar.
export function logBins(db: ArrayLike<number>, count = VIZ_BINS): number[] {
  const size = db.length
  if (count <= 0 || size < 2) return []
  const lo = 1
  // Geometric edges, then forced strictly increasing: the low end of a log split
  // hands several bands the same input bin, and a band with no bin is a bar that
  // never moves.
  const edges: number[] = []
  let previous = lo
  for (let i = 0; i <= count; i++) {
    const geometric = Math.floor(lo * (size / lo) ** (i / count))
    const edge = Math.min(Math.max(geometric, previous), size - (count - i))
    edges.push(edge)
    previous = edge + (i === count ? 0 : 1)
  }
  const bars: number[] = []
  for (let i = 0; i < count; i++) {
    const from = edges[i]!
    const to = Math.max(edges[i + 1]!, from + 1)
    let peak = Number.NEGATIVE_INFINITY
    for (let bin = from; bin < to && bin < size; bin++) {
      const value = db[bin]!
      if (Number.isFinite(value) && value > peak) peak = value
    }
    const level = (peak - FLOOR_DB) / (CEIL_DB - FLOOR_DB)
    bars.push(Number.isFinite(level) ? Math.min(Math.max(level, 0), 1) : 0)
  }
  return bars
}

export type VizFeedDeps = {
  // Opens the analyser tap and returns a frame reader. Deferred, not eager: a
  // run nobody is watching never touches the audio graph at all (§5.5), and the
  // tap is only ever opened once however often a client re-subscribes.
  tap: () => () => ArrayLike<number>
  send: (bins: number[]) => void
  bins?: number
}

// The frame pacer. `set` is the whole surface, driven straight off the wire's
// `vizSub` — including the implicit unsubscribe when a front-end disconnects.
export class VizFeed {
  private deps: VizFeedDeps
  private read: (() => ArrayLike<number>) | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(deps: VizFeedDeps) {
    this.deps = deps
  }

  set(on: boolean, fps?: number): void {
    this.stop()
    if (!on) return
    const read = (this.read ??= this.deps.tap())
    const timer = setInterval(
      () => this.deps.send(logBins(read(), this.deps.bins)),
      Math.round(1000 / clampFps(fps)),
    )
    // The visualizer must never be the reason the process stays alive.
    timer.unref()
    this.timer = timer
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}
