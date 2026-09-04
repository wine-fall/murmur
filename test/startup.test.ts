import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  preflightBun,
  preflightFfmpeg,
  preflightMusic,
  preflightYtdlp,
  preflightYtdlpFreshness,
} from '../src/setup/startup.ts'

// Stand-in binaries (spec 03-03 §5 testing): tiny executable scripts standing
// in for yt-dlp/ffmpeg, so the probes are exercised for real — spawn, exit
// code, stdout/stderr — with no network and no LLM.
function standIn(body: string, { executable = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-preflight-'))
  const path = join(dir, 'bin.sh')
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: executable ? 0o755 : 0o644 })
  return path
}

describe('preflight probes (spec 03-03 §2 — deterministic, no LLM)', () => {
  it('yt-dlp: ok needs exit 0 AND output (a fetch probe with nothing fetched is broken)', async () => {
    expect((await preflightYtdlp(standIn('echo "{}"'))).ok).toBe(true)
    const silent = await preflightYtdlp(standIn('exit 0'))
    expect(silent.ok).toBe(false)
    expect(silent.reason).toContain('no output')
  })

  it('ffmpeg: -version needs only exit 0', async () => {
    expect((await preflightFfmpeg(standIn('exit 0'))).ok).toBe(true)
    const broken = await preflightFfmpeg(standIn('echo "bad build" >&2; exit 1'))
    expect(broken.ok).toBe(false)
    expect(broken.reason).toContain('bad build')
  })

  it('a missing binary is named, not thrown', async () => {
    const r = await preflightYtdlp('/nonexistent/yt-dlp')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('not found')
    expect(r.reason).toContain('/nonexistent/yt-dlp')
  })

  it('a non-executable binary is classified, not thrown', async () => {
    const r = await preflightFfmpeg(standIn('exit 0', { executable: false }))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('not executable')
  })

  it('a long stderr is capped', async () => {
    const r = await preflightFfmpeg(standIn('head -c 2000 /dev/zero | tr "\\0" "x" >&2; exit 1'))
    expect(r.ok).toBe(false)
    expect(r.reason.length).toBeLessThanOrEqual(500)
  })

  it('aggregate: ok iff BOTH ok, and the reason names each broken piece', async () => {
    const ok = standIn('echo out')
    const bad = standIn('echo "boom" >&2; exit 1')
    expect((await preflightMusic({ ytdlp: ok, ffmpeg: ok })).ok).toBe(true)
    const oneBad = await preflightMusic({ ytdlp: bad, ffmpeg: ok })
    expect(oneBad.ok).toBe(false)
    expect(oneBad.reason).toContain('yt-dlp: boom')
    expect(oneBad.reason).not.toContain('ffmpeg:')
    const bothBad = await preflightMusic({ ytdlp: bad, ffmpeg: bad })
    expect(bothBad.reason).toContain('yt-dlp: boom')
    expect(bothBad.reason).toContain('ffmpeg: boom')
  })
})

describe('the yt-dlp probe is a real fetch, not a --version vanity check', () => {
  it('passes a trivial flat search (an installed-but-broken yt-dlp must fail here)', async () => {
    // The stand-in records its argv so the probe's actual command is pinned
    // (spec 03-03 §2: a rotted extractor or proxy failure still answers
    // --version; only a fetch proves life).
    const dir = mkdtempSync(join(tmpdir(), 'murmur-preflight-'))
    const argsFile = join(dir, 'args.txt')
    const bin = join(dir, 'bin.sh')
    writeFileSync(bin, `#!/bin/sh\necho "$@" > ${argsFile}\necho ok\n`, { mode: 0o755 })
    expect((await preflightYtdlp(bin)).ok).toBe(true)
    const args = readFileSync(argsFile, 'utf8')
    expect(args).toContain('ytsearch1:')
    expect(args).toContain('--dump-json')
  })
})

// spec 10 §2.2: Bun is provisioned like yt-dlp/ffmpeg — probed here, and the
// TUI front-end is simply not offered when the probe fails.
describe('preflightBun', () => {
  it('passes on a binary that reports a version', async () => {
    expect(await preflightBun(standIn('echo 1.3.14'))).toEqual({ ok: true, reason: '' })
  })

  it('fails, naming the binary, when it is missing', async () => {
    const result = await preflightBun('/nope/bun')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('/nope/bun')
  })

  it('fails on a binary that exits 0 saying nothing', async () => {
    expect((await preflightBun(standIn('exit 0'))).ok).toBe(false)
  })
})

// The yt-dlp freshness probe (spec 03-03 §2): releases are dated, extractors
// rot as sites change (Bilibili breaks first), so an old release date is the
// staleness signal. Local and deterministic — the live Bilibili endpoints
// answer probabilistically, so a functional probe would flicker.
describe('preflightYtdlpFreshness', () => {
  const now = new Date('2026-08-12')

  it('a release inside the rot window is fresh', async () => {
    expect((await preflightYtdlpFreshness(standIn('echo 2026.07.04'), now)).ok).toBe(true)
  })

  it('an old release fails, naming the version, its age, and the remedy', async () => {
    const r = await preflightYtdlpFreshness(standIn('echo 2026.03.01'), now)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('2026.03.01')
    // The exact count can shift by one across timezones; the shape is what
    // matters — an age in days, and the remedy.
    expect(r.reason).toMatch(/16\d days old/)
    expect(r.reason.toLowerCase()).toContain('upgrade')
  })

  it('a nightly build (extra version segment) is judged by its date prefix', async () => {
    const r = await preflightYtdlpFreshness(standIn('echo 2026.03.01.123456'), now)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('2026.03.01')
  })

  it('freshness is advisory: unreadable versions and missing binaries are never stale', async () => {
    // Liveness is the OTHER probe's business; this one only ever says "old".
    expect((await preflightYtdlpFreshness(standIn('echo weird-build'), now)).ok).toBe(true)
    expect((await preflightYtdlpFreshness(standIn('exit 1'), now)).ok).toBe(true)
    expect((await preflightYtdlpFreshness('/nonexistent/yt-dlp', now)).ok).toBe(true)
  })
})
