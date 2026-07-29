// Startup checks (spec 03-02 §2.4): an extensible preflight phase the app runs
// before broadcasting. A failed check degrades the session (talk-only), never
// aborts the radio. This module holds the framework plus the deterministic
// music preflight probes (spec 03-03 §2); the interactive repair check that
// consumes them lives in guide.ts (musicSetupCheck).

import { execFile } from 'node:child_process'

import type { Host } from './host.ts'

export type StartupCheck = {
  name: string
  // Interactive allowed (the host is the same stdin the Director uses).
  // False = the feature this check gates is unavailable this session.
  run(host: Host): Promise<boolean>
}

export async function runStartupChecks(
  checks: StartupCheck[],
  host: Host,
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {}
  for (const check of checks) {
    results[check.name] = await check.run(host).catch(() => false)
  }
  return results
}

// --- the deterministic music preflight (spec 03-03 §2) -------------------- //
//
// Cheap local probes, no LLM (master §7 pillar 1): one per unbound binary,
// aggregated by preflightMusic. `reason` — naming each broken binary — is what
// seeds the guide agent's diagnosis (missing entirely, a proxy CA, ...).

export type PreflightResult = { ok: boolean; reason: string }

const REASON_MAX = 500

// requireStdout: exit 0 alone is not proof of life for a fetch probe — the
// trivial search must actually produce output (spec 03-03 §2).
function probeBinary(
  name: string,
  binary: string,
  args: string[],
  requireStdout: boolean,
): Promise<PreflightResult> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err === null) {
        if (requireStdout && stdout.trim() === '') {
          return resolve({ ok: false, reason: `${name} exited 0 with no output` })
        }
        return resolve({ ok: true, reason: '' })
      }
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return resolve({ ok: false, reason: `${name} binary not found: '${binary}'` })
      }
      if (code === 'EACCES') {
        return resolve({ ok: false, reason: `${name} not executable: '${binary}'` })
      }
      const reason = stderr.trim() || `${name} exited ${String(code)}`
      resolve({ ok: false, reason: reason.slice(0, REASON_MAX) })
    })
  })
}

// Probe whether yt-dlp can actually fetch (a trivial flat search — network).
export function preflightYtdlp(binary = 'yt-dlp'): Promise<PreflightResult> {
  return probeBinary('yt-dlp', binary, ['--dump-json', '--flat-playlist', 'ytsearch1:test'], true)
}

// Probe whether ffmpeg is a working build (-version; local, no network).
export function preflightFfmpeg(binary = 'ffmpeg'): Promise<PreflightResult> {
  return probeBinary('ffmpeg', binary, ['-version'], false)
}

// Probe the runtime the TUI client needs (spec 10 §2.2). Local, no network;
// requiring stdout keeps a stub `bun` on PATH from passing for nothing.
export function preflightBun(binary = 'bun'): Promise<PreflightResult> {
  return probeBinary('bun', binary, ['--version'], true)
}

// Aggregate: music is usable iff BOTH binaries are. The combined reason
// prefixes each broken binary's name so the guide (and the user) see exactly
// which pieces need fixing.
export async function preflightMusic(opts: {
  ytdlp?: string
  ffmpeg?: string
}): Promise<PreflightResult> {
  const [yt, ff] = await Promise.all([
    preflightYtdlp(opts.ytdlp ?? 'yt-dlp'),
    preflightFfmpeg(opts.ffmpeg ?? 'ffmpeg'),
  ])
  const reasons: string[] = []
  if (!yt.ok) reasons.push(`yt-dlp: ${yt.reason}`)
  if (!ff.ok) reasons.push(`ffmpeg: ${ff.reason}`)
  if (reasons.length === 0) return { ok: true, reason: '' }
  return { ok: false, reason: reasons.join(' | ') }
}

