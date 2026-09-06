// The single resolver for murmur's user storage (spec 05 §2.3): one home,
// `~/.murmur` by default, relocatable with $MURMUR_HOME. Resolvers are pure —
// a writer mkdirs at its own write site.

import { homedir } from 'node:os'
import { join } from 'node:path'

// A quoted .env value like MURMUR_HOME=~/murmur arrives with the ~ literal;
// unexpanded it would silently become a relative "./~" directory. Exported for
// the other listener-typed path, $MURMUR_DEV_LOG (spec 05 §2.3): honoring a ~
// the user typed is not hardcoding a location.
export function expandUser(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export function homeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MURMUR_HOME?.trim()
  return override ? expandUser(override) : join(homedir(), '.murmur')
}

// The user's Claude Code data root — read-only, and read ONLY by the consented
// spec-06 slice-B bootstrap. Not murmur's own storage; it lives here because
// this is the single module allowed to resolve user-level paths (spec 05 §2.3).
export function claudeCodeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return override ? expandUser(override) : join(homedir(), '.claude')
}

// Irreplaceable user state (spec 05 memory/, incl. the persona). Back it up.
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'data')
}

// Rebuildable caches (the music bed). Safe to delete — costs a re-pull.
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'cache')
}

// Runtime state of a live process — nothing here outlives a run. The TUI's unix
// socket (spec 10 §2.3) is the only tenant; names stay short because the OS caps
// a socket path at ~104 bytes.
const RUN_DIR = 'run'

export function runRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), RUN_DIR)
}

// The same directory, resolved from the home a RUN already decided (config.home)
// rather than the ambient env — the crash sentinels (src/support/sentinel.ts) have to
// land in the home this instance is actually using.
export function sentinelRoot(home: string): string {
  return join(home, RUN_DIR)
}

// The diagnostics the dev log holds (src/support/dev-log.ts). Rebuildable in spirit —
// a sweep drops what has aged out — but kept beside the home rather than under
// cache/ so a listener reporting a bug can find it without knowing the layout.
export function logRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'log')
}

export function tuiSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(runRoot(env), 'tui.sock')
}

// The guide-written voice endpoint (spec 03-03 §7.2). It sits at the home root
// rather than under data/ because it is configuration the user can re-obtain,
// not irreplaceable state — and because it is the one file the setup
// conversation is allowed to write.
export function voiceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'voice.json')
}

// The listener's knobs (spec 12 §2.1): beside voice.json for the same reason —
// re-obtainable configuration, not irreplaceable state.
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'settings.json')
}

// The listener's music policy (spec 03-01 §2.3): the taste half of the pick
// instruction, as a file they own. Beside settings.json for the same reason —
// configuration, re-obtainable from the built-in default, not irreplaceable
// state.
export function musicPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'music-policy.md')
}

// The real-world topic pool (spec 13 §2.1): rebuildable, so it lives under
// cache/ — deleting it costs one fetch.
export function rwtPoolPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheRoot(env), 'rwt.json')
}
