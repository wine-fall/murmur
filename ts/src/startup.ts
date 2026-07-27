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

export type BinaryProbe = (cmd: string, args: string[]) => Promise<boolean>

const execProbe: BinaryProbe = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(err === null))
  })

export type MusicCheckOptions = {
  ytdlpCmd: string
  ffmpegCmd: string
  probe?: BinaryProbe
}

// The music-dependency preflight (spec 03-02 §2.4, wrapping 03-03's
// deterministic half): both acquisition binaries must answer.
export function musicCheck({ ytdlpCmd, ffmpegCmd, probe = execProbe }: MusicCheckOptions): StartupCheck {
  return {
    name: 'music',
    async run(host) {
      const missing: string[] = []
      if (!(await probe(ytdlpCmd, ['--version']))) missing.push(ytdlpCmd)
      if (!(await probe(ffmpegCmd, ['-version']))) missing.push(ffmpegCmd)
      if (missing.length === 0) return true
      host.info(
        `music is unavailable: ${missing.join(' and ')} not working. ` +
          'The radio runs talk-only; install the missing tool(s) to enable music.',
      )
      return false
    },
  }
}
