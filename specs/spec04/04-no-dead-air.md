# spec/04 · no-dead-air — look-ahead / pre-generation buffer

> **Status**: In progress. **Pulled forward** ahead of the 05–09 order to attack
> first-cold-start latency (the `make dev` → first-music / first-reply wait). It
> lands in slices:
>   - **slice 1 (this build)**: **music-pick prefetch** — overlap the multi-second
>     find-and-pull (`TrackSource.next_track`) with the opening talk segments, so
>     the music branch airs an already-resolved pick instead of starting cold.
>   - **slice 2 (this build)**: **talk look-ahead** — one Brain call
>     (`next_talks`) emits N talk scripts, synthesized in parallel and buffered,
>     so segment *k+1* airs with no Brain+synth wait after *k*. This pulls forward
>     spec 08's *batch-generation* pillar as the latency vehicle (not the full
>     token economy).
>   - **§3.4 (later add)**: **time-of-day scene** — a small adjacent
>     context-enrichment that lands here (no separate spec was opened; the future
>     spec-07 time/activity home is still owed). Derives a scene bucket from the
>     local clock and threads it into the talk prompt so the host speaks to the
>     current time of day. Independent of the latency buffers above.
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
- **slice 2 — talk look-ahead (this build).** One Brain call yields N segment
  scripts; their TTS runs in parallel; the Director buffers the extras so the
  next segment airs with no Brain/synth wait.
- **§3.4 — time-of-day scene (later add).** The Director reads the local clock
  into a coarse scene bucket (morning / afternoon / evening / late-night) and
  threads it into the talk prompt, so the host's talk varies by time of day.
  Not a latency feature — an adjacent context-enrichment that landed here.

### Out of scope
- **Full token economy** (prompt caching, tiered models, activity-gating,
  budget/degradation) — spec 08. Slice 2 borrows only 08's *batch-generate-N*
  as a latency vehicle, not the economy.
- Buffering across restarts; semantic recall.
- **Activity-aware pacing** and the richer profile/ledger context (spec 07). The
  time-of-day scene (§3.4) is only the *clock* slice of that future work, pulled
  in early; activity/profile fields are still deferred.

---

## 2. Contracts / seams
No new outbound seam. Reuses `TrackSource.next_track` (spec 03-01) and, for
slice 2, a **new** batch method on the Brain, `next_talks(ctx, count) -> list[str]`
(additive; the single `next_talk`/`respond` stay). The look-ahead **buffers live
inside the Director** — they are private scheduling state, not a cross-spec seam.

For §3.4, `ContextPack` (spec 01 §2.1) gains an **optional** `scene: str | None`
field (additive, default `None`) — the time-of-day bucket. Derivation is a pure
function `scene.scene_for(now: datetime) -> str`; the Director supplies the real
local clock, so the bucketing is unit-testable without `datetime.now()`.

---

## 3. Design

### 3.1 Music-pick prefetch (slice 1)
A **single-slot** prefetch buffer in the Director holds an in-flight (or
finished) `next_track` task:

- **Fire:** once a talk segment's text exists (so `MusicContext.situation` has
  real mood), if music is wired and the slot is empty, start
  `asyncio.create_task(music.next_track(ctx))` and park it in the slot. The talk
  segment then airs as normal — the pick resolves in the background.
- **Consume:** when the music branch fires, the slot must hold a **resolved**
  pick to air a song. If it holds a task that is *already done*, `await` it
  (near-instant) instead of a cold `next_track`, clear the slot, and air the
  song; the next talk segment refills it. So the Director always runs **one pick
  ahead**.
- **Never block on a resolving pick (dead-air fix):** if the slot holds a task
  that is **still in flight** when music is due, the branch does **not** await it
  — it returns to talk and airs a buffered look-ahead beat, then re-attempts
  music at the next boundary. The in-flight pick keeps resolving in the
  background (the slot is *not* cleared, so no duplicate prefetch fires), and the
  depth-2 talk look-ahead (§3.3) covers the search **adaptively** — however long
  the resolve takes — with no dead air and no hardcoded "talk for N" duration.
  (Observed live before this fix: a long-playlist resolve blocked the music
  branch ~56s — `music.pick prefetched=True elapsed_s=56.52` — while a warm talk
  beat sat buffered.)
- **Cold fallback:** if the slot is empty when the music branch fires (e.g. the
  very first segment, or a pick just consumed), do a cold `next_track` exactly as
  before — correctness never depends on the buffer being warm.
- **Staleness (accepted):** the pick is chosen on the mood at *fire* time and may
  air a segment or two later. Songs are long and background; a slightly older
  mood is an acceptable trade for hiding the latency. Not invalidated by a steer
  (unlike a talk look-ahead) — a background song is low-stakes.
