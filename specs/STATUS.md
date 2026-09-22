# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Direction and ordering live in [`ROADMAP.md`](../ROADMAP.md); this card is
only the current focus._

_This file is a **card, not a ledger**: an entry that is done and no longer
guides the work gets **deleted**, not archived. History lives in git and PR
bodies; measured facts live in the spec they verify._

_Last updated: 2026-09-22 (spec 03-03 §7.2, default female voice re-cloned from a real recording)_

## Where we are

**L0 + L1 are code-complete in TypeScript, and every code spec on the roadmap is
built.** L0 = `01-core-loop` + `02-voice-provider` (hosted voice); L1 adds
`03-01-brain-harness` + `03-02-ducking` + `03-03` guided install + the `03-04`
bed + spec 05 memory (v1.5 — `05-01` recall & forgetting), with 04, 06, 07, 10,
11, 12 and 13 (real-world topics) on top. Unit gate green (vitest); real-SDK
smokes passed per phase. **Each spec's own status header records what its build
realized and the PR that landed it.** Everything open is under **Open**.

**In flight: spec 03-03 §7.2, the default female voice.** It was a clone of a
clone of a 5 s render; it is now a first-generation clone of a real recording,
and `female-v2.mp3` is the matching >=20 s preset clip. #295 carries the ear,
#294 the same debt on the male side. Stock lines (#292) and discovery
(#288 / #289 / #291) landed; #293 and #290 carry their verdicts.

**No listener data in the repository** (2026-09-20, user): nothing from
`~/.murmur` — a song, artist, playlist or channel name, an account name, a
url — goes into git. Fixtures are invented, the real snapshots are measured
only in the gitignored `scratch/`, and a PR body or commit message carries
numbers, never content.

## Open

Every open debt is a GitHub issue; this list is the **index, not the record**.
One line each — the issue body carries what it is, the spec it touches, and how
it closes. Add and remove entries with the `murmur-issue` skill, never by
hand: CI fails if this section points at an issue that is already closed.

- **#295** (by-ear) The new default female voice, and the 6.4 LU it lost against the retired clone — spec 03-03 §7.2.
- **#294** (eng) `male.mp3` is still a clone of a clone; the preset clip needs a real recording — spec 03-03 §7.2.
- **#293** (by-ear) The stock opener set and the farewell: count, genericness, variety — spec 04 §3.6.
- **#290** (by-ear) Does the discovery change actually widen what plays — spec 14 §3.10's familiar share per 100 airs.
- **#284** (eng) `CLOCK_USAGE` is a per-fact "reference only" rule — the one prompt rule spec 04 §3.5 forbids.
- **#269** (bug, eng) The session-mark invitation test races a 40 ms timer against a 1 s poll budget — four CI occurrences, never reproduced locally.
- **#272** (bug, eng) A NetEase resolve costs 15-55 s — yt-dlp walks its quality levels one request at a time.
- **#273** (bug, eng) Brain cadence never beats its own 8 s deadline, so every boundary falls back silently.
- **#89** (eng) Second brain backend: Codex SDK — recorded direction, not scheduled.
- **#44** (eng) Cold-start talk repeats the same cozy imagery — absorbed by spec 13; closes on #202's first box.
- **#79** (by-ear) The art-direction session for the TUI and the pet — spec 10 §6.1.
- **#80** (by-ear) First-run onboarding in a real terminal — spec 06 criterion 12.
- **#81** (by-ear) A real day of pacing — spec 07 §5.16.
- **#83** (watch) Enter during an uncommitted IME composition may submit the line.
- **#98** (eng) Steer tool-choice eval (Ollama) owed — the smoke is on-demand only; spec 11 §5.
- **#102** (enhancement, eng) The voice guide's live policy check burns ~6 consent rounds before degrading.
- **#104** (eng) DESIGN.md still claims fully-local / two hops / Claude-brain — stale vs what shipped.
- **#255** (bug, eng) The NetEase / Bilibili / Soda clients read the response body outside their timeout — a stalled body hangs a mount.
- **#138** (by-ear) Quit feel + the entry-authorization setup flow — spec 03-03 §5.3.
- **#99** (by-ear) Spec 11 acceptance pass — handover feel, slow-pick cover, two-phase off.
- **#149** (by-ear) Does the music pick actually stop repeating — spec 03-01 §2.3.
- **#197** (by-ear) Memory v1.5 by feel: fading, fold cadence, forgetting, how a recalled memory sounds — spec 05-01 §6.
- **#198** (by-ear) The talk<->music transitions: announce hand-over and the slow lift — spec 03-02 §6.1.
- **#202** (by-ear) Real-world topics as a friend would mention them, and the clock as bearings — spec 13 §5, spec 04 §3.4.
- **#213** (by-ear) Listening-taste on the listener's own accounts: NetEase, Spotify, Soda, the expired line, the evening, and the sign-in card's road + profile — spec 14 §5.12, §3.1.
- **#153** (bug, eng) First-run onboarding keeps asking after /quit and never says the answers were dropped.
- **#163** (enhancement, eng) The director never interjects a talk beat over a ducked song — the engine seam is already there.

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
