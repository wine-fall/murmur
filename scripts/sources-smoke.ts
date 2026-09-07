#!/usr/bin/env node
// The real-boundary check for one mounted taste source (spec 14 §5.2/§5.7):
// verify who the mount signs in as, take a snapshot, and print the digest
// that would reach the brain. Reads $MURMUR_HOME/sources.json as the radio
// does; mount first with /sources in a running murmur.
//
//   node scripts/sources-smoke.ts <youtube|bilibili|netease|spotify|qishui>
//
// Counts and the digest go to the terminal (that is the point); nothing is
// written to the dev log, and the snapshot file is left as the radio wrote it.

import { parseCli } from '../src/config.ts'
import { ytdlpRunner } from '../src/music/music.ts'
import { buildSource, CookieJars } from '../src/music/sources/build.ts'
import { SourcesStore } from '../src/music/sources/store.ts'
import { renderTasteDigest, SOURCE_IDS, type SourceId } from '../src/music/sources/taste.ts'

const id = process.argv[2]
if (!(SOURCE_IDS as readonly string[]).includes(id ?? '')) {
  console.error(`usage: node scripts/sources-smoke.ts <${SOURCE_IDS.join('|')}>`)
  process.exit(2)
}
const source = id as SourceId
const { config } = parseCli([], process.env)
const store = new SourcesStore({ path: config.sourcesPath, tasteDir: config.tasteDir, log: (m) => console.error(m) })
const entry = store.read()[source]
if (entry === undefined) {
  console.error(`${source} is not mounted in ${config.sourcesPath} — type /sources in a running murmur first.`)
  process.exit(1)
}
const ytdlp = ytdlpRunner(config.ytdlpCmd)
const adapter = buildSource(source, entry, { ytdlp, jars: new CookieJars(ytdlp), store, openUrl: () => {} })
if (adapter === null) {
  console.error(`no adapter for ${source}`)
  process.exit(1)
}
let t = performance.now()
const who = await adapter.verify()
console.log(`verify ${Math.round(performance.now() - t)}ms:`, who.ok ? `signed in as ${who.who}` : `failed: ${who.reason}`)
if (!who.ok) process.exit(1)
t = performance.now()
const snapshot = await adapter.snapshot()
const kinds = new Map<string, number>()
for (const item of snapshot.items) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
console.log(`snapshot ${Math.round(performance.now() - t)}ms: ${snapshot.items.length} items`, Object.fromEntries(kinds))
console.log(`bytes: ${Buffer.byteLength(JSON.stringify(snapshot))}`)
console.log('\n--- digest as the brain would read it (this source alone) ---')
console.log(renderTasteDigest([snapshot], new Date()))
