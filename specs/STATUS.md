# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Last updated: 2026-07-14_

- **Milestone: L0 + L1 — code-complete.** L0 = specs `01-core-loop` +
  `02-voice-provider`; L1 = adds `03-01-brain-harness` + `03-02-ducking` (+ the
  `03-03` guided install). The code and unit gate are done and green.
- **Current focus: cold-start / responsiveness — `spec 04` (no-dead-air),
  pulled forward.** A `make dev-fishaudio` measurement showed boot is fast
  (~3.5s) but the first-music wait is long (~76s: forced opening talk segments +
  a ~45s cold music search). We are attacking it in PRs:
  - **shipped (PR #24)**: spec 01 §3.3 — `Steer` + prepare-then-barge-in
    interjection (no dead-air on talk-back); groundwork for the look-ahead.
  - **building**: spec 04 slice 1 — **music-pick prefetch** (overlap the ~45s
    find-and-pull with the opening talk).
  - **next**: spec 04 slice 2 — **talk look-ahead** (one Brain call → N scripts,
    parallel TTS, buffered) — adds `Brain.next_talks`.
- **Open: by-ear / sensory acceptance** (both the L0/L1 "sounds human, feels like
  radio" pass, and PR #24's gapless-barge-in feel) — owed once the TUI is ready;
  needs a real listening pass, not an assertion.
- Later specs (04 slice 2, 05–09) are expected to change as we learn — not frozen.
