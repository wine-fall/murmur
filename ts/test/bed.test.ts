import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CachedBedSource, cacheKey, pullBed, readManifest } from '../src/bed.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'murmur-bed-test-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

describe('readManifest', () => {
  it('yields one ref per line, skipping comments and blanks', async () => {
    const path = join(dir, 'manifest.txt')
    await writeFile(path, '# curated\n\nytsearch1:lofi one\n  ytsearch1:lofi two  \n')
    expect(await readManifest(path)).toEqual(['ytsearch1:lofi one', 'ytsearch1:lofi two'])
  })

  it('treats a missing manifest as empty', async () => {
    expect(await readManifest(join(dir, 'nope.txt'))).toEqual([])
  })
})

describe('cacheKey', () => {
  it('matches the Python cache convention so a warm cache is reused', () => {
    // sha256("x")[:16] — the same stem the Python bed pull wrote.
    expect(cacheKey('x')).toBe('2d711642b726b044')
  })
})

describe('CachedBedSource', () => {
  it('lists cached files in stable order, skipping partials and hidden files', async () => {
    await writeFile(join(dir, 'b.webm'), 'x')
    await writeFile(join(dir, 'a.m4a'), 'x')
    await writeFile(join(dir, 'c.part'), 'x')
    await writeFile(join(dir, '.hidden'), 'x')
    const tracks = new CachedBedSource(dir).tracks()
    expect(tracks.map((p) => p.split('/').pop())).toEqual(['a.m4a', 'b.webm'])
  })

  it('is empty for a missing cache dir', () => {
    expect(new CachedBedSource(join(dir, 'missing')).tracks()).toEqual([])
  })
})

describe('pullBed', () => {
  it('pulls uncached refs, skips warm ones, and continues past failures', async () => {
    const manifest = join(dir, 'manifest.txt')
    await writeFile(manifest, 'ref-a\nref-dead\nref-b\n')
    const cache = join(dir, 'cache')
    const pulled: string[] = []
    const download = async (ref: string, destBase: string) => {
      if (ref === 'ref-dead') throw new Error('403')
      pulled.push(ref)
      await writeFile(`${destBase}.webm`, 'audio')
    }
    const count = await pullBed({ manifest, cacheDir: cache, download })
    expect(pulled).toEqual(['ref-a', 'ref-b'])
    expect(count).toBe(2)

    // second run: warm cache, nothing re-pulled
    pulled.length = 0
    const again = await pullBed({ manifest, cacheDir: cache, download })
    expect(pulled).toEqual([]) // warm refs skipped; the dead ref retries and fails again
    expect(again).toBe(2)
  })

  it('an empty manifest pulls nothing and reports the existing cache', async () => {
    const count = await pullBed({
      manifest: join(dir, 'missing.txt'),
      cacheDir: dir,
      download: async () => {
        throw new Error('must not be called')
      },
    })
    expect(count).toBe(0)
  })
})
