import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { existsSync } from 'node:fs'

import {
  CachedBedSource,
  DEFAULT_MANIFEST,
  cacheKey,
  initialBedPosition,
  pullBed,
  readBedPosition,
  readManifest,
  resumeFrom,
  writeBedPosition,
} from '../src/bed.ts'

// The manifest constant is anchored relative to the module file; a tree move
// that breaks the anchor must fail here, not at the first real run.
it('DEFAULT_MANIFEST points at the committed manifest', () => {
  expect(existsSync(DEFAULT_MANIFEST)).toBe(true)
})

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

describe('bed position (spec 03-04 resume)', () => {
  it('round-trips the last track and offset', () => {
    writeBedPosition(dir, { track: 'a.m4a', offsetS: 42.5 })
    expect(readBedPosition(dir)).toEqual({ track: 'a.m4a', offsetS: 42.5 })
  })

  it('is null when never written', () => {
    expect(readBedPosition(dir)).toBeNull()
  })

  it('a damaged or invalid file reads as null, never a throw', async () => {
    await writeFile(join(dir, '.position.json'), 'not json')
    expect(readBedPosition(dir)).toBeNull()
    await writeFile(join(dir, '.position.json'), JSON.stringify({ track: 7, offsetS: -1 }))
    expect(readBedPosition(dir)).toBeNull()
  })

  it('never lists as a bed track', () => {
    writeBedPosition(dir, { track: 'a.m4a', offsetS: 1 })
    expect(new CachedBedSource(dir).tracks()).toEqual([])
  })

  it('resumeFrom maps the saved basename onto the cached track list', () => {
    const tracks = ['/cache/bed/a.m4a', '/cache/bed/b.webm']
    expect(resumeFrom(tracks, { track: 'b.webm', offsetS: 30 })).toEqual({
      track: '/cache/bed/b.webm',
      offsetS: 30,
    })
    expect(resumeFrom(tracks, { track: 'gone.m4a', offsetS: 30 })).toBeUndefined()
    expect(resumeFrom(tracks, null)).toBeUndefined()
  })
})

// The boot-time start decision: a valid saved position wins; anything else —
// first boot, stale offset past the track's real end, vanished track — lands
// on a RANDOM track at a RANDOM in-bounds offset, so no two listeners (and no
// two fresh boots) open on the same bars.
describe('initialBedPosition (spec 03-04 resume)', () => {
  const tracks = ['/cache/bed/a.m4a', '/cache/bed/b.webm']
  const durations: Record<string, number | null> = { '/cache/bed/a.m4a': 100, '/cache/bed/b.webm': 200 }
  const durationOf = async (t: string) => durations[t] ?? null

  it('keeps a saved position that fits inside the track', async () => {
    const pos = await initialBedPosition(tracks, { track: 'b.webm', offsetS: 150 }, durationOf)
    expect(pos).toEqual({ track: '/cache/bed/b.webm', offsetS: 150 })
  })

  it('a saved offset past the end falls through to a random start, never a dead seek', async () => {
    const pos = await initialBedPosition(tracks, { track: 'a.m4a', offsetS: 99 }, durationOf, () => 0.5)
    expect(pos?.offsetS).toBeLessThan(99)
  })

  it('no saved position picks a random track and a random bounded offset', async () => {
    const pos = await initialBedPosition(tracks, null, durationOf, () => 0.5)
    expect(pos?.track).toBe('/cache/bed/b.webm') // 0.5 of 2 tracks -> index 1
    expect(pos?.offsetS).toBeGreaterThan(0)
    expect(pos?.offsetS).toBeLessThan(200)
  })

  it('the random offset never lands in the final crossfade tail', async () => {
    const pos = await initialBedPosition(tracks, null, durationOf, () => 0.999999)
    expect(pos?.offsetS).toBeLessThan(200 - 5)
  })

  it('an unknown duration starts the picked track from the top', async () => {
    const pos = await initialBedPosition(['/cache/bed/x.m4a'], null, async () => null)
    expect(pos).toEqual({ track: '/cache/bed/x.m4a', offsetS: 0 })
  })

  it('no tracks means no position', async () => {
    expect(await initialBedPosition([], null, durationOf)).toBeUndefined()
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
