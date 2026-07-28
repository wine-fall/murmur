// Wire the guide harness into murmur's CLI Host (spec 03-03).
//
// The deterministic preflight decides whether to engage; when it does, the
// guide runs with its ask/answer routed through the CLI Host — the agent's
// text prints as it streams (onText), each pre-action permission request is
// printed and answered from the same stdin the Director uses (canUseTool),
// and the user's natural-language replies flow back (nextUserInput). We only
// route the SDK's prompts; the SDK owns the ask/execute semantics.

import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

import type { GuideCapable } from './contracts.ts'
import type { Host } from './host.ts'
import { buildFixMusicPrompt, GUIDE_PERSONA } from './prompts.ts'
import { preflightMusic, type PreflightResult, type StartupCheck } from './startup.ts'

// Repair is judgment-heavy and occasional; the token cost amortizes (spec
// 03-03 §3). Not a config knob until someone needs one.
const GUIDE_MODEL = 'claude-opus-4-8'
const GUIDE_MAX_TURNS = 30

const YES = new Set(['y', 'yes'])
const END = new Set(['', '/done', '/quit', 'q'])

// A serialized, consuming line read for the guide's asks. Two things the
// Director's raw peek/take race primitive gets wrong here (codex-review
// regressions): one typed line wakes EVERY concurrent waiter (concurrent
// permission asks would share an answer and drop the rest), and a closed
// stdin pends forever (a non-interactive run would wedge startup). So reads
// queue one behind the other, and EOF resolves '' — which every consumer
// already treats as decline/skip/end.
export type ReadLine = () => Promise<string>

export function lineReader(host: Host): ReadLine {
  const eof: Promise<string> = host.eof?.().then(() => '') ?? new Promise<string>(() => {})
  let chain: Promise<unknown> = Promise.resolve()
  return () => {
    const read = chain.then(() =>
      Promise.race([host.peekLine().then(() => host.takeLine() ?? ''), eof]),
    )
    chain = read
    return read
  }
}

// Ask the user via the CLI Host before each tool the guide wants to run, and
// return the SDK's allow/deny result. Anything but an explicit yes denies.
export function cliPermission(host: Host, read: ReadLine): CanUseTool {
  return async (toolName, input) => {
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input)
    host.info(`setup assistant wants to run [${toolName}]: ${detail}`)
    host.info('allow? [y/N]')
    if (YES.has((await read()).trim().toLowerCase())) return { behavior: 'allow' }
    return { behavior: 'deny', message: 'user declined' }
  }
}

// Read the user's next natural-language reply from the CLI Host. An empty
// line or /done|/quit|q ends the conversation (returns null).
export function cliConversation(host: Host, read: ReadLine): () => Promise<string | null> {
  return async () => {
    host.info('your reply (natural language; empty or /done to finish):')
    const line = (await read()).trim()
    return END.has(line.toLowerCase()) ? null : line
  }
}

export type MusicSetupOptions = {
  ytdlp?: string
  ffmpeg?: string
  // Injectable for tests; the real one probes the actual binaries.
  preflight?: (binaries: { ytdlp: string; ffmpeg: string }) => Promise<PreflightResult>
}

// Preflight the music dependencies; if broken, offer the guide (routed through
// the CLI Host), then recheck. Returns whether music is usable afterward.
export async function runMusicSetup(
  host: Host,
  guide: GuideCapable,
  options: MusicSetupOptions = {},
): Promise<boolean> {
  const ytdlp = options.ytdlp ?? 'yt-dlp'
  const ffmpeg = options.ffmpeg ?? 'ffmpeg'
  const check = options.preflight ?? preflightMusic
  const result = await check({ ytdlp, ffmpeg })
  if (result.ok) return true

  // The offer and the guide both read the keyboard; make sure the reader is
  // up (idempotent — the Director starts it too, spec 03-02 §2.4).
  host.start()
  const read = lineReader(host)
  host.info(`music dependencies aren't working here: ${result.reason}`)
  host.info("type 'y' to let the setup assistant look into it (anything else skips):")
  if (!YES.has((await read()).trim().toLowerCase())) {
    host.info('skipped music setup.')
    return false
  }

  await guide.runGuide({
    systemPrompt: GUIDE_PERSONA,
    prompt: buildFixMusicPrompt({ ytdlp, ffmpeg, reason: result.reason }),
    model: GUIDE_MODEL,
    maxTurns: GUIDE_MAX_TURNS,
    canUseTool: cliPermission(host, read),
    onText: (text) => host.info(text),
    nextUserInput: cliConversation(host, read),
  })

  const recheck = await check({ ytdlp, ffmpeg })
  host.info(recheck.ok ? 'music is working now.' : "music still isn't working.")
  return recheck.ok
}

// The music startup check (spec 03-02 §2.4): where 03-03's auto-trigger lands.
// A failed/declined repair degrades the session to talk-only, never aborts.
export function musicSetupCheck(guide: GuideCapable, options: MusicSetupOptions = {}): StartupCheck {
  return {
    name: 'music',
    run: (host) => runMusicSetup(host, guide, options),
  }
}
