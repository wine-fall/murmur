// The daily lane (spec 14 §3.10): the platforms' own pick of the day for this
// listener, rendered as its own block of the pick situation.
//
// A lane and not a `TasteKind` on purpose: it is not what the listener keeps,
// so counting it into "Artists they return to" would put the platform's guess
// in the listener's mouth; it is never written to the taste ledger; and it
// rides its own 24 h clock rather than §3.4's per-kind one, which polls the
// fresh kinds every three hours.

import type { DailySong } from '../contracts.ts'

export const DAILY_STALE_MS = 24 * 60 * 60 * 1000
// How long a day whose feeds all failed waits before asking again. The pick
// pokes this far more often than the clock it rides, so without a floor a
// cookie that stopped signing in would be read again at every boundary.
export const DAILY_RETRY_MS = 60 * 60 * 1000
// What one lane is allowed to spend of the situation: enough to be a shelf,
// short enough that it cannot crowd out the turns above it.
export const DAILY_ITEMS = 12
export const DAILY_HEADING = '## New for them today'

// One platform's recommendation feed. `id` names it in the dev log and
// nowhere else.
export type DailyFeed = { id: string; read: () => Promise<DailySong[]> }

export type DailyLaneDeps = {
  // Read per refresh, never captured: a listener who mounts an account
  // mid-session through `/sources` gets a lane on the next day's read, and
  // one who disconnects stops being read with a credential that is gone.
  feeds: () => readonly DailyFeed[]
  now?: () => Date
  log?: (message: string) => void
}

const line = (song: DailySong): string =>
  `- "${song.title}" ${song.artist}${song.reason === undefined ? '' : ` — ${song.reason}`}`

export class DailyLane {
  private deps: DailyLaneDeps
  private songs: DailySong[] = []
  private readAt = 0
  private triedAt = 0
  private inFlight: Promise<void> | null = null

  constructor(deps: DailyLaneDeps) {
    this.deps = deps
  }

  // Fire-and-forget from the pick path: it resolves, it never rejects, and a
  // read already in flight is the answer to a second call.
  maybeRefresh(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))().getTime()
    if (this.inFlight !== null) return this.inFlight
    if (this.readAt !== 0 && now - this.readAt < DAILY_STALE_MS) return Promise.resolve()
    if (this.triedAt !== 0 && now - this.triedAt < DAILY_RETRY_MS) return Promise.resolve()
    this.inFlight = this.refresh(now).finally(() => (this.inFlight = null))
    return this.inFlight
  }

  private async refresh(now: number): Promise<void> {
    this.triedAt = now
    const read = await Promise.all(
      this.deps.feeds().map(async (feed) => {
        try {
          const songs = await feed.read()
          // Counts only, never a title (spec 14 §3.6).
          this.deps.log?.(`music.daily ${feed.id} n=${songs.length}`)
          return songs
        } catch (err) {
          this.deps.log?.(`music.daily ${feed.id} failed: ${String(err)}`)
          return null
        }
      }),
    )
    const answered = read.filter((songs): songs is DailySong[] => songs !== null).flat()
    // A day whose every feed failed keeps yesterday's lane: a stale shelf is
    // worth more to a pick than an empty one.
    if (answered.length === 0) return
    this.songs = answered.slice(0, DAILY_ITEMS)
    this.readAt = now
  }

  block(): string {
    if (this.songs.length === 0) return ''
    return [
      DAILY_HEADING,
      "The platforms' own picks for this listener today, with the reason each gives.",
      'They are not theirs yet — which is the point of the lane.',
      ...this.songs.map(line),
    ].join('\n')
  }
}
