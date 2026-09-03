# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Direction and ordering live in [`ROADMAP.md`](../ROADMAP.md); this card is
only the current focus._

_This file is a **card, not a ledger**: an entry that is done and no longer
guides the work gets **deleted**, not archived. History lives in git and PR
bodies; measured facts live in the spec they verify._

_Last updated: 2026-09-03 (memory v1.5 built — spec 05-01 recall & forgetting)_

## Where we are

**L0 + L1 are code-complete in TypeScript, and every code spec on the roadmap is
built.** L0 = `01-core-loop` + `02-voice-provider` (hosted voice); L1 adds
`03-01-brain-harness` + `03-02-ducking` + `03-03` guided install + the `03-04`
bed + spec 05 memory (now at v1.5 — `05-01` recall & forgetting), with 04, 06,
07, 10, 11 and 12 built on top. Unit gate
green (vitest); real-SDK smokes passed per phase. **Each spec's own status
header records what its build realized and the PR that landed it** — read the
spec for what it does, its PR for how it got there. Everything left is under
**Open** — engineering items first, then the by-ear passes.

## Open

Every open debt is a GitHub issue; this list is the **index, not the record**.
One line each — the issue body carries what it is, the spec it touches, and how
it closes. Add and remove entries with the `murmur-issue` skill, never by
hand: CI fails if this section points at an issue that is already closed.

- **#89** (eng) Second brain backend: Codex SDK — recorded direction, not scheduled.
- **#44** (eng) Cold-start talk repeats the same cozy imagery — a model-attractor problem, not hardcoded text.
- **#79** (by-ear) The art-direction session for the TUI and the pet — spec 10 §6.1.
- **#80** (by-ear) First-run onboarding in a real terminal — spec 06 criterion 12.
- **#81** (by-ear) A real day of pacing — spec 07 §5.16.
- **#83** (watch) Enter during an uncommitted IME composition may submit the line.
- **#98** (eng) Steer tool-choice eval (Ollama) owed — the smoke is on-demand only; spec 11 §5.
- **#102** (enhancement, eng) The voice guide's live policy check burns ~6 consent rounds before degrading.
- **#104** (eng) DESIGN.md still claims fully-local / two hops / Claude-brain — stale vs what shipped.
- **#138** (by-ear) Quit feel + the entry-authorization setup flow — spec 03-03 §5.3.
- **#99** (by-ear) Spec 11 acceptance pass — handover feel, slow-pick cover, two-phase off.
- **#149** (by-ear) Does the music pick actually stop repeating — spec 03-01 §2.3.
- **#197** (by-ear) Memory v1.5 by feel: fading, fold cadence, forgetting, how a recalled memory sounds — spec 05-01 §6.
- **#198** (by-ear) The talk<->music transitions: announce hand-over and the slow lift — spec 03-02 §6.1.

## Pinned — do not relitigate

- The guide's built-in surface is bounded via `tools`, **not** `allowedTools`
  (which auto-approves in the TS SDK); `runGuide` always uses streaming input
  (the permission callback and the reply loop both need it).
- Known-accepted gap: **no cancellable-task seam** — an in-flight background
  pick is dropped on shutdown and the orphaned subprocess self-terminates on
  EPIPE (bounded leak; an AbortSignal through `Harness.runTask` is the noted
  want).
- Audio is a Web Audio graph on `node-web-audio-api` (chunk-scheduled buffer
  segments for long sources — spec 03-02 §3.1-TS); the hosted fish-speech
  endpoint is the real voice (local TTS deferred, spec 02 §3.6).
- Specs 06/07/10 are expected to keep changing as we learn — not frozen. Specs
  08 and 09 no longer exist.
