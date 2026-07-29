# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Last updated: 2026-07-29 (spec 10 slice 1 built and accepted; gate 1 passed)_

- **spec 10 slice 1 is built (2026-07-29).** The wire (`src/ipc.ts`: zod
  schemas, ndjson framing, one source of truth for both processes), the
  engine-side `IpcHost` bridge over a unix socket, the `frontEnd` config knob
  (`--tui`, default still `plain`), the bun startup probe, and the OpenTUI/React
  client shell under `tui/` (status strip, program log, input line). The
  Director now emits `onState` at the boundaries it already had. **Gate 1
  (Chinese IME) passed by user judgment** in a real terminal, so the OpenTUI
  choice stands and slices 2-3 are unblocked. Carried as a watch item, not a
  blocker: Enter pressed during an uncommitted composition may submit the line
  instead of committing the candidate (spec 10 §5.1) — the engine-side path is
  cleared by byte-level tests, so any recurrence is the input widget's.
  **Next**: slice 2 (engine FFT tap + `viz` feed, §3.6), then slice 3 (pet
  substrate + warmth kit, §3.7). The §6.1 art-direction session with the user
  should happen before or during slice 3.

- **spec 10 (TUI) redesigned (2026-07-29, docs only).** After a four-report
  research pass with **visual delight promoted to a first-tier requirement**
  (the TUI is the product's face — user-set bar), the front-end framework is
  **re-decided: OpenTUI (TypeScript) under Bun**, superseding Go/Charm; "two
  processes over IPC" stays locked, and the wire is now defined (unix-socket
  ndjson, zod schemas shared in-repo, versioned handshake — spec 10 §2.3).
  The spec also gained the shipped-feature interaction inventory (§3.2: the
  four contextual meanings of a typed line, the guide/first-run Q&A mode, the
  full display-state map), the engine-side FFT visualizer feed (§3.6), and
  the warmth kit (§3.7: text-asset sprites, content-derived tinting, DJ
  microcopy). **Build sequencing**: acceptance gate 1 (CJK/IME under the
  OpenTUI input widget, user-run) is a hard week-1 gate with recorded
  Ratatui/Ink fallbacks. spec 10 is now the next (and last) code spec on the
  roadmap; the §6.1 creative session (art direction, the pet's identity) is
  a separate user conversation before or during the build.

- **Spec restructure (2026-07-29, docs only — no code changed).** Decisions
  taken with the user and now recorded in the specs:
  - **The persona does NOT auto-evolve** (master §2.3, amended). It is a
    stable, **user-editable** asset seeded once on first run; the **profile**
    tier is what grows (spec 05 compaction, extended by spec 06 slice C).
    Rationale: LLM rewrite loops mean-revert and have no user-visible
    checkpoint — a host's charm is a stable character.
  - **spec 06 rescoped** `persona-lifecycle` → **`first-run & relationship`**
    ([`spec06/06-first-run.md`](spec06/06-first-run.md)): slice A first-run
    onboarding → persona seed on disk; slice B optional, consented Claude-Code
    history → **profile** bootstrap (absorbed from spec 09); slice C a
    "relationship & style" section in the compaction prompt. Depends on 05
    only; no new machinery loop.
  - **spec 07 extended** ([`spec07/07-proactive-pacing.md`](spec07/07-proactive-pacing.md)):
    turn-to-you degree + time anchors + ActivitySensor (keyboard/OS idle) **+
    activity-gated generation**, absorbed from the dissolved 08.
  - **spec 08 `token-economy` dissolved** — batch landed (04), caching is
    SDK-level, tiering is a config knob, gating → 07, budget → backlog. Master
    §7 stays the rationale home and now carries a per-pillar status column.
  - **spec 09 `claude-code-ingestion` retired** as a standalone spec — profile
    bootstrap → 06 slice B; persona inference cut; CC-derived activity signals
    cut (local idle is cheaper and more accurate). The §10 row is kept, marked
    retired, so the reasons are not re-litigated.
- **spec 06 is built (2026-07-29).** First-run onboarding seeds `persona.md`
  (slice A); the optional, consented Claude-Code-history → profile bootstrap
  runs on the spec-03-01 harness behind a realpath-scoped read-only tool set
  (slice B, with `murmur --bootstrap-profile` as the later re-entry); the
  compaction prompt now maintains a second "relationship & style" section
  (slice C). Unit gate green, and slices A/B were smoke-tested through the real
  SDK. **Owed**: the first-run pass in a real terminal (criterion 12, user-run).
- **spec 07 (proactive & pacing) is built at the mechanism level** (2026-07-29):
  `ActivitySensor`/`IdleSensor` (idle time only, optional macOS `ioreg` probe,
  degrades to murmur's own input recency), time anchors on the tier-③ ledger
  (`anchorDay` keys an occurrence by the date its window OPENED, so the
  22:00-01:00 night window cannot double-fire across midnight),
  `PacingCadence` + away gating (zero `nextTalks`/`synthesize` in an empty room;
  the look-ahead buffer is kept, not discarded), and the invite / slide-back
  window (one counter, one flag, one deadline — deliberately no retry path).
  All three switchable off (`--no-anchors` / `--no-invites` / `--no-gating`).
  **Owed: the §5.16 sensory pass (user-run)** — do the anchors land at the right
  moments, does the invite read as inviting rather than needy, does walking away
  make it go quiet without feeling dead? Every constant in the spec is a by-ear
  guess and the first real day is expected to move several.
- **Next build target: spec 10 (TUI)** — with 06 and 07 both built, it is what
  is left on the board. The two by-ear passes 06 and 07 each owe (first-run in a
  real terminal; a real day of pacing) are the user's to run and gate nothing.

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
- Specs 06/07/10 are expected to keep changing as we learn — not frozen. (08 and
  09 no longer exist as specs; see the restructure note above.)