- **Shutdown:** an in-flight prefetch is cancelled + awaited (settled) on Director
  exit, so no orphaned task outlives the loop.

### 3.2 Talk look-ahead (slice 2)
**Brain gains `next_talks(ctx, count=2) -> list[str]`** (additive; `next_talk` /
`respond` unchanged). One call returns `count` consecutive beats:
- **StubBrain** returns `count` canned beats; **FakeBrain** (tests) returns
  `count` deterministic beats.
- **ClaudeBrain** issues one `query` on the same isolated path as `next_talk`
  (spec 01 §3.2). The SDK's plain `query` has **no output-schema** (its JSON-schema
  support is only for *tool* inputs), so — as with music discovery (spec 03-01) —
  the batch shape is fixed by a single **terminal harness tool**
  (`emit_talk_beats`, in `talk_tools.py`): the model returns its beats by *calling*
  the tool, and the SDK delivers the call as a parsed `args` mapping, so there is
  no free-text JSON to scrape. The wire shape is defined once (the tool's
  `input_schema`) and trusted once (`parse_talk_beats`, the consumer). It
  **degrades gracefully**: if the model never called the tool, the result wasn't a
  success, or the shape drifted, `parse_talk_beats` returns empty and the Brain
  falls back to a single `next_talk` beat — so a bad batch costs the look-ahead
  that round but never the segment. (The parser + tool are unit-tested; whether the
  model reliably fills a clean N-item array is an eval-track concern, not a unit
  assertion — DESIGN §10.3.)

The Director keeps a **depth-`N` look-ahead buffer** (`N` = `_TALK_LOOKAHEAD`,
default **2**) of pre-synthesized beats, kept **topped up to `N`** like the music
slot (§3.1). Held at `N` — not drained-then-refilled — the next talk is always
ready, including across intervening music.
- **Consume:** a talk segment pops the front beat and airs it — **no Brain call,
  no synthesis** on the critical path (the inter-segment latency is gone).
- **Refill (`_prefetch_talk`):** fire-and-forget, at most one in flight (mirrors
  `_prefetch_music`). When the buffer is **below `N`**, one batched
  `next_talks(need)` for the shortfall, its beats synthesized **in parallel** (each
  an independent synth task), appended (capped at `N`). Fired after a consumed beat
  is recorded **and at the start of a music segment**, so the buffer stays full and
  the refill's Brain+synth overlap whatever is on air (the post-song talk airs
  warm). **Coherence:** the refill passes the queued-but-unaired beats into the
  context as prior `radio` turns — the buffered text lives in the Director, so the
  stateless Brain is told what is *already queued*, not only what has aired and
  been recorded, and continues the monologue instead of duplicating it.
- **Cold fallback:** an empty buffer (first-ever segment, or a post-steer regen)
  does a `next_talks(N)` inline, airs beat 1, buffers the rest — correctness never
  depends on a warm buffer.
- **Survives music (design change from the single-slot slice-2):** a song no
  longer **discards** the buffer. A song is the ideal window to *prepare* the next
  talk, not a reason to drop it. This is what removes the music→talk dead air.
- **Resilience:** the refill's `next_talks` and each synth **retry** (bounded,
  `_LOOKAHEAD_ATTEMPTS`) before degrading — a failed batch loses the look-ahead
  that round, a failed synth loses that one beat, never the radio. Every important
  stage (refill fired, batch size, retries, failures) is logged to the dev log.

A typed line (`Steer`, talkback) **discards** the buffer + cancels an in-flight
refill: the buffered beats were generated before the user turn, so they are stale
(spec 01 §3.3 rule) — dropped, and the next segment regenerates fresh. The buffer
and any in-flight refill are also settled on shutdown. `N` is a module constant,
not a config knob — deepen only if measurement shows a remaining gap (§6).

### 3.4 Time-of-day scene (context enrichment)
Adjacent to the latency work above; it rides in this spec (see the header note).
The radio was permanently "night" because the persona seed was night-flavored;
this makes the host speak to the actual local time.

- **Derivation (pure, unit-tested):** `scene.scene_for(now)` maps a local
  `datetime` to a coarse bucket by hour — **morning** 05:00–11:59, **afternoon**
  12:00–17:59, **evening** 18:00–22:59, **late-night** 23:00–04:59 (wraps past
  midnight). Clock-free: the caller passes the `datetime`, so the boundaries are
  pinned in tests with injected values (never `datetime.now()`).
