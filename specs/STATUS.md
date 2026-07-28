# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Last updated: 2026-07-28 (spec 04 talk look-ahead landed)_

- **The implementation is TypeScript.** The Python → TS migration (issue #54)
  is complete: Phases 0–5 merged (PRs #56–#60 + the Phase 5 cutover PR). The
  TS tree was promoted to `src/` + `test/`; the Python implementation is
  deleted (the specs remain the contracts; per-spec `TS port` banners record
  what each phase realized). Toolchain: Node ≥ 24 native type-stripping,
  vitest, `tsc --noEmit`, oxlint, zod at every trust boundary; audio is a Web
  Audio graph on `node-web-audio-api` (chunk-scheduled buffer segments for
  long sources — spec 03-02 §3.1-TS); the hosted fish-speech endpoint is the
  real voice (local TTS deferred, spec 02 §3.6). The persistent memory dir
  carried over unchanged (Python-compatible on-disk layout, spec 05).
  - Pinned TS-SDK seam facts (do not relitigate): the guide's built-in surface
    is bounded via `tools` (NOT `allowedTools`, which auto-approves in the TS
    SDK); `runGuide` always uses streaming input (permission callback + reply
    loop both need it).
  - Known-accepted gap: no cancellable-task seam — an in-flight background
    pick is dropped on shutdown and the orphaned subprocess self-terminates on
    EPIPE (bounded leak; an AbortSignal through `Harness.runTask` is the
    noted want).
- **Milestone: L0 + L1 — code-complete (TS).** L0 = specs `01-core-loop` +
  `02-voice-provider` (hosted voice); L1 = adds `03-01-brain-harness` +
  `03-02-ducking` + `03-03` guided install + the `03-04` bed + spec 05 memory.
  Unit gate green (vitest); real-SDK smokes passed per phase.
- **spec 04 is now fully ported: the depth-2 talk look-ahead (§3.2, incl.
  "survives music") landed on the TS Director** (2026-07-28). Buffered beats
  carry their synth promise; the refill is single-flight, coherent (queued
  beats ride the context), fires after each aired beat and at music start; a
  steer discards via an epoch guard (promises cannot be cancelled — see spec 04
  §3.3). Real-SDK smoke: refill resolved mid-song; the music→talk boundary
  aired a prebuilt clip with zero Brain/synth wait (first cold batch was ~24 s
  — the latency now hidden). The `talkBatch` config knob is retired.
- **Open: end-to-end latency measurement.** The motivating ~76s first-music
  wait has not been re-measured on a real TS run. Owed: a `make dev`
  before/after now that the look-ahead has landed.
- **Open: by-ear / sensory acceptance over the TS build (user-run).** The
  L0/L1 "sounds human, feels like radio" pass: TS voice quality, duck /
  crossfade smoothness, bed levels (`_BED_GAIN`-equivalent knobs), the
  announce-vs-stream-startup timing. A real listening pass, not an assertion.
- **Open: interactive guide acceptance (03-03 §5.3, user-run).** The repair
  flow in a real terminal against a genuinely broken binary — checklist handed
  over at Phase 4.5.
- Later specs (06–09) are expected to change as we learn — not frozen.
