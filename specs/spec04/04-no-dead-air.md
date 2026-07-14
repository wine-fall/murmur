# spec/04 · no-dead-air — look-ahead / pre-generation buffer

> **Status**: In progress. **Pulled forward** ahead of the 05–09 order to attack
> first-cold-start latency (the `make dev` → first-music / first-reply wait). It
> lands in slices:
>   - **slice 1 (this build)**: **music-pick prefetch** — overlap the multi-second
>     find-and-pull (`TrackSource.next_track`) with the opening talk segments, so
>     the music branch airs an already-resolved pick instead of starting cold.
>   - **slice 2 (next build)**: **talk look-ahead** — one Brain call emits N talk
>     scripts, synthesized in parallel and buffered, so segment *k+1* airs with no
>     Brain+synth wait after *k*. This pulls forward spec 08's *batch-generation*
>     pillar as the latency vehicle (not the full token economy).
> **Part**: Polish over L1 (responsiveness). Removes producer latency (Brain, TTS,
> music search) from the listener's timeline by pre-generating behind live audio.
> **Milestone**: post-L1 cold-start / no-dead-air. See master [`../DESIGN.md`](../DESIGN.md)
> §4 (concurrency: single loop + 1-segment look-ahead), §7 (token economy, batch pillar).
> **Conventions**: English; written for a coding agent. Design-level.

---

## 1. Goal & scope

### Delivers
Pre-generation **buffers inside the Director** that hide producer latency behind
whatever is already on air, so the listener hears less dead air and reaches the
first song / first reply sooner — without multi-process complexity (master §4:
"single loop + 1-segment look-ahead").

- **slice 1 — music-pick prefetch (this build).** The next music pick is found +
  pulled in the background *while talk segments play*, so the ~seconds of
  `next_track` latency overlap audio the listener is already hearing.
- **slice 2 — talk look-ahead (next build).** One Brain call yields N segment
  scripts; their TTS runs in parallel; the Director buffers the extras so the
  next segment airs with no Brain/synth wait.

### Out of scope
- **Full token economy** (prompt caching, tiered models, activity-gating,
  budget/degradation) — spec 08. Slice 2 borrows only 08's *batch-generate-N*
  as a latency vehicle, not the economy.
- Buffering across restarts; activity-aware pacing (spec 07); semantic recall.

---

## 2. Contracts / seams
No new outbound seam. Reuses `TrackSource.next_track` (spec 03-01) and, for
slice 2, a **new** batch method on the Brain, `next_talks(ctx, count) -> list[str]`
(additive; the single `next_talk`/`respond` stay). The look-ahead **buffers live
inside the Director** — they are private scheduling state, not a cross-spec seam.

---

## 3. Design

### 3.1 Music-pick prefetch (slice 1)
A **single-slot** prefetch buffer in the Director holds an in-flight (or
finished) `next_track` task:

- **Fire:** once a talk segment's text exists (so `MusicContext.situation` has
  real mood), if music is wired and the slot is empty, start
  `asyncio.create_task(music.next_track(ctx))` and park it in the slot. The talk
  segment then airs as normal — the pick resolves in the background.
- **Consume:** when the music branch fires, if the slot holds a task, `await` it
  (near-instant if already resolved; otherwise finish what's left) instead of a
  cold `next_track`. Clear the slot; the next talk segment refills it. So the
  Director always runs **one pick ahead**.
- **Cold fallback:** if the slot is empty when the music branch fires (e.g. the
  very first segment, or a pick just consumed), do a cold `next_track` exactly as
  before — correctness never depends on the buffer being warm.
- **Staleness (accepted):** the pick is chosen on the mood at *fire* time and may
  air a segment or two later. Songs are long and background; a slightly older
  mood is an acceptable trade for hiding the latency. Not invalidated by a steer
  (unlike a talk look-ahead) — a background song is low-stakes.
- **Shutdown:** an in-flight prefetch is cancelled + awaited (settled) on Director
  exit, so no orphaned task outlives the loop.

### 3.2 Talk look-ahead (slice 2 — next build)
One `next_talks(ctx, n)` call returns *n* scripts; the Director synthesizes them
in parallel and buffers segments *2..n*. Segment 1 airs immediately; each later
segment airs from the buffer with **no** Brain/synth wait. A typed line
(`Steer`) **invalidates** the buffered look-ahead — it was generated before the
user turn, so it is discarded and a fresh reply/segment is produced (spec 01
§3.3 rule). Buffered voice clips are cleared on discard/shutdown.

---

## 4. Dependencies
- **spec 01** — the Director loop + `Steer`/`_run_voice` arbitration the buffers
  plug into. **Modifies** spec 01 §3.4, which deferred look-ahead and batching:
  §3.4 now points here (the L0 minimum stands; this is the polish that lifts it).
- **spec 03-01** — `TrackSource.next_track` is the prefetched call (slice 1).
- **spec 03-02** — the music branch that consumes the prefetched pick.
- **Brain** — slice 2 adds `next_talks` (additive).

---

## 5. Acceptance criteria (feature level)
1. **slice 1:** on a run that reaches a music segment after ≥1 talk segment, the
   pick's find-and-pull latency overlaps the prior talk — the music branch's own
   `next_track` await is near-zero because the pick was prefetched. Verified via
   the deterministic seam (a fake `TrackSource` records *when* it was called
   relative to the talk segment, and the Director consumes the prefetched result).
2. **slice 1:** with no prefetch available, the music branch still resolves a pick
   (cold fallback) and behaves exactly as pre-spec-04.
3. **slice 1:** no prefetch task outlives the Director (clean shutdown / `/quit`).
4. **slice 2 (next build):** segment *k+1* airs with no Brain/synth wait after
   *k*; a typed line discards the buffered look-ahead.

---

## 6. Open questions
- **Buffer depth:** single-slot (one pick / one segment ahead) vs N-deep. Slice 1
  starts single-slot; deepen only if measurement shows a remaining gap.
- **Continuous vs cold-start-only prefetch:** slice 1 prefetches continuously
  (one pick ahead, every music cycle); if the mood-staleness ever reads wrong,
  restrict to the first cold-start pick.
- **Mood-staleness tolerance** for a prefetched pick (how far ahead is too far).
