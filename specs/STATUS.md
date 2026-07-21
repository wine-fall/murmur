# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Last updated: 2026-07-21_

- **Milestone: L0 + L1 — code-complete.** L0 = specs `01-core-loop` +
  `02-voice-provider`; L1 = adds `03-01-brain-harness` + `03-02-ducking` (+ the
  `03-03` guided install). The code and unit gate are done and green.
- **Current focus: cold-start / responsiveness — `spec 04` (no-dead-air),
  pulled forward.** A `make dev-fishaudio` measurement showed boot is fast
  (~3.5s) but the first-music wait is long (~76s: forced opening talk segments +
  a ~45s cold music search). Attacked in PRs:
  - **shipped (PR #24)**: spec 01 §3.3 — `Steer` + prepare-then-barge-in
    interjection (no dead-air on talk-back); groundwork for the look-ahead.
  - **shipped (PR #25)**: spec 04 slice 1 — **music-pick prefetch** (overlap the
    ~45s find-and-pull with the opening talk).
  - **shipped (PRs #26, #29)**: spec 04 slice 2 — **talk look-ahead** (batched
    `Brain.next_talks` via the `emit_talk_beats` harness tool; parallel TTS).
  - **building**: spec 04 §3.3 — **talk look-ahead survives music** (depth-2
    buffer, refilled when drained — including during a song — so the music→talk
    boundary has no Brain/synth wait; bounded retry + dev-log on the refill path).
- **Open: end-to-end latency measurement.** Acceptance so far is mechanism-level
  (fakes prove the buffers work); the motivating ~76s first-music wait has **not**
  been re-measured on a real run. Owed: a `make dev-fishaudio` before/after.
- **Built (spec 03-04): always-on background music bed.** A continuous
  low-volume instrumental under all talk that crossfades out under the featured
  song and back (building 03-02's deferred crossfade primitive), with a
  seamless bed loop. Curated `assets/bed_sources.txt` → first-run pull to
  `~/.cache/murmur/bed/` (`make bed-refresh`) → **local-only** at runtime.
  `--no-bed` / empty cache degrade to talk-with-silence. Mechanism unit-green +
  real-boundary smoke passed; **by-ear tuning of `_BED_GAIN`/`_BED_XFADE_S` and
  crossfade smoothness owed** (folds into the sensory pass below).
- **Open: by-ear / sensory acceptance** (L0/L1 "sounds human, feels like radio",
  PR #24's gapless-barge-in feel) — owed once the TUI is ready; a real listening
  pass, not an assertion.
- **Designed (spec 05, `specs/spec05/05-memory.md`): persistent memory —
  approved 2026-07-21, build not started.** Three persistent tiers
  (profile/history/ledger, local files) + context-pack assembly (ratifies the
  spec-04 §3.4 `scene` field; adds `profile` / `covered_topics`) + background
  compaction + the repo path-governance rule (`paths.py`, XDG data/cache
  roots). Motivated in part by issue #44 (cold-open repetition); library
  research recorded in issue #45 (verdict: stdlib files, no dependency).
  **Building spec 05 is the next focus after spec 04 §3.3 closes.**
- Later specs (06–09) are expected to change as we learn — not frozen.
