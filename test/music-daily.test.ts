// The daily lane (spec 14 §3.10 step 4): the platforms' own pick of the day,
// a lane of its own beside the taste block. Not a TasteKind — it is not what
// the listener keeps, it never reaches the ledger, and it rides a 24 h clock
// of its own rather than §3.4's.
import { describe, expect, it } from 'vitest'

import { DAILY_RETRY_MS, DailyLane, DAILY_STALE_MS } from '../src/music/daily.ts'
import type { DailySong } from '../src/contracts.ts'
import { buildMusicSituation } from '../src/prompts/music.ts'

const song = (n: number, reason?: string): DailySong => ({
  ref: `https://music.163.com/#/song?id=${n}`,
  title: `track ${n}`,
  artist: `singer ${n}`,
  ...(reason !== undefined && { reason }),
})

function lane(reads: (() => Promise<DailySong[]>)[], at = new Date('2026-09-21T10:00:00Z')) {
  let now = at
  const log: string[] = []
  const l = new DailyLane({
    feeds: () => reads.map((read, i) => ({ id: `feed${i}`, read })),
    now: () => now,
    log: (m) => log.push(m),
  })
  return { lane: l, log, tick: (ms: number) => (now = new Date(now.getTime() + ms)) }
}

describe('DailyLane', () => {
  it('renders nothing until a feed has answered', async () => {
    const { lane: l } = lane([async () => [song(1)]])
    expect(l.block()).toBe('')
    await l.maybeRefresh()
    expect(l.block()).toContain('"track 1" singer 1')
  })

  it('names the platform\'s reason where it gave one, and says nothing where it did not', async () => {
    const { lane: l } = lane([async () => [song(1, 'kept by over 45% of listeners'), song(2)]])
    await l.maybeRefresh()
    const block = l.block()
    expect(block).toContain('- "track 1" singer 1 — kept by over 45% of listeners')
    expect(block.split('\n').at(-1)).toBe('- "track 2" singer 2')
    expect(block.split('\n')[0]).toMatch(/^## /)
  })

  it('reads once a day, not once a pick, and never two reads at once', async () => {
    let reads = 0
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const { lane: l, tick } = lane([
      async () => {
        reads++
        await gate
        return [song(reads)]
      },
    ])
    const first = l.maybeRefresh()
    void l.maybeRefresh()
    release()
    await first
    expect(reads).toBe(1)
    await l.maybeRefresh()
    expect(reads).toBe(1)
    tick(DAILY_STALE_MS + 1)
    await l.maybeRefresh()
    expect(reads).toBe(2)
  })

  it('keeps yesterday\'s lane when today\'s read fails, and logs a count with no title in it', async () => {
    let fail = false
    const { lane: l, log, tick } = lane([async () => {
      if (fail) throw new Error('expired cookie for <redacted>')
      return [song(1)]
    }])
    await l.maybeRefresh()
    fail = true
    tick(DAILY_STALE_MS + 1)
    await l.maybeRefresh()
    expect(l.block()).toContain('"track 1"')
    expect(log.join('\n')).toContain('music.daily feed0 n=1')
    expect(log.join('\n')).not.toContain('track 1')
    expect(log.join('\n')).toMatch(/music\.daily feed0 failed/)
  })

  // A cookie that stopped signing in would otherwise be read again at every
  // pick, all day: the pick is poked far more often than the clock it rides.
  it('waits before trying a failed feed again, instead of once per pick', async () => {
    let reads = 0
    const { lane: l, tick } = lane([async () => {
      reads++
      throw new Error('expired')
    }])
    await l.maybeRefresh()
    await l.maybeRefresh()
    expect(reads).toBe(1)
    tick(DAILY_RETRY_MS + 1)
    await l.maybeRefresh()
    expect(reads).toBe(2)
  })

  // A listener mounts an account mid-session through /sources; the lane was
  // built before that and must not be deaf to it -- nor go on reading an
  // account that was disconnected.
  it('reads the feeds that are mounted NOW, not the ones that were at boot', async () => {
    let reads: (() => Promise<DailySong[]>)[] = []
    let now = new Date('2026-09-21T10:00:00Z')
    const l = new DailyLane({ feeds: () => reads.map((read, i) => ({ id: `feed${i}`, read })), now: () => now })
    await l.maybeRefresh()
    expect(l.block()).toBe('')
    reads = [async () => [song(1)]]
    now = new Date(now.getTime() + DAILY_RETRY_MS + 1)
    await l.maybeRefresh()
    expect(l.block()).toContain('"track 1"')
  })

  it('merges the feeds it has and drops the one that is not wired', async () => {
    const { lane: l } = lane([async () => [song(1)], async () => [song(2)]])
    await l.maybeRefresh()
    expect(l.block()).toContain('"track 1"')
    expect(l.block()).toContain('"track 2"')
  })

  it('rides the music situation as its own block, and renders nothing when empty', () => {
    const { lane: l } = lane([])
    expect(buildMusicSituation([], [], '', '')).toBe(buildMusicSituation([], []))
    const situation = buildMusicSituation([], [], '', '## New for them today\n- "track 1" singer 1')
    expect(situation).toContain('## New for them today')
    expect(situation).toContain('Intent: a music break')
    expect(l.block()).toBe('')
  })

  it('answers a refresh that nothing is wired for without touching anything', async () => {
    const { lane: l, log } = lane([])
    await l.maybeRefresh()
    expect(l.block()).toBe('')
    expect(log).toEqual([])
  })
})
