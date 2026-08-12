// The startup-check probes (spec 03-02 §2.4): the deterministic, local half of
// the preflight phase the app runs before broadcasting. A failed probe degrades
// the session (talk-only, plain front-end, silent voice), never aborts the
// radio. The interactive half — naming the gaps and conversing the user through
// fixing them — lives in guide.ts (runSetup, spec 03-03 §7), which aggregates
// every probe here into ONE offer per boot.

import { execFile } from 'node:child_process'

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

// How old a yt-dlp release may get before the preflight recommends an upgrade.
// Releases are dated (YYYY.MM.DD) and extractors rot as sites move their APIs
// and anti-bot checks — Bilibili historically breaks first. Two months is
// comfortably past the project's own release cadence.
const YTDLP_ROT_DAYS = 60

// Probe whether the installed yt-dlp is recent enough to keep up with the
// sites it extracts from. Local and deterministic (--version, no network): the
// live Bilibili endpoints answer probabilistically (anti-bot 412s flicker per
// request, smoke-measured), so a functional probe would misreport in both
// directions — the release date is the stable signal.
export function preflightYtdlpFreshness(
  binary = 'yt-dlp',
  now = new Date(),
): Promise<PreflightResult> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 30_000 }, (err, stdout) => {
      // Freshness is advisory: a binary this probe cannot read (missing, odd
      // build string) is the liveness probe's business, never called stale.
      const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(stdout.trim())
      if (err !== null || match === null) return resolve({ ok: true, reason: '' })
      const released = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      const ageDays = Math.floor((now.getTime() - released.getTime()) / 86_400_000)
      if (ageDays <= YTDLP_ROT_DAYS) return resolve({ ok: true, reason: '' })
      resolve({
        ok: false,
        reason: `yt-dlp ${match[0]} is ${String(ageDays)} days old — extractors rot as sites change (Bilibili breaks first); an upgrade is recommended`,
      })
    })
  })
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

