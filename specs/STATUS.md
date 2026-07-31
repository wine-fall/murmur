# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Last updated: 2026-07-31 (end-to-end latency re-measured on real `make dev` runs)_

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
  **Next**: the §5.11 sensory pass (user-run) and the §6.1 art-direction
  session — see the slices 2-3 entry below.

- **spec 10 slices 2-3 are built (2026-07-30).** Slice 2, the visualizer feed:
  the audio engine gained a master bus and one `AnalyserNode` tap on it, opened
  by the first `vizSub` and never before (an unwatched run has no analyser in
  its graph — asserted with a spy, §5.5); 28 log-spaced bins at 24fps over the
  wire, bypassing the replay backlog; the client renders cava-style eighth-block
  bars under a vertical gradient. Verified end-to-end against a REAL
  `AudioContext`, not fakes: a 440Hz tone produced 72 frames in 3s (exactly
  24fps) peaking in the 422-469Hz band, and frames stopped dead on unsubscribe.
  Slice 3, the pet + warmth kit: six committed sprite poses as indexed pixel
  grids (half-block cells, palette resolved at render time), pose selected from
  `ProgramState` (invite → turns to you, away → dozes, else the segment),
  scene-derived accent tinting across strip/bars/pet/segments, DJ microcopy
  picked engine-side from `prompts.ts` and carried on `state.microcopy`, and an
  absence greeting from `hello.away` (frozen at boot, never a reproach).
  Also: the CI `tui` job (bun tsc) that slice 1 owed.
  **Two real races were found by peer review and fixed with regression tests**:
  the client wrote its one-shot `vizSub` before `attach` reached the wire (a
  socket flushes connect-queued writes in ISSUE order, so an attach deferred to
  the `connect` event loses — the engine then dropped the subscription and the
  strip stayed blank all session); and the engine dropped a subscription that
  arrived before `runApp` had built the feed. **Owed: the §5.11 sensory pass
  (user-run)** — does it feel like a warm little radio with a soul, or a
  dashboard? And the §6.1 art-direction session, which restyles this substrate
  without reopening its contracts.

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
- **End-to-end latency, measured on real runs (2026-07-31).** Two real `make dev`
  runs, no `STUB`: real brain (`claude-opus-4-8`), real `yt-dlp`, the hosted
  fish.audio voice, audio out of the speakers. **Conditions**: macOS; an isolated
  `MURMUR_HOME` with the bundled persona pre-seeded (so first-run onboarding does
  not fire) and the bed cache warm; `MURMUR_ACTIVITY=present` pinned so the
  spec-07 away-gate cannot short-circuit the cadence; everything else default
  (`cadence=every_n`, `musicEveryN=2`, `gapSeconds=2`, `TALK_LOOKAHEAD=2`).
  t0 = the moment `make dev` execs `node src/main.ts` (`pnpm install` + preflight
  cost a further ~3.7 s ahead of it). **cold** = first run, empty memory; **hot** =
  a second run nine minutes later, memory carrying the cold run's turns and songs.
  - **(a) t0 → first music: 136 s cold / 195 s hot.** *Worse* than the ~76 s
    motivating number — whose measurement conditions were never recorded, so read
    the comparison as indicative, not like-for-like. The look-ahead is not the
    cost: t0 → banner (startup checks + warm bed) 4.2 / 4.7 s; the one cold
    `nextTalks` + TTS batch 24.5 / 33.9 s, so **t0 → first audible word is 28.7 s
    cold / 38.6 s hot**. Music is then held first by the *cadence* (`musicEveryN=2`
    makes it eligible only at the 3rd boundary — t0+74 s / t0+101 s) and then by
    the **first music pick still resolving**: 2 (cold) / 3 (hot) consecutive music
    boundaries yielded to talk under the never-block-the-air rule (spec 04 slice
    1), so the song landed at boundary 5 / 6. That first pick took ~75-105 s
    (cold) / ~125-155 s (hot) to resolve, bracketed by the boundaries that saw it
    unresolved. With a primed pick the music boundary costs **~4 s** of stream
    spin-up (cold's second song), and the announce lands ~1 s later.
  - **(b) music→talk boundary: zero producer wait, confirmed.** cold: song ended
    ≈10:56:38 → `talk.buffer warm depth=2` at 10:56:40 → clip on air at
    10:56:40.08. hot: ≈11:07:06 → 11:07:08 → 11:07:08.27. **All 13 buffered
    boundaries across both runs aired in the same second as their warm marker**
    (0 s residual Brain/synth wait); the only dead air left is the configured 2 s
    `gapSeconds`. The ~24 s cold batch is paid once per session at startup and
    never again at a boundary — spec 04 §3.3 delivers what it claimed.
  - **Open, in the order worth attacking** (nothing was changed here — this was a
    measurement pass): the first music pick's agentic discovery, which is now the
    dominant term in (a); the cold talk batch, with nothing on air to hide it
    behind; and the fact that **hot is slower than cold** — a richer memory
    context slows both the batch and the discovery, so context growth, not
    process warmth, is the variable that moved.
  - Also observed, untriaged and untouched: Ctrl-C did not finish shutdown within
    30 s in either run (`stopping...` printed; `stopped cleanly.` never did) and
    the runner had to `SIGKILL`. No orphan processes survived it.
- **Open: by-ear / sensory acceptance over the TS build (user-run).** The
  L0/L1 "sounds human, feels like radio" pass: TS voice quality, duck /
  crossfade smoothness, bed levels (`_BED_GAIN`-equivalent knobs), the
  announce-vs-stream-startup timing. A real listening pass, not an assertion.
- **Open: interactive guide acceptance (03-03 §5.3, user-run).** The repair
  flow in a real terminal against a genuinely broken binary — checklist handed
  over at Phase 4.5.
- Specs 06/07/10 are expected to keep changing as we learn — not frozen. (08 and
  09 no longer exist as specs; see the restructure note above.)
