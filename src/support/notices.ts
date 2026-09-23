// The startup notify bubble (spec 10 §3.7.5): a notice feed kept in the repo
// (assets/notices.json on main), read live at launch the way the channel
// manifest is (src/music/channels.ts), and at most ONE notice handed to the
// front-end for the pet to say.
//
// runNotices decides and narrates only; the network, the clock and the file
// are on NoticeDeps, so no test reaches either. It NEVER rejects: it runs
// beside the program on nobody's await.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import { cacheRoot } from '../paths.ts'
import { isNewer } from './update.ts'

export const NOTICES_URL = 'https://raw.githubusercontent.com/wine-fall/murmur/main/assets/notices.json'

const FETCH_TIMEOUT_MS = 5_000
const DAY_MS = 24 * 60 * 60_000
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/

// One notice. Unknown fields are stripped, not refused, so a newer feed never
// silences an older client.
const NoticeSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(120),
  until: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  command: z.string().regex(/^\/\S+$/).optional(),
  url: z.string().url().optional(),
  below: z.string().optional(),
  since: z.string().optional(),
})

export type Notice = z.infer<typeof NoticeSchema>

// The envelope only: entries stay raw here so the cache round-trips them and
// each is parsed on its own (one bad entry costs that entry).
const FeedSchema = z.object({ v: z.literal(1), notices: z.array(z.unknown()) })
type Feed = z.infer<typeof FeedSchema>

const StateSchema = z.object({
  fetchedAt: z.number(),
  feed: FeedSchema.nullable(),
  dismissed: z.array(z.string()),
})
type State = z.infer<typeof StateSchema>

// What the front-end shows: `hint` is the action (a command wins over a url);
// the way to dismiss is the client's own business.
export type Bubble = { id: string; text: string; hint?: string }

export function noticesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), 'notices.json')
}

export function parseNotices(entries: readonly unknown[]): Notice[] {
  return entries.flatMap((entry) => {
    const parsed = NoticeSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

// A bare date is inclusive: `until: 2026-10-01` still shows all of that UTC day.
function expired(until: string, now: number): boolean {
  return now >= Date.parse(until) + (BARE_DATE.test(until) ? DAY_MS : 0)
}

export function pickNotice(
  notices: readonly Notice[],
  at: { now: number; current: string; dismissed: readonly string[] },
): Notice | null {
  return (
    notices.find(
      (n) =>
        !expired(n.until, at.now) &&
        (n.below === undefined || isNewer(n.below, at.current)) &&
        (n.since === undefined || !isNewer(n.since, at.current)) &&
        !at.dismissed.includes(n.id),
    ) ?? null
  )
}

function readState(path: string): State {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    /* no cache yet, or a mangled one: start over */
  }
  return { fetchedAt: 0, feed: null, dismissed: [] }
}

// Temp-file + rename so a reader never sees a torn file. Losing this file
// costs one repeat of a dismissed notice, never the program.
function writeState(path: string, state: State): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(state), 'utf8')
    renameSync(`${path}.tmp`, path)
  } catch {
    /* a cache is rebuildable by definition */
  }
}

export type NoticeDeps = {
  current: string
  show: (bubble: Bubble) => void
  path?: string
  url?: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}

async function fetchFeed(deps: NoticeDeps): Promise<Feed | null> {
  const get = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  try {
    const response = await get(deps.url ?? NOTICES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return null
    const parsed = FeedSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function runNotices(deps: NoticeDeps): Promise<void> {
  try {
    const path = deps.path ?? noticesPath()
    const now = (deps.now ?? Date.now)()
    const state = readState(path)
    const fresh = await fetchFeed(deps)
    if (fresh !== null) {
      // Only a fresh feed may forget a dismissal: an id the maintainer removed
      // is gone for good, while an offline launch keeps every one it knew.
      const listed = new Set(fresh.notices.flatMap((entry) => {
        const id = z.object({ id: z.string() }).safeParse(entry)
        return id.success ? [id.data.id] : []
      }))
      state.dismissed = state.dismissed.filter((id) => listed.has(id))
      state.feed = fresh
      state.fetchedAt = now
      writeState(path, state)
    }
    if (state.feed === null) return
    const pick = pickNotice(parseNotices(state.feed.notices), {
      now,
      current: deps.current,
      dismissed: state.dismissed,
    })
    if (pick === null) return
    const hint = pick.command !== undefined ? `type ${pick.command}` : pick.url
    deps.show({ id: pick.id, text: pick.text, ...(hint !== undefined && { hint }) })
  } catch {
    /* a notice is a nicety: nothing here may reach the program */
  }
}

// The listener pressed Esc on the bubble: that id stays quiet until the feed
// drops it.
export function dismissNotice(id: string, path: string = noticesPath()): void {
  const state = readState(path)
  if (state.dismissed.includes(id)) return
  state.dismissed.push(id)
  writeState(path, state)
}
