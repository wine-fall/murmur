#!/usr/bin/env node
// Entry point: parse the CLI, run the app. Kept separate from app.ts so tests
// can import the wiring without executing it.

// First, and before anything that loads node:sqlite (spec 05-01 §3.4).
import './warnings.ts'

import { packageVersion, parseCli } from './config.ts'
import { runApp, runBootstrapProfileCli, runSetupCli } from './app.ts'

// Name the process so `ps` shows "murmur" — memwatch/devwatch root their
// process-tree sampling on that name.
process.title = 'murmur'

const { config, maxSegments, setup, setupMusic, bootstrapProfile, version } = parseCli(
  process.argv.slice(2),
)
if (version) console.log(packageVersion())
else if (setupMusic) await runSetupCli(config, { musicOnly: true })
else if (setup) await runSetupCli(config)
else if (bootstrapProfile) await runBootstrapProfileCli(config)
else await runApp(config, maxSegments)
// The stdin reader keeps the event loop alive after a bounded run; exit now
// that shutdown has completed.
process.exit(0)
