// The real-world topic pool (spec 13 §2.1), the roll (§2.3) and the off-loop
// refresh (§3.1): file-backed, expiring, single-flight, and never on the talk
// path.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { FetchedTopic, FetchTopicsRequest } from '../src/contracts.ts'
import { RWT_FETCH_SYSTEM_PROMPT } from '../src/prompts.ts'
import { fetchTopicsTask, RealWorldTopics, RwtPool, RwtRoll } from '../src/rwt.ts'
import { callTool, FakeHarness, until } from './fakes.ts'

const HOUR = 3600
const topic = (title: string, over: Partial<FetchedTopic> = {}): FetchedTopic => ({
  title,
  gist: `${title} happened.`,
  category: 'news',
  ...over,
})

function poolAt(clock: { now: number }, over: { ttlHours?: number; staleHours?: number } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'murmur-rwt-')), 'rwt.json')
  return { path, pool: new RwtPool({ path, now: () => clock.now, ...over }) }
}

describe('RwtPool (spec 13 §2.1)', () => {
  it('starts empty on a missing file and is due for a refresh', () => {
    const { pool } = poolAt({ now: 1000 })
    expect(pool.counts()).toEqual({ fresh: 0, used: 0 })
    expect(pool.refreshDue()).toBe(true)
    expect(pool.take()).toBeNull()
  })

  it('merge persists the entries and stamps the refresh; take marks used and persists', () => {
    const clock = { now: 10 * HOUR }
    const { path, pool } = poolAt(clock)
    expect(pool.merge([topic('A'), topic('B')])).toBe(2)
    expect(pool.refreshDue()).toBe(false)
    expect(pool.counts()).toEqual({ fresh: 2, used: 0 })

    const first = pool.take()
    expect(first?.title).toBe('A')
    const second = pool.take()
    expect(second?.title).toBe('B')
    expect(second?.id).not.toBe(first?.id)
    expect(pool.take()).toBeNull()
    expect(pool.counts()).toEqual({ fresh: 0, used: 2 })

    // A second pool over the same file sees the same state — nothing is only
    // in memory.
    const again = new RwtPool({ path, now: () => clock.now })
    expect(again.counts()).toEqual({ fresh: 0, used: 2 })
    expect(again.take()).toBeNull()
    expect(again.refreshDue()).toBe(false)
  })

  it('an entry older than ttl drops on load; the pool goes stale after staleHours', () => {
    const clock = { now: 100 * HOUR }
    const { path, pool } = poolAt(clock, { ttlHours: 48, staleHours: 6 })
    pool.merge([topic('old')])
    clock.now += 5 * HOUR
    expect(pool.refreshDue()).toBe(false)
    clock.now += 2 * HOUR
    expect(pool.refreshDue()).toBe(true)
    expect(pool.counts().fresh).toBe(1) // stale is not expired
    clock.now += 48 * HOUR
    const reloaded = new RwtPool({ path, now: () => clock.now, ttlHours: 48 })
    expect(reloaded.counts()).toEqual({ fresh: 0, used: 0 })
  })

  it('merge skips titles already in the pool and lists them for the fetch to avoid', () => {
    const { pool } = poolAt({ now: 1000 })
    pool.merge([topic('A')])
    expect(pool.merge([topic('A'), topic('B')])).toBe(1)
    expect(pool.titles()).toEqual(['A', 'B'])
  })

  it('an unwritable cache never throws on the talk path: the take stands in memory', () => {
    const { pool } = poolAt({ now: 1000 })
    pool.merge([topic('A'), topic('B')])
    const dir = mkdtempSync(join(tmpdir(), 'murmur-rwt-ro-'))
    const stuck = new RwtPool({ path: dir, now: () => 1000 }) // a directory: every write fails
    expect(stuck.merge([topic('A')])).toBe(1)
    expect(stuck.take()?.title).toBe('A')
    expect(stuck.take()).toBeNull()
  })

  it('an expired entry does not block a recurring title from coming back', () => {
    const clock = { now: 100 * HOUR }
    const { pool } = poolAt(clock, { ttlHours: 48 })
    pool.merge([topic('A')])
    clock.now += 49 * HOUR // the process outlived the entry; nothing reloaded
    expect(pool.merge([topic('A')])).toBe(1)
    expect(pool.counts()).toEqual({ fresh: 1, used: 0 })
  })

  it('a malformed file is an empty pool, not a boot failure', () => {
    const { path } = poolAt({ now: 1000 })
    writeFileSync(path, '{not json')
    const pool = new RwtPool({ path, now: () => 1000 })
    expect(pool.counts()).toEqual({ fresh: 0, used: 0 })
    pool.merge([topic('A')])
    expect(JSON.parse(readFileSync(path, 'utf-8')).entries).toHaveLength(1)
  })
})

