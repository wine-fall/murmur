// The single resolver for murmur's user storage (spec 05 §2.3): one home,
// `~/.murmur` by default, relocatable with $MURMUR_HOME. Resolvers are pure —
// a writer mkdirs at its own write site.

import { homedir } from 'node:os'
import { join } from 'node:path'

export function homeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MURMUR_HOME?.trim()
  return override ? override : join(homedir(), '.murmur')
}

// Irreplaceable user state (spec 05 memory/, incl. the persona). Back it up.
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'data')
}

// Rebuildable caches (the music bed). Safe to delete — costs a re-pull.
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), 'cache')
}
