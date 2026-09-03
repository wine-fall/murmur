// One filtered process warning (spec 05-01 §3.4).
//
// `node:sqlite` is behind Node's experimental flag and warns on load. The
// listener did not choose SQLite, cannot act on the warning, and is looking at
// a radio — so that one line is dropped. Every other warning, experimental ones
// included, still prints through Node's own handler.
//
// Import this BEFORE anything that loads node:sqlite: ESM evaluates imports in
// order, and the warning fires the moment the module loads.

const passthrough = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return
  for (const listener of passthrough) listener(warning)
})