describe('RwtRoll (spec 13 §2.3)', () => {
  it('holds off until minGap and forces an offer at maxGap', () => {
    const roll = new RwtRoll({ p: 1, minGap: 2, maxGap: 4, random: () => 0 })
    expect(roll.roll()).toBe(false) // 1 batch since the last offer
    expect(roll.roll()).toBe(true) // 2 — p wins
    const never = new RwtRoll({ p: 0, minGap: 1, maxGap: 3, random: () => 0.99 })
    expect(never.roll()).toBe(false)
    expect(never.roll()).toBe(false)
    expect(never.roll()).toBe(true) // 3 — guardrail
    expect(never.roll()).toBe(false) // the counter reset
  })

  it('uses the injected RNG against p in between', () => {
    const rolls = [0.1, 0.9]
    const roll = new RwtRoll({ p: 0.35, minGap: 1, maxGap: 9, random: () => rolls.shift()! })
    expect(roll.roll()).toBe(true)
    expect(roll.roll()).toBe(false)
  })
})

function feed(over: {
  fetch?: (req: FetchTopicsRequest) => Promise<FetchedTopic[]>
  roll?: RwtRoll
  clock?: { now: number }
  covered?: () => readonly string[]
} = {}) {
  const clock = over.clock ?? { now: 1000 }
  const { pool } = poolAt(clock)
  const requests: FetchTopicsRequest[] = []
  const lines: string[] = []
  const rwt = new RealWorldTopics({
    pool,
    roll: over.roll ?? new RwtRoll({ p: 1, minGap: 0, maxGap: 1, random: () => 0 }),
    brain: {
      fetchTopics: async (req) => {
        requests.push(req)
        return over.fetch === undefined ? [topic('A'), topic('B')] : over.fetch(req)
      },
    },
    request: () => ({ language: 'Japanese', timezone: 'Asia/Tokyo', today: '2026-09-03', follows: '' }),
    ...(over.covered !== undefined && { covered: over.covered }),
    log: (m) => lines.push(m),
  })
  return { pool, rwt, requests, lines, clock }
}

