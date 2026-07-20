# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Last updated: 2026-07-20_

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
- **Fixed (spec 03-02/04): "announced song but silent."** An intermittent
  googlevideo 403 made `play_music` hand back a handle that never decoded a
  frame; the announce had already claimed the song, then the loop silently cut to
  talk. Now: the music path has observability (`play_music` / feeder
  first-frame / EOF-reason+frames / surfaced ffmpeg stderr / `music.segment`
  timing), the decoder RAISES on abnormal ffmpeg exit (no longer masquerades as a
  clean end), and the Director confirms real audio (`MusicHandle.wait_started`)
  before committing the announce; on no audio it retries a fresh pick (usually a
  different, working stream) and only degrades visibly to talk once the bounded
  attempts are spent. The bed now covers stream startup (bed<->song crossfade
  deferred to first audio), so a dead pick never leaves dead air. **Owed (by-ear pass):** the announce can still
  land a beat into the song when TTS synth outruns stream startup — sensory tuning.
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
- Later specs (05–09) are expected to change as we learn — not frozen.
