# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_This file is a **card, not a ledger**: an entry that is done and no longer
guides the work gets **deleted**, not archived. History lives in git and PR
bodies; measured facts live in the spec they verify._

_Last updated: 2026-07-31 (latency re-measured; completed entries collapsed)_

## Where we are

**L0 + L1 are code-complete in TypeScript, and every code spec on the roadmap is
built.** L0 = `01-core-loop` + `02-voice-provider` (hosted voice); L1 adds
`03-01-brain-harness` + `03-02-ducking` + `03-03` guided install + the `03-04`
bed + spec 05 memory. Unit gate green (vitest); real-SDK smokes passed per
phase. One decided slice awaits its build (#88, conversational onboarding —
spec 03-03 §7); everything else left is under **Open** — engineering items
first, then the by-ear passes.

Built, with the PR that landed it — read the spec for what it does, the PR for
how it got there:

- Python → TypeScript migration, issue #54 (#56-#61). The specs stayed the
  contracts; per-spec `TS port` banners record what each phase realized.
- spec 04 look-ahead — depth-2, survives music (#64); measured 2026-07-31, see
  [`spec04/04-no-dead-air.md`](spec04/04-no-dead-air.md) §3.3.
- spec 05 persistent three-tier memory + compaction (#59).
- spec 06 first-run persona seed, consented profile bootstrap, relationship
  section (#67).
- spec 07 presence, time anchors, invites, away gating (#68).
- spec 10 TUI — the wire + `IpcHost` + OpenTUI client (#71); the visualizer
  feed + pixel pet + warmth kit (#74). Redesign decisions: #70.
- Spec restructure — persona stays stable, 06 rescoped, 07 extended, 08 and 09
  retired (#65).

## Open

Every open debt is a GitHub issue; this list is the **index, not the record**.
One line each — the issue body carries what it is, the spec it touches, and how
it closes. Add and remove entries with the `murmur-issue` skill, never by
hand: CI fails if this section points at an issue that is already closed.

- **#76** (eng) Cut the first-music latency — the pick's agentic discovery is now the dominant term.
- **#88** (eng) Conversational onboarding — the app fixes its own gaps by talking; spec 03-03 §7.
- **#89** (eng) Second brain backend: Codex SDK — recorded direction, not scheduled.
- **#78** (by-ear) Does it feel like a warm little radio? — spec 10 §5.11 plus the L0/L1 listening pass.
- **#79** (by-ear) The art-direction session for the TUI and the pet — spec 10 §6.1.
- **#80** (by-ear) First-run onboarding in a real terminal — spec 06 criterion 12.
- **#81** (by-ear) A real day of pacing — spec 07 §5.16.
- **#82** (by-ear) The guide's repair flow in a real terminal — spec 03-03 §5.3.
- **#83** (watch) Enter during an uncommitted IME composition may submit the line.

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
