// The mounted sources (spec 14 §2.1): $MURMUR_HOME/sources.json, secret-bearing
// like voice.json and written the same way (tmp + rename). One store instance
// per process is the single writer: the /sources flow, the auth watch and a
// token refresh all mutate through it, each as one synchronous
// read-merge-write, so nothing can interleave. Cookie sources store the
// browser NAME, never a cookie — yt-dlp reads the browser's store at call time.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import { SOURCE_IDS, type SourceId, type TasteSnapshot, TasteSnapshotSchema } from './taste.ts'

// yt-dlp's --cookies-from-browser vocabulary, minus whale.
export const BROWSERS = ['chrome', 'chromium', 'brave', 'edge', 'firefox', 'safari', 'vivaldi', 'opera'] as const
export type BrowserName = (typeof BROWSERS)[number]

export type SourceStatus = 'ok' | 'expired' | 'error'

const Cookie = { browser: z.enum(BROWSERS), profile: z.string().optional() }

// What the flow writes for each source; the store adds the bookkeeping.
export const SourceInputSchemas = {
  youtube: z.object(Cookie),
  bilibili: z.object({ ...Cookie, mid: z.string() }),
  netease: z.object({ ...Cookie, userId: z.string(), likedPlaylistId: z.string() }),
  spotify: z.object({ clientId: z.string(), refreshToken: z.string(), accessToken: z.string(), expiresAt: z.string() }),
  qishui: z.object({ sessionCookie: z.string(), deviceId: z.string(), installId: z.string() }),
} as const

const Bookkeeping = {
  mountedAt: z.string(),
  status: z.enum(['ok', 'expired', 'error']),
  lastRefresh: z.string().optional(),
  lastError: z.string().optional(),
}

const SourcesFileSchema = z.object({
  youtube: SourceInputSchemas.youtube.extend(Bookkeeping).optional(),
  bilibili: SourceInputSchemas.bilibili.extend(Bookkeeping).optional(),
  netease: SourceInputSchemas.netease.extend(Bookkeeping).optional(),
  spotify: SourceInputSchemas.spotify.extend(Bookkeeping).optional(),
  qishui: SourceInputSchemas.qishui.extend(Bookkeeping).optional(),
})

export type SourcesFile = z.infer<typeof SourcesFileSchema>
export type SourceInput = { [K in SourceId]: z.infer<(typeof SourceInputSchemas)[K]> }
export type SourceEntry = { [K in SourceId]: NonNullable<SourcesFile[K]> }
export type CookieSource = 'youtube' | 'bilibili' | 'netease'

type Log = (message: string) => void

// Unknown keys are dropped with one warning; a corrupt file is reported once
// and read as empty — the radio never crashes on it.
export function readSourcesFile(path: string, log: Log = () => {}): SourcesFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return {}
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    log(`sources: ${path} is not JSON; treating it as empty`)
    return {}
  }
  const parsed = SourcesFileSchema.safeParse(json)
  if (!parsed.success) {
    log(`sources: ${path} does not fit the sources shape; treating it as empty`)
    return {}
  }
  if (droppedKeys(json, parsed.data)) log(`sources: ${path} carries keys murmur does not know; ignoring them`)
  return parsed.data
}

// Two levels deep — the file is exactly that deep.
function droppedKeys(raw: unknown, kept: SourcesFile): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  for (const [key, value] of Object.entries(raw)) {
    if (!(SOURCE_IDS as readonly string[]).includes(key)) return true
    const entry = kept[key as SourceId]
    if (entry === undefined || typeof value !== 'object' || value === null) continue
    if (Object.keys(value).some((k) => !(k in entry))) return true
  }
  return false
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

export type SourcesStoreDeps = { path: string; tasteDir: string; log?: Log }

export class SourcesStore {
  private deps: SourcesStoreDeps
  // Raised by the /sources flow for its whole conversation: the refresher
  // checks it and stays out (spec 14 §3.4, single writer).
  busy = false

  constructor(deps: SourcesStoreDeps) {
    this.deps = deps
  }

  read(): SourcesFile {
    return readSourcesFile(this.deps.path, this.deps.log)
  }

  mounted(): SourceId[] {
    const file = this.read()
    return SOURCE_IDS.filter((id) => file[id] !== undefined)
  }

  mount<K extends SourceId>(id: K, entry: SourceInput[K], now: Date = new Date()): void {
    this.update((file) => ({ ...file, [id]: { ...entry, mountedAt: now.toISOString(), status: 'ok' } }))
  }

  unmount(id: SourceId): void {
    this.update((file) => {
      const { [id]: _gone, ...rest } = file
      return rest
    })
    rmSync(this.snapshotPath(id), { force: true })
  }

  // A status for something not mounted is dropped: the file never grows a
  // phantom entry out of a stray failure.
  setStatus(id: SourceId, status: SourceStatus, error?: string): void {
    this.patch(id, { status, lastError: error })
  }

  markRefreshed(id: SourceId, now: Date = new Date()): void {
    this.patch(id, { lastRefresh: now.toISOString() })
  }

  // Merge fields into a mounted entry; an undefined value deletes the field.
  patch<K extends SourceId>(id: K, fields: Partial<SourceEntry[K]>): void {
    this.update((file) => {
      const entry = file[id]
      if (entry === undefined) return file
      const next: Record<string, unknown> = { ...entry }
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      return { ...file, [id]: next }
    })
  }

  private update(fn: (file: SourcesFile) => SourcesFile): void {
    const next = SourcesFileSchema.parse(fn(this.read()))
    atomicWrite(this.deps.path, `${JSON.stringify(next, null, 2)}\n`)
  }

  snapshotPath(id: SourceId): string {
    return join(this.deps.tasteDir, `${id}.json`)
  }

  writeSnapshot(snapshot: TasteSnapshot): void {
    atomicWrite(this.snapshotPath(snapshot.source), JSON.stringify(snapshot))
  }

  readSnapshot(id: SourceId): TasteSnapshot | null {
    const path = this.snapshotPath(id)
    if (!existsSync(path)) return null
    try {
      const parsed = TasteSnapshotSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
}

// Which mounted source a playable ref belongs to (spec 14 §2.5).
const HOSTS: [RegExp, CookieSource][] = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(bilibili\.com|b23\.tv)$/, 'bilibili'],
  [/(^|\.)(music\.163\.com|163cn\.tv)$/, 'netease'],
]

export function sourceOfRef(ref: string): CookieSource | null {
  let host: string
  try {
    host = new URL(ref).hostname
  } catch {
    return null
  }
  return HOSTS.find(([re]) => re.test(host))?.[1] ?? null
}

// The yt-dlp flag for a ref whose host has a mounted cookie source; [] when
// no mount applies, so a listener with no account sees today's arguments
// byte for byte (spec 14 §5.1).
export function cookieArgs(ref: string, file: SourcesFile): string[] {
  const source = sourceOfRef(ref)
  if (source === null) return []
  return browserArgs(file[source])
}

export function browserArgs(entry: { browser: BrowserName; profile?: string | undefined } | undefined): string[] {
  if (entry === undefined) return []
  return ['--cookies-from-browser', entry.profile === undefined ? entry.browser : `${entry.browser}:${entry.profile}`]
}
