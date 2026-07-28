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

async function nextLine(host: Host): Promise<string> {
  await host.peekLine()
  return host.takeLine() ?? ''
}

// Ask the user via the CLI Host before each tool the guide wants to run, and
// return the SDK's allow/deny result. Anything but an explicit yes denies.
export function cliPermission(host: Host): CanUseTool {
  return async (toolName, input) => {
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input)
    host.info(`setup assistant wants to run [${toolName}]: ${detail}`)
    host.info('allow? [y/N]')
    if (YES.has((await nextLine(host)).trim().toLowerCase())) return { behavior: 'allow' }
    return { behavior: 'deny', message: 'user declined' }
  }
}

// Read the user's next natural-language reply from the CLI Host. An empty
// line or /done|/quit|q ends the conversation (returns null).
export function cliConversation(host: Host): () => Promise<string | null> {
  return async () => {
    host.info('your reply (natural language; empty or /done to finish):')
    const line = (await nextLine(host)).trim()
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
  host.info(`music dependencies aren't working here: ${result.reason}`)
  host.info("type 'y' to let the setup assistant look into it (anything else skips):")
  if (!YES.has((await nextLine(host)).trim().toLowerCase())) {
    host.info('skipped music setup.')
    return false
  }

  await guide.runGuide({
    systemPrompt: GUIDE_PERSONA,
    prompt: buildFixMusicPrompt({ ytdlp, ffmpeg, reason: result.reason }),
    model: GUIDE_MODEL,
    maxTurns: GUIDE_MAX_TURNS,
    canUseTool: cliPermission(host),
    onText: (text) => host.info(text),
    nextUserInput: cliConversation(host),
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
