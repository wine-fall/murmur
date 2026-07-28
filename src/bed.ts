// Background-bed acquisition + cache (spec 03-04 §2.2/§2.3): a curated manifest
// of yt-dlp refs committed to the repo, pulled to the per-user cache at loading
// time. At runtime the engine plays only the local cached files — no network on
// the audio path. Cache layout and key match the Python implementation, so an
// already-warm cache is reused as-is across the port.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BedSource } from './contracts.ts'
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
