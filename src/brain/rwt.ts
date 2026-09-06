// Real-world topics (spec 13): a small file-backed pool of things that actually
// happened, fetched OFF the live loop and read from at talk-generation time.
//
// Three pieces, each the shape of something already here: the pool is a
// cache file with expiry; the roll is RandomCadence one rung down (a
// probability with guardrails over a counter); the feed launches the fetch the
// way the Compactor launches a fold — single-flight, unawaited, total. The
// talk path only ever touches `offer()`, a synchronous read.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { Brain, FetchedTopic, FetchTopicsRequest, RwtTopic, Task } from '../contracts.ts'
import { buildFetchTopicsPrompt, RWT_FETCH_SYSTEM_PROMPT } from '../prompts/rwt.ts'

// --- the pool (§2.1) ------------------------------------------------------ //

const TopicSchema = z.object({
  id: z.string(),
  title: z.string(),
  gist: z.string(),
  category: z.string(),
  fetchedAt: z.number(),
  used: z.boolean(),
})

const PoolFileSchema = z.object({
  refreshedAt: z.number().optional(),
  entries: z.array(TopicSchema),
})

type PoolFile = z.infer<typeof PoolFileSchema>

export type RwtPoolOptions = {
  path: string
  ttlHours?: number
  staleHours?: number
  // Epoch seconds; injected so tests own the clock.
  now?: () => number
  log?: (message: string) => void
}

const DEFAULT_TTL_HOURS = 48
const DEFAULT_STALE_HOURS = 6

export class RwtPool {
  private path: string
  private ttlS: number
  private staleS: number
  private now: () => number
  private log: ((message: string) => void) | undefined
  private file: PoolFile

  constructor({ path, ttlHours = DEFAULT_TTL_HOURS, staleHours = DEFAULT_STALE_HOURS, now, log }: RwtPoolOptions) {
    this.path = path
    this.ttlS = ttlHours * 3600
    this.staleS = staleHours * 3600
    this.now = now ?? (() => Date.now() / 1000)
    this.log = log
    this.file = this.load()
  }

