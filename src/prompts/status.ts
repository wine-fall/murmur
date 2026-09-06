// Status microcopy (spec 10 §3.7.4): what the front-end's status strip says
// the program is doing, in the DJ's own words. Authored text, zero tokens.

// What the front-end's status strip says the program is doing — in the DJ's own
// words, never a loader's ("finding something for this hour…", not "loading").
// A fixed local pool: the chrome is authored text, so it costs zero tokens
// (master §7 pillar 6) and never waits on a model.
//
// It lives here, with every other line murmur speaks, rather than in the TUI:
// the front-end renders the persona's voice, it does not write it. That is why
// the picked line travels on the wire's `state` message.
export const STATUS_MICROCOPY = {
  talk: ['on the air', 'thinking out loud', 'just talking'],
  music: ['letting this one play', 'sitting with this one', 'this one is for the hour'],
  gap: ['letting it breathe', 'a beat of quiet', 'listening to the room'],
} as const satisfies Record<string, readonly string[]>

// `roll` is injectable so a test can pin the pick.
export function statusMicrocopy(
  state: { kind: 'talk' | 'music' | 'gap' },
  roll: () => number = Math.random,
): string {
  const pool = STATUS_MICROCOPY[state.kind]
  return pool[Math.min(Math.floor(roll() * pool.length), pool.length - 1)]!
}
