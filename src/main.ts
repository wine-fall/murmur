// Entry point: parse the CLI, run the app. Kept separate from app.ts so tests
// can import the wiring without executing it.

import { parseCli } from './config.ts'
import { runApp, runBootstrapProfileCli, runSetupCli } from './app.ts'

// Name the process so `ps` shows "murmur" — memwatch/devwatch root their
// process-tree sampling on that name.
process.title = 'murmur'

const { config, maxSegments, setup, setupMusic, bootstrapProfile } = parseCli(process.argv.slice(2))
if (setupMusic) await runSetupCli(config, { musicOnly: true })
else if (setup) await runSetupCli(config)
else if (bootstrapProfile) await runBootstrapProfileCli(config)
else await runApp(config, maxSegments)
// The stdin reader keeps the event loop alive after a bounded run; exit now
// that shutdown has completed.
process.exit(0)
