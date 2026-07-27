// Entry point: parse the CLI, run the app. Kept separate from app.ts so tests
// can import the wiring without executing it.

import { parseCli } from './config.ts'
import { runApp } from './app.ts'

const { config, maxSegments } = parseCli(process.argv.slice(2))
await runApp(config, maxSegments)
// The stdin reader keeps the event loop alive after a bounded run; exit now
// that shutdown has completed.
process.exit(0)
