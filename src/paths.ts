// The single resolver for murmur's user storage (spec 05 §2.3): one home,
// `~/.murmur` by default, relocatable with $MURMUR_HOME. Resolvers are pure —
// a writer mkdirs at its own write site.

import { homedir } from 'node:os'
import { join } from 'node:path'

// A quoted .env value like MURMUR_HOME=~/murmur arrives with the ~ literal;
// unexpanded it would silently become a relative "./~" directory.
function expand(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export function homeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MURMUR_HOME?.trim()
  return override ? expand(override) : join(homedir(), '.murmur')
}

// The user's Claude Code data root — read-only, and read ONLY by the consented
// spec-06 slice-B bootstrap. Not murmur's own storage; it lives here because
// this is the single module allowed to resolve user-level paths (spec 05 §2.3).
export function claudeCodeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return override ? expand(override) : join(homedir(), '.claude')
}

// Irreplaceable user state (spec 05 memory/, incl. the persona). Back it up.
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'data')
}

// Rebuildable caches (the music bed). Safe to delete — costs a re-pull.
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'cache')
}
