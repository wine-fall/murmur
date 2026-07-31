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
phase. No spec is waiting to be built; what is left is under **Open** — the
engineering items first (latency, the shutdown hang), then the by-ear passes.

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

- **Latency's bottleneck has moved (measured 2026-07-31, #75).** t0 → first
  music is **136 s cold / 195 s hot**; the music→talk boundary is **confirmed
  zero-wait**, so spec 04 §3.3 delivered (record + conditions:
  [`spec04/04-no-dead-air.md`](spec04/04-no-dead-air.md) §3.3). Attack in order:
  the first music pick's agentic discovery, now the dominant term; the cold talk
  batch, with nothing on air to hide it behind; hot being slower than cold,
  which points at context growth, not process warmth. Untriaged from the same
  runs: Ctrl-C did not finish shutdown within 30 s (no orphans survived).
- **By-ear / sensory acceptance over the TS build (user-run).** The L0/L1
  "sounds human, feels like radio" pass: TS voice quality, duck / crossfade
  smoothness, bed levels, the announce-vs-stream-startup timing. A real
  listening pass, not an assertion.
- **spec 10 §5.11 sensory pass (user-run)** — does it feel like a warm little
  radio with a soul, or a dashboard? Then the §6.1 art-direction session, which
  restyles the built substrate without reopening its contracts.
- **spec 07 §5.16 sensory pass (user-run)** — do the anchors land at the right
  moments, does the invite read as inviting rather than needy, does walking away
  make it go quiet without feeling dead? Every constant in the spec is a by-ear
  guess and the first real day is expected to move several.
- **spec 06 first-run pass in a real terminal** (criterion 12, user-run).
- **Interactive guide acceptance (03-03 §5.3, user-run).** The repair flow in a
  real terminal against a genuinely broken binary — checklist handed over at
  Phase 4.5.
- **Watch item, not a blocker (spec 10 §5.1):** Enter pressed during an
  uncommitted IME composition may submit the line instead of committing the
  candidate. The engine-side path is cleared by byte-level tests, so any
  recurrence is the input widget's.

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
