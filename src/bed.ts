// Background-bed acquisition + cache (spec 03-04 §2.2/§2.3): a curated manifest
// of yt-dlp refs committed to the repo, pulled to the per-user cache at loading
// time. At runtime the engine plays only the local cached files — no network on
// the audio path. Cache layout and key match the Python implementation, so an
// already-warm cache is reused as-is across the port.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import type { BedPosition, BedSource } from './contracts.ts'
import { cacheRoot } from './paths.ts'

// fileURLToPath, not URL.pathname: pathname keeps %-escapes (a checkout path
// with a space would silently read as an empty manifest).
export const DEFAULT_MANIFEST = fileURLToPath(new URL('../assets/bed_sources.txt', import.meta.url))

export function defaultBedCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), 'bed')
}

// Partial / hidden files are not playable tracks.
const SKIP_SUFFIXES = ['.part', '.ytdl', '.tmp']

// Refs one per line; `#` comments and blanks skipped. Missing manifest = empty.
export async function readManifest(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

// A stable filename stem per ref — sha256(ref)[:16], the Python convention, so
// a warm cache is recognised across runs and across the language port.
export function cacheKey(ref: string): string {
  return createHash('sha256').update(ref, 'utf8').digest('hex').slice(0, 16)
}

function cachedFiles(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return []
  return readdirSync(cacheDir)
    .filter((name) => !name.startsWith('.') && !SKIP_SUFFIXES.some((s) => name.endsWith(s)))
    .sort()
    .map((name) => join(cacheDir, name))
}

// Where the bed left off, beside the tracks it points into (spec 03-04 resume):
// wiping the cache wipes the position with it, which is the right semantic. The
// leading dot keeps it out of cachedFiles' track listing. `track` is a basename,
// so the position survives a relocated MURMUR_HOME.
const POSITION_FILE = '.position.json'

const BedPositionSchema = z.object({ track: z.string().min(1), offsetS: z.number().nonnegative() })

// A missing, damaged, or hand-mangled file is simply "no position" — the bed
// starts from the top, never a boot failure.
export function readBedPosition(cacheDir: string): BedPosition | null {
  let raw: string
  try {
    raw = readFileSync(join(cacheDir, POSITION_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const checked = BedPositionSchema.safeParse(JSON.parse(raw))
    return checked.success ? checked.data : null
  } catch {
    return null
  }
}

// Temp-file + rename (the settings discipline) so a reader never sees a torn file.
export function writeBedPosition(cacheDir: string, position: BedPosition): void {
  mkdirSync(cacheDir, { recursive: true })
  const path = join(cacheDir, POSITION_FILE)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(position)}\n`, 'utf8')
  renameSync(`${path}.tmp`, path)
}

// Map a saved basename back onto the cached track list. undefined = no resume
// (nothing saved, or the track has left the cache) — start from the top.
export function resumeFrom(tracks: string[], saved: BedPosition | null): BedPosition | undefined {
  if (saved === null) return undefined
  const track = tracks.find((t) => basename(t) === saved.track)
  return track === undefined ? undefined : { track, offsetS: saved.offsetS }
}

// The tail we never aim a seek into: landing inside the final crossfade plays a
// blink of audio and rolls over — start earlier (or from the top) instead.
const RESUME_TAIL_S = 10

// The boot-time start decision (spec 03-04 resume). A saved position whose
// offset fits inside the track's real duration wins. Everything else — first
// boot, a vanished track, a stale offset past the end — lands on a RANDOM track
// at a RANDOM in-bounds offset, so no two fresh boots open on the same bars.
// `durationOf` returning null (no ffprobe, unreadable file) degrades the pick
// to offset 0 and keeps a saved offset as-is: the engine's miss handling owns
// whatever the probe could not rule out.
export async function initialBedPosition(
  tracks: string[],
  saved: BedPosition | null,
  durationOf: (track: string) => Promise<number | null>,
  random: () => number = Math.random,
): Promise<BedPosition | undefined> {
  const resumed = resumeFrom(tracks, saved)
  if (resumed !== undefined) {
    const duration = await durationOf(resumed.track)
    if (duration === null || resumed.offsetS < Math.max(0, duration - RESUME_TAIL_S)) return resumed
    // stale offset: fall through to a fresh random start
  }
  if (tracks.length === 0) return undefined
  const track = tracks[Math.floor(random() * tracks.length) % tracks.length]!
  const duration = await durationOf(track)
  if (duration === null || duration <= RESUME_TAIL_S) return { track, offsetS: 0 }
  return { track, offsetS: random() * (duration - RESUME_TAIL_S) }
}

// The runtime BedSource (spec 03-04 §2.2): local cached files, stable order.
export class CachedBedSource implements BedSource {
  private cacheDir: string

  constructor(cacheDir: string = defaultBedCacheDir()) {
    this.cacheDir = cacheDir
  }

  tracks(): string[] {
    return cachedFiles(this.cacheDir)
  }
}

export type BedDownload = (ref: string, destBase: string) => Promise<void>

export type PullBedOptions = {
  manifest: string
  cacheDir: string
  download: BedDownload
  log?: (message: string) => void
}

// First-run pull (spec 03-04 §2.3): resolve each manifest ref into the cache,
// skipping warm refs and continuing past failures — a dead ref never aborts the
// pull. Returns the cached-track count; 0 degrades cleanly to no bed.
export async function pullBed({ manifest, cacheDir, download, log }: PullBedOptions): Promise<number> {
  const refs = await readManifest(manifest)
  if (refs.length === 0) return cachedFiles(cacheDir).length
  await mkdir(cacheDir, { recursive: true })
  let failures = 0
  for (const ref of refs) {
    const key = cacheKey(ref)
    if (cachedFiles(cacheDir).some((path) => path.includes(`/${key}.`))) continue
    log?.(`bed: pulling ${ref}`)
    try {
      await download(ref, join(cacheDir, key))
    } catch {
      failures += 1 // detail is noise to the user; the pull degrades cleanly
    }
  }
  const cached = cachedFiles(cacheDir).length
  if (failures > 0) log?.(`bed: ${failures} source(s) unavailable, skipped (${cached}/${refs.length} ready)`)
  return cached
}

// Pull one ref's best audio to `<destBase>.<ext>` via yt-dlp (the 03-01
// acquisition binary, reused). Loading-time only — never on the audio path.
export function ytdlpDownload(ref: string, destBase: string, ytdlpCmd = 'yt-dlp'): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      ytdlpCmd,
      ['-f', 'bestaudio/best', '-o', `${destBase}.%(ext)s`, ref],
      { timeout: 300_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`yt-dlp failed: ${String(stderr).trim() || err.message}`))
        else resolve()
      },
    )
  })
}