  // A missing, unreadable or malformed file is an empty pool — the cache is
  // rebuildable, so nothing here may fail a boot. Expired entries drop here.
  private load(): PoolFile {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf-8'))
    } catch {
      return { entries: [] }
    }
    const checked = PoolFileSchema.safeParse(parsed)
    if (!checked.success) return { entries: [] }
    return { ...checked.data, entries: checked.data.entries.filter((e) => this.fresh(e)) }
  }

  private fresh(entry: RwtTopic): boolean {
    return this.now() - entry.fetchedAt < this.ttlS
  }

  // Best-effort: the in-memory state stands whether or not the disk took it.
  // take() runs on the talk path, and an unwritable cache must cost a line in
  // the log, never the radio.
  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(this.file, null, 2)}\n`, 'utf-8')
    } catch (err) {
      this.log?.(`rwt.pool not persisted (${String(err)})`)
    }
  }

  refreshDue(): boolean {
    const at = this.file.refreshedAt
    return at === undefined || this.now() - at >= this.staleS
  }

  titles(): string[] {
    return this.file.entries.filter((e) => this.fresh(e)).map((e) => e.title)
  }

  counts(): { fresh: number; used: number } {
    const live = this.file.entries.filter((e) => this.fresh(e))
    const used = live.filter((e) => e.used).length
    return { fresh: live.length - used, used }
  }

  // The oldest fresh unused entry, marked used at TAKE time: a beat generated
  // and then discarded still burns its topic (a repeat costs more than a miss).
  take(): RwtTopic | null {
    const index = this.file.entries.findIndex((e) => !e.used && this.fresh(e))
    if (index === -1) return null
    const taken = { ...this.file.entries[index]!, used: true }
    this.file.entries[index] = taken
    this.save()
    return taken
  }

  // Add what a fetch brought back, skipping titles already held, and stamp
  // the refresh. Returns how many were new.
  // Add what a fetch brought back, skipping titles still held — an expired
  // entry is dropped first, so a recurring story can come back — and stamp
  // the refresh. Returns how many were new.
  merge(topics: readonly FetchedTopic[]): number {
    const entries = this.file.entries.filter((e) => this.fresh(e))
    const held = new Set(entries.map((e) => e.title))
    const at = this.now()
    let added = 0
    for (const topic of topics) {
      if (held.has(topic.title)) continue
      held.add(topic.title)
      entries.push({ ...topic, id: randomUUID().slice(0, 8), fetchedAt: at, used: false })
      added++
    }
    this.file = { refreshedAt: at, entries }
    this.save()
    return added
  }
}

// --- the roll (§2.3) ------------------------------------------------------ //

export type RwtRollOptions = {
  p?: number
  minGap?: number
  maxGap?: number
  // Injected so tests are deterministic.
  random?: () => number
}

// Probability p per talk batch, guarded: never before minGap batches since the
// last offer, always by maxGap — an item on every batch is a ticker, and a
// fresh pool ignored forever is a wasted fetch.
export class RwtRoll {
  private p: number
  private minGap: number
  private maxGap: number
  private random: () => number
  private since = 0

  constructor({ p = 0.35, minGap = 1, maxGap = 4, random = Math.random }: RwtRollOptions = {}) {
    this.p = p
    this.minGap = Math.max(0, minGap)
    this.maxGap = Math.max(this.minGap, maxGap)
    this.random = random
  }

  roll(): boolean {
    this.since++
    if (this.since < this.minGap) return false
    const hit = this.since >= this.maxGap || this.random() < this.p
    if (hit) this.since = 0
    return hit
  }
}

// --- the feed (§2.4 / §3.1) ----------------------------------------------- //

export type RealWorldTopicsDeps = {
  pool: RwtPool
  roll: RwtRoll
  brain: Pick<Brain, 'fetchTopics'>
  // Resolved at fetch time, so a language change lands on the next refresh.
  request: () => Omit<FetchTopicsRequest, 'avoid'>
  // Titles already told on air, from the ledger (spec 13 §3.7): the pool's
  // own memory is 48 h, a story can run for weeks.
  covered?: () => readonly string[]
  log?: (message: string) => void
}

// How many ledgered titles the fetch is told to avoid. The music avoid list
// settled at 32 after 8 brought a favourite back every other session; a
// topic is offered far less often than a song plays, so 32 here spans weeks
// of sessions — enough to outlast a running story — at one prompt line each,
// on a background task.
export const RWT_AVOID_DEPTH = 32

type Refresh = { promise: Promise<void>; done: () => boolean }

export class RealWorldTopics {
  private deps: RealWorldTopicsDeps
  private refresh: Refresh | null = null

  constructor(deps: RealWorldTopicsDeps) {
    this.deps = deps
  }

  // The talk path's one call: roll, then take. An empty pool does not consume
  // the roll, so the first item after a refresh is not owed to an old miss.
  offer(): RwtTopic | null {
    if (this.deps.pool.counts().fresh === 0) return null
    if (!this.deps.roll.roll()) return null
    const taken = this.deps.pool.take()
    if (taken === null) return null
    this.log(`rwt.offer ${taken.id}`)
    this.logPool()
    return taken
  }

  // Launch one background refresh if the pool is stale and none is in flight.
  // Returns whether it launched one.
  maybeRefresh(): boolean {
    if (!this.deps.pool.refreshDue()) return false
    if (this.refresh !== null && !this.refresh.done()) return false
    let settled = false
    this.refresh = { promise: this.run().finally(() => (settled = true)), done: () => settled }
    return true
  }

  // Await the in-flight refresh, if any (shutdown / tests).
  async drain(): Promise<void> {
    await this.refresh?.promise
    this.refresh = null
  }

  // Total: runs unawaited, so an escape here would be an unhandled rejection
  // taking the radio down instead of one quiet line in the log.
  private async run(): Promise<void> {
    const started = Date.now()
    try {
      const covered = new Set(this.deps.covered?.() ?? [])
      const fetched = await this.deps.brain.fetchTopics({
        ...this.deps.request(),
        avoid: [...new Set([...this.deps.pool.titles(), ...covered])],
      })
      // A title the fetch was told to avoid and returned anyway is dropped
      // here: the prompt is a request, the ledger is the record. Dropped
      // BEFORE the emptiness check — merging nothing would stamp the pool
      // fresh and leave it empty for a whole stale interval.
      const topics = fetched.filter((t) => !covered.has(t.title))
      if (topics.length === 0) {
        this.log(`rwt.refresh failed (${fetched.length === 0 ? 'no topics returned' : 'nothing new returned'})`)
        return
      }
      const n = this.deps.pool.merge(topics)
      this.log(`rwt.refresh n=${n} ms=${Date.now() - started}`)
      this.logPool()
    } catch (err) {
      this.log(`rwt.refresh failed (${String(err)})`)
    }
  }

  private logPool(): void {
    const { fresh, used } = this.deps.pool.counts()
    this.log(`rwt.pool fresh=${fresh} used=${used}`)
  }

  private log(message: string): void {
    this.deps.log?.(message)
  }
}

// --- the fetch task (§2.2) ------------------------------------------------ //

const FETCH_MAX_TURNS = 12

const topicShape = {
  topics: z
    .array(
      z.object({
        title: z.string().max(120).describe('one line, the thing itself'),
        gist: z.string().max(600).describe('two to three spoken sentences, in the requested language'),
        category: z.string().max(40).describe('its kind, from the list you were given'),
      }),
    )
    .min(1)
    .max(8),
}

// Trim, drop anything without a title or gist. Runs on schema-validated input.
export function cleanTopics(raw: z.infer<typeof topicShape.topics>): FetchedTopic[] {
  const out: FetchedTopic[] = []
  for (const t of raw) {
    const title = t.title.trim()
    const gist = t.gist.trim()
    if (!title || !gist) continue
    out.push({ title, gist, category: t.category.trim() })
  }
  return out
}

// One bounded run over WebSearch, ended by submit_topics (the spec 03-01
// termination rule). Neutral framing: the researcher, never the host.
export function fetchTopicsTask(req: FetchTopicsRequest, model: string): Task<FetchedTopic[]> {
  return {
    systemPrompt: RWT_FETCH_SYSTEM_PROMPT,
    prompt: buildFetchTopicsPrompt(req),
    model,
    maxTurns: FETCH_MAX_TURNS,
    builtins: ['WebSearch'],
    tools: (finish) => [
      tool(
        'submit_topics',
        'Hand over the real-world items you found. Call it once; calling it ends the task.',
        topicShape,
        async (args) => {
          const topics = cleanTopics(args.topics)
          if (topics.length > 0) finish(topics)
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, topics: topics.length }) }] }
        },
      ),
    ],
  }
}