describe('RealWorldTopics (spec 13 §2.4 / §3.1)', () => {
  it('refreshes once in the background when due, single-flight, and merges the result', async () => {
    const { pool, rwt, requests, lines } = feed()
    expect(rwt.maybeRefresh()).toBe(true)
    expect(rwt.maybeRefresh()).toBe(false) // in flight
    await rwt.drain()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.avoid).toEqual([])
    expect(requests[0]?.language).toBe('Japanese')
    expect(pool.counts()).toEqual({ fresh: 2, used: 0 })
    expect(rwt.maybeRefresh()).toBe(false) // no longer due
    expect(lines.some((l) => /^rwt\.refresh n=2 ms=\d+$/.test(l))).toBe(true)
    expect(lines.some((l) => l === 'rwt.pool fresh=2 used=0')).toBe(true)
  })

  it('offers only when the roll lands and the pool has an unused entry', async () => {
    const rolls = [0.99, 0.0]
    const { rwt, lines } = feed({ roll: new RwtRoll({ p: 0.5, minGap: 0, maxGap: 9, random: () => rolls.shift()! }) })
    expect(rwt.offer()).toBeNull() // pool empty: the roll is not even consumed
    rwt.maybeRefresh()
    await rwt.drain()
    expect(rwt.offer()).toBeNull() // 0.99 > p
    const offered = rwt.offer()
    expect(offered?.title).toBe('A')
    expect(lines).toContain(`rwt.offer ${offered?.id}`)
  })

  it('a failed fetch costs one log line and leaves the pool as it was', async () => {
    const { pool, rwt, lines } = feed({ fetch: async () => Promise.reject(new Error('offline')) })
    rwt.maybeRefresh()
    await rwt.drain()
    expect(pool.counts()).toEqual({ fresh: 0, used: 0 })
    expect(lines).toContain('rwt.refresh failed (Error: offline)')
    expect(rwt.maybeRefresh()).toBe(true) // still due, retried
  })

  it('the fetch is told what is already in the pool', async () => {
    const { rwt, requests, clock } = feed()
    rwt.maybeRefresh()
    await rwt.drain()
    clock.now += 7 * HOUR
    rwt.maybeRefresh()
    await until(() => requests.length === 2)
    expect(requests[1]?.avoid).toEqual(['A', 'B'])
  })

  // spec 13 §3.7: the pool forgets in 48 h; what was told on air is in the
  // ledger, so the fetch is told both — once each, in that order.
  it('the fetch is told what was told on air too, and a returned one is not merged', async () => {
    const { pool, rwt, requests, clock } = feed({
      covered: () => ['B', 'Old story'],
      fetch: async () => [topic('A'), topic('B'), topic('Old story'), topic('C')],
    })
    rwt.maybeRefresh()
    await rwt.drain()
    expect(requests[0]?.avoid).toEqual(['B', 'Old story'])
    expect(pool.titles()).toEqual(['A', 'C'])
    clock.now += 7 * HOUR
    rwt.maybeRefresh()
    await until(() => requests.length === 2)
    expect(requests[1]?.avoid).toEqual(['A', 'C', 'B', 'Old story'])
  })

  // codex review: a fetch that returns only ledgered titles must count as a
  // failed refresh — merging nothing would stamp the pool fresh and leave it
  // empty and silent for a whole stale interval.
  it('a fetch that returns only covered titles is a failed refresh, retried', async () => {
    const { pool, rwt, lines } = feed({
      covered: () => ['Old story'],
      fetch: async () => [topic('Old story')],
    })
    rwt.maybeRefresh()
    await rwt.drain()
    expect(pool.counts()).toEqual({ fresh: 0, used: 0 })
    expect(lines).toContain('rwt.refresh failed (nothing new returned)')
    expect(rwt.maybeRefresh()).toBe(true) // still due
  })
})

// The fetch task itself (spec 13 §2.2): WebSearch bounded in, one terminal
// tool out, the researcher framing. Played through the fake harness so the
// termination rule and the schema are exercised with no network.
describe('fetchTopicsTask (spec 13 §2.2)', () => {
  const req: FetchTopicsRequest = {
    language: 'Japanese',
    timezone: 'Asia/Tokyo',
    today: '2026-09-03',
    avoid: [],
    follows: '',
  }

  it('names WebSearch as its one built-in, bounds the turns, and frames neutrally', async () => {
    const harness = new FakeHarness()
    await harness.runTask(fetchTopicsTask(req, 'model-x'))
    const task = harness.lastTask!
    expect(task.builtins).toEqual(['WebSearch'])
    expect(task.maxTurns).toBe(12)
    expect(task.model).toBe('model-x')
    expect(task.systemPrompt).toBe(RWT_FETCH_SYSTEM_PROMPT)
    expect(task.prompt).toContain('Asia/Tokyo')
    expect(task.tools(() => {}).map((t) => t.name)).toEqual(['submit_topics'])
  })

  it('submit_topics finishes the task with the cleaned items', async () => {
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'submit_topics', {
        topics: [
          { title: '  A  ', gist: ' a happened ', category: 'news' },
          { title: '', gist: 'nothing', category: 'news' },
        ],
      })
    })
    const got = await harness.runTask(fetchTopicsTask(req, 'model-x'))
    expect(got).toEqual([{ title: 'A', gist: 'a happened', category: 'news' }])
  })

  it('a call with nothing usable does not finish the task', async () => {
    const harness = new FakeHarness(async (tools) => {
      await callTool(tools, 'submit_topics', { topics: [{ title: '', gist: '', category: '' }] })
    })
    expect(await harness.runTask(fetchTopicsTask(req, 'model-x'))).toBeNull()
  })
})
