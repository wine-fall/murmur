// Startup checks (spec 03-02 §2.4): an extensible preflight phase the app runs
// before broadcasting. The only check shipped here is the music-dependency
// preflight; a failed check degrades the session (talk-only), never aborts the
// radio. The interactive repair guide (03-03's run_guide) is the Phase 4.5
// harness — until then a failure tells the user plainly what is missing.

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

// requireStdout: exit 0 alone is not proof of life for a fetch probe — the
// trivial search must actually produce output (spec 03-03 §2).
export type BinaryProbe = (cmd: string, args: string[], requireStdout: boolean) => Promise<boolean>

const execProbe: BinaryProbe = (cmd, args, requireStdout) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout) =>
      resolve(err === null && (!requireStdout || stdout.trim() !== '')),
    )
  })

export type MusicCheckOptions = {
  ytdlpCmd: string
  ffmpegCmd: string
  probe?: BinaryProbe
}

// The music-dependency preflight (spec 03-02 §2.4, wrapping 03-03's
// deterministic half): both acquisition binaries must actually work. yt-dlp is
// probed with a trivial flat search (network — an installed-but-broken binary,
// e.g. a rotted extractor or a proxy failure, must degrade to talk-only here,
// not at the first pick); ffmpeg with -version (local).
export function musicCheck({ ytdlpCmd, ffmpegCmd, probe = execProbe }: MusicCheckOptions): StartupCheck {
  return {
    name: 'music',
    async run(host) {
      const missing: string[] = []
      if (!(await probe(ytdlpCmd, ['--dump-json', '--flat-playlist', 'ytsearch1:test'], true))) {
        missing.push(ytdlpCmd)
      }
      if (!(await probe(ffmpegCmd, ['-version'], false))) missing.push(ffmpegCmd)
      if (missing.length === 0) return true
      host.info(
        `music is unavailable: ${missing.join(' and ')} not working. ` +
          'The radio runs talk-only; install the missing tool(s) to enable music.',
      )
      return false
    },
  }
}