- **Population:** the Director calls `scene.current_scene(datetime.now())` where it
  builds the `ContextPack` (`_context`), so every Brain call this turn carries the
  current scene. The real wall clock lives in the Director; `scene_for` is the pure
  tested seam that `current_scene` wraps.
- **Override (by-ear / testing):** `MURMUR_SCENE=morning|afternoon|evening|late-night`
  forces the scene regardless of the clock, so a scene can be auditioned without
  waiting for the hour. Handled in `current_scene`; an empty/unset value derives
  from the clock, a non-empty invalid value warns and degrades to the clock (a typo
  never breaks the radio — same posture as the `Config` env knobs).
- **Prompt:** the self-initiated talk builders (`build_next_talk_prompt`,
  `build_next_talks_prompt`) append a short per-scene mood cue keyed by
  `ctx.scene`. A `None` or unmapped scene appends nothing (degrades silently).
  English scaffolding as always — the persona still produces Chinese.
- **Persona seed:** generalized from its hard "late-night" framing to be
  time-neutral, so the per-scene cue (not a night-locked seed) sets the mood.
- **Stochastic quality is eval-track:** *that the scene reaches the prompt* is a
  deterministic unit assertion; *whether the host's phrasing actually reads as
  morning vs. late-night* is a by-ear / eval concern (DESIGN §10.3), not a unit
  assertion on model text.

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
4. **slice 1 (no-block / dead-air):** when music is due but the prefetched pick is
   still in flight (not done), the loop does **not** await it — it airs a buffered
   talk beat and re-attempts music at the next boundary; the pick keeps resolving
   in the background. Verified on fakes: with a pick that never resolves, the run
   completes on talk alone (music never airs, the loop never blocks); pre-fix the
   music branch awaited the pick and the run hung.
5. **slice 2:** a buffered beat airs with **no** Brain call and **no** synthesis on
   its critical path (verified on fakes: the next segment plays without a fresh
   `next_talks` / `synthesize`); a talkback `Steer` discards the buffer;
   `parse_talk_beats` degrades a malformed / missing tool result to empty, and the
   Brain falls back to a single beat.
6. **slice 2 (survives music):** a talk beat buffered before a music segment airs
   **after** the song (not regenerated cold at the music→talk boundary) — the
   music→talk transition has no Brain/synth wait. Verified on fakes: with a song
   between two talks, the pre-buffered beat is the one that airs post-song.
7. **slice 2 (depth 2):** the buffer is held at depth `N` (not drained-then-
   refilled) — a beat buffered before **two** consecutive music segments still airs
   after them, and each post-song talk airs a warm buffered beat.
8. **slice 2 (coherent refill):** a top-up refill fires with the queued-but-unaired
   beat in its context (as a prior `radio` turn), so it continues the monologue
   rather than duplicating the buffered beat. Verified on fakes: the refill's
   `next_talks` context contains the queued beat's text.
9. **slice 2 (resilience):** a transient `next_talks` failure and a transient
   synth failure are retried (the look-ahead still fills / the beat still airs);
   exhausted retries degrade (look-ahead skipped / beat skipped) without crashing
   the loop.
10. **§3.4 (scene bucketing):** `scene_for` maps each hour to the right bucket,
    with the boundary hours (05:00, 12:00, 18:00, 23:00) and the midnight wrap
    pinned. Verified with an **injected** clock (fixed `datetime` values), never
    `datetime.now()`.
11. **§3.4 (prompt assembly):** a set `ctx.scene` threads its mood cue into the
    self-initiated talk prompts; a `None` / unmapped scene appends nothing.
    Verified on the prompt strings (deterministic). The host's actual time-of-day
    voice is an eval / by-ear item, not a unit assertion.
12. **§3.4 (scene override):** a valid `MURMUR_SCENE` wins over the clock; an
    empty/unset value derives from the clock; a non-empty invalid value degrades
    to the clock (never raises). Verified with a fixed clock whose derived bucket
    differs from the override, so the env is proven to win.

---

## 6. Open questions
- **Buffer depth:** single-slot (one pick / one segment ahead) vs N-deep. Slice 1
  starts single-slot; deepen only if measurement shows a remaining gap.
- **Continuous vs cold-start-only prefetch:** slice 1 prefetches continuously
  (one pick ahead, every music cycle); if the mood-staleness ever reads wrong,
  restrict to the first cold-start pick.
- **Mood-staleness tolerance** for a prefetched pick (how far ahead is too far).
- **§3.4 scene granularity / boundaries:** 4 buckets with fixed hour cuts is a
  by-ear start; the boundaries and the per-scene cue wording are tunable, and the
  proper home is the future spec-07 time/activity context (this is an early slice).
