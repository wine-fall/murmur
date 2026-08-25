# spec/11 · agentic-steer — the reply turn becomes an agent

> **Status**: **Implemented** (2026-08-01). Built: `src/steer-tools.ts` (the
> three tools), `src/steer-responder.ts` (the task builder), the Director's
> switch/handover/two-phase-shutdown wiring, and the app wiring (real brain
> only — a stub run keeps the tool-less path by construction). Unit-verified in
> `test/steer-tools.test.ts` / `test/steer-responder.test.ts` /
> `test/director-steer.test.ts`; real-SDK smoke passed (a switch request calls
> `switch_music` with a hint and covers the wait without naming a track; a mood
> remark calls nothing; an explicit off-request arms and asks, never closes).
> The tool-choice eval (Ollama, §5 Testing) is an owed backlog item. By-ear
> acceptance is open (checklist with the user).
> Motivation, from a live session: a "change the song" turn
> produced a correct reply and a fresh pick in 29s, but the old track played to
> its natural end because nothing can cut it — the reply brain is the one brain
> entry with no tools (`ClaudeBrain.respond`, plain text generation).
> **Part**: extends spec 01 §3.3 (steer/interjection) and rides the spec 03-01
> harness (`Harness.runTask` + finish-callback tools). No new harness machinery.
> **Milestone**: companion feel — the listener's words can *do* things, not just
> be replied to.
> **Conventions**: English; written for a coding agent. Prompt text centralized
> in `src/prompts.ts`; no CJK in source (master §0).

---

## 1. Goal & scope

### Problem

When the listener types during a song, the line becomes a `talkback` Steer and
the reply path is `Brain.respond` — a tool-less one-shot. The Director's own
automation (cadence, anchors, prefetch) is deliberate 0-token local policy
(master §7 pillar 1), but the *user's turn* is already a paid brain call — and
that call has no hands. Consequences observed:

- "Change the song / skip this" cannot cut the current track; the fresh pick sits in
  `pendingPick` until the song ends on its own.
- The reply narrates actions the engine never performed ("found it — playing it for you now"
  aired 9s before `resolve` even started) — the prompt-green-≠-delivered
  failure, surfaced as UX.
- "I'm off to sleep, turn it off for me" cannot end the broadcast; only the `/quit` magic string
  can.

### Delivers

1. **An agentic reply task.** The steer/talkback turn runs through
   `Harness.runTask` with a small murmur-owned tool set, instead of the
   tool-less `respond`. The brain *decides* whether the turn wants an action;
   the Director stops interpreting intent (no keyword paths, no new `Steer`
   variants — `Steer` stays `quit | talkback`).
2. **Three tools** (§2.1): `switch_music` (re-prime the pick and hand the air
   over to the new track once it resolves, optional hint), `end_broadcast`
   (two-phase: confirm first, shut down only on a confirmed follow-up), and
   `submit_reply` (terminal — the spoken reply).
3. **Truthful narration ordering** (§3.2): tool handlers act (or durably
   schedule) before the reply is composed, and their results state exactly what
   happened — the reply follows delivery, never precedes it.

### Out of scope (explicit non-goals)

- **Per-boundary brain decisions.** Talk-vs-music cadence, anchor scheduling,
  invite throttling, activity gating stay local policy (master §7 pillar 1);
  `BrainCadence` remains the one sanctioned opt-in exception. This spec adds
  agency only where a paid call already exists: the user's turn.
- **Music discovery tools in the reply task.** `search_music`/`submit_pick`
  stay owned by the pick task (03-01 §2.3). The reply task controls the
  *program*, it does not pick tracks.
- **Memory tools** (`remember_fact` …): spec 05 compaction already folds the
  transcript offline. Revisit only if compaction measurably misses
  conversational facts.
- **Volume/pacing preference tools**: preferences reach the persona via the
  profile (spec 05); no runtime knob tools.
- **ASR**; multi-step agentic conversations (one bounded task per steer).

---

## 2. Contracts / seams

### 2.1 The steer tools (`src/steer-tools.ts`)

Handed to `runTask` by the steer task builder. All are murmur-owned,
in-process, and validated by zod schemas (03-01 isolation invariants apply
unchanged). Availability is capability-gated: `switch_music` is only in the
set when music is wired (not `--no-music`, not a failed preflight), and
`change_settings` only when a settings store is wired, so the model cannot
call what the program cannot do.

- `switch_music(hint?: string) -> {ok, status}` — the listener wants different
  music. Handler, synchronously in the tool call:
  1. Discards a **stale** `pendingPick` (one primed before this user turn) when
     a `hint` is present — a specific request must not air a pre-request pick.
     The abandoned promise keeps resolving unobserved (same posture as
     `BrainCadence`'s abandoned task).
  2. Primes a fresh pick whose situation carries the user turn (and the hint —
     it rides the situation block, no new context field).
  3. Marks the **switch due**. The current track is NOT cut here and not at
     reply time either: it keeps playing (ducked under the reply, exactly the
     current interjection behavior). The handover happens when the fresh pick
     *resolves* (§2.3) — the listener is never dropped into silence while the
     pick is still searching.
  Result truthfully reports state: `{ok: true, status: "switching; the current
  track keeps playing while the next one is picked — tell the listener you're
  on it, ask them to hang on, and do NOT name or promise a specific song"}` or
  `{ok: true, status: "no track playing; a pick is being prepared"}`. Never an
  error for "nothing playing" — the brain adjusts its reply, the task goes on.
- `end_broadcast() -> {ok, status}` — orderly shutdown, **two-phase by
  construction — the first call can never close the radio**:
  - **Call while unarmed** (the normal first ask): the handler only *arms*
    shutdown and returns `{ok: true, status: "not closing yet — ask the
    listener to confirm they want the radio off; a later confirmed turn closes
    it"}`. The reply asks for confirmation. No quit flag is touched.
  - **Call while armed** (a subsequent steer task, after the listener
    confirmed): sets the quit flag; the terminal reply becomes the sign-off
    line, aired before the same clean shutdown `/quit` performs (spec 01 §3.6).
  - **Disarm**: if the next steer task completes without calling
    `end_broadcast` (the listener said no / changed the subject), the armed
    flag clears. The brain's prompt pins the semantics: call it on an explicit
    stop request, and call it *again* only when the listener has confirmed.
- `change_settings(...) -> {ok, status}` — the listener asked to change how the
  radio behaves (added 2026-08-25; spec 12 §2.6 is the contract). This is the
  conversational half of the two equal ways into the settings layer: the
  handler calls the **same** `SettingsStore.set` the `/settings` pane's
  keypress reaches, so the pane and the conversation can never drift.
  - **Intent, not field names**, mirroring the pane's vocabulary (spec 12 §1):
    `music` on/off, `mix` more-music/balanced/more-talk, `breathingRoom`
    seconds, `sound` on/muted, `anchors` on/off, `pet` on/off, `memorySpan`,
    `language`. Every field optional; a call with none is an error, not a
    no-op, so a confused model is told rather than silently believed.
  - **Only on a real request.** The prompt pins it: a mood remark is not a
    request ("this song is too loud" is not "mute"). Unlike `end_broadcast`
    there is no confirm phase — a settings change is cheap and reversible —
    but inventing one from ambience is the failure mode to guard.
  - **`language` clears on empty**: passing an empty string removes the
    override and returns the host to whatever its persona says (spec 12 §3.9).
  - Result reports what is true **at return time** — the applied values, or
    `{ok: false, error}` when the patch was rejected by the store's validator.
    A rejected patch never reads as applied.
- `submit_reply(text: string) -> {ok}` — **terminal** (calls `finish`). The
  spoken reply: clean spoken text, no markup/labels (same hygiene contract as
  `emit_talk_beats`). Calling this ends the task.

### 2.2 The steer task (`src/steer-responder.ts` or folded into the Director)

Mirrors `MusicProgrammer`: a small builder that renders context and runs the
harnessed task. Shape (TS, illustrative):

```ts
// contracts.ts — callbacks the Director closes over live state (current track,
// pick slot, shutdown arming). Tools never import the Director. `music` is
// absent when music is not wired: that absence gates switch_music out.
type SteerActions = {
  readonly music?: { playing(): boolean; switchTrack(hint?: string): void }
  readonly shutdown: { armed(): boolean; arm(): void; confirm(): void }
}

// The capability the Director consumes (`DirectorDeps.steer`); SteerResponder
// implements it over Harness.runTask. Null = the model never made the terminal
// call (degrade: the caller falls back to the tool-less Brain.respond).
interface SteerBrain {
  respond(userText: string, ctx: ContextPack, actions: SteerActions): Promise<string | null>
}
```

- **Model**: the main tier (the reply is the soul — spec 01). Cost lands only
  when the listener engages: pillar-1 compliant, no new per-boundary calls.
- **maxTurns**: 3 (act → reply, plus one slack turn).
- **Context**: the same `ContextPack` render the tool-less path uses; persona
  stays the cacheable system prompt. When shutdown is armed, the situation
  says so (the model must know it is in the confirm leg).
- **Fallbacks, in order**: model never calls `submit_reply` (or the task
  throws) → one tool-less `Brain.respond` call (the pre-11 path, still on the
  `Brain` interface for the stub and this degrade). That fails → the existing
  "reply failed; back to the program" degrade (spec 01). `StubBrain` never
  runs the agentic path (no `Harness` capability) — `STUB=1` behavior is
  unchanged.

### 2.3 Director wiring (delta to spec 01 §3.3 / 03-02)

- `prepareReply` tries `respondAgentic` when the brain has the `Harness`
  capability, else `Brain.respond` (unchanged signature — the seam addition is
  additive).
- **Handover on resolve** (the switch path, while a track is playing): the old
  track keeps playing — ducked under the reply as today, back up after it —
  until the fresh `pendingPick` resolves. When it resolves (probe already
  confirmed the stream is alive, 03-01 §2.3):
  1. Let a still-airing reply finish (one voice clip at a time — the cut lands
     between clips), then start the new stream. The engine is single-music
     (`playMusic` cuts whatever is live), so the swap is cut-then-start with a
     sub-second gap; real audio is still confirmed via `waitStarted` before
     anything is said about it, and an empty pick never cuts anything.
  2. The new pick's `announce` airs ducked over the new head (the existing
     03-02 announce flow) — this is the only place the new track gets named.
  3. Log the seam: `music.switch due` at marking, `music.switch handover` at
     the swap, `music.switch failed` on an empty/dead pick — the sequence must
     be readable from `.dev/dev.log`.
  A pick that returns `null` clears the switch (log `music.switch failed`);
  the old track simply plays on, and the next boundary behaves normally.
- **Switch with no track playing** (or the old track ends before the pick
  resolves): a one-shot forced-music boundary (a self-clearing flag) makes
  the next boundary a music segment; if the pick is still resolving there, air
  a buffered talk beat and keep the force for the boundary after (bounded: the
  force clears once a track airs or the pick returns null).
- **Confirmed shutdown** reuses the `quit` flow (spec 01 §3.6) after the
  sign-off reply airs. The `/quit` magic string stays the hard, instant
  override — no confirmation leg.

---

## 3. Design

### 3.1 Why tools, not intent parsing

A `skip` Steer variant (keyword/regex or a classifier) would be a second,
parallel intent channel that fights the brain's own reading of the turn, and
every new capability would grow another variant. The agent pattern already in
the codebase (03-01: tools around a `finish` callback) puts the interpretation
where the language understanding already is, at zero extra calls when no
action is wanted — the model simply calls `submit_reply` directly.

### 3.2 Ordering: act, then speak

The failure this spec kills: narration promising what the engine has not done.
Rules, enforceable in review and tests:

1. A tool handler performs (or durably schedules) its effect **before**
   returning; its result string states what is true at return time.
2. The terminal reply is composed **after** all tool results — the brain
   speaks with the results in context. `switch_music`'s result explicitly
   directs the reply: cover the wait ("hang on, I'm on it") and never name the
   next track (it is not resolved yet). The new track announces itself at
   handover via the pick's own `announce` (03-02), after `waitStarted`
   confirms real audio.
3. Continuity beats immediacy: the old track is cut only when the replacement
   is in hand (§2.3 handover-on-resolve) — the listener hears music → reply
   over ducked music → music, never an empty wait. The deferral is
   Director-owned, deterministic, and logged.

### 3.3 Token economy (master §7)

- No new call sites: the steer task replaces the respond call one-for-one.
  Tool schemas add a small constant to the turn; an acting turn costs one
  extra model turn.
- Priming already happened on every user turn (hard-wired `prefetchMusic`);
  `switch_music` re-uses it. The only new spend is the discarded stale pick
  when a hint forces a re-prime — rare, user-initiated, bounded to one.

---

## 4. Dependencies

- **spec 01**: Steer/interjection loop, quit flow. `Steer` type unchanged.
- **spec 03-01**: `Harness.runTask`, finish-callback tool convention, isolation
  invariants.
- **spec 03-02**: `MusicHandle.stop`/`waitStarted`, ducking, pick announce at
  air time, boundary cadence seam (the one-shot force composes with, not
  replaces, the policy).
- **spec 04**: single-slot `pendingPick` prefetch; talk look-ahead is what
  absorbs the ends-before-resolve boundary.

---

## 5. Acceptance criteria

1. **Skip lands, seamlessly.** During a song, a "different music please" turn →
   reply airs ducked over the still-playing track; when the fresh pick
   resolves, the air hands over to the new track (announce over its head); the
   old track never plays to its natural end after a switch, and the listener is
   never left in silence while the pick searches. Verified in unit tests with
   fakes; by ear on the real radio; `.dev/dev.log` shows
   `music.switch due` → the pick stages → `music.switch handover`.
2. **Specific request re-primes.** A turn naming a style/artist discards a
   stale primed pick and primes fresh; the fresh pick's situation contains the
   request. (Unit: fake harness calls `switch_music` with a hint; assert
   discard + re-prime.)
3. **No false promises.** The reply after `switch_music` covers the wait and
   names no concrete track; the only track announcement is the pick's own
   `announce` at handover. (LLM-eval on the prompt + unit on the ordering.)
4. **Shutdown is always confirm-first.** "turn it off for me" → the radio asks to
   confirm, and **does not** close (unit-enforced: an unarmed `end_broadcast`
   call cannot set the quit flag). A confirming follow-up ("yes, close it") → sign-off
   reply, then the same clean shutdown as `/quit` (no orphaned player/engine).
   A non-confirming follow-up disarms. A mood remark ("so sleepy today") triggers
   nothing. `/quit` still closes instantly. (Unit + LLM-eval.)
5. **Degrade survives.** Model never calls `submit_reply` → the tool-less
   respond answer airs (no user-visible failure). A pick that resolves to
   nothing after a switch → the old track plays on, switch cleared, no crash.
   `STUB=1` and `--no-music` runs behave exactly as before (tool set gated /
   agentic path skipped).
6. **Isolation holds.** The steer task's SDK init exposes exactly the steer
   tools, nothing else (03-01 §5.1 posture, same assertion style).

### Testing (master §11)

- **Unit (fast, fakes)**: tool handlers against a fake Director surface
  (switch marks due + discards stale + primes; unarmed end arms without quit,
  armed end quits, no-call disarms; gating removes `switch_music`);
  handover-on-resolve ordering (new confirmed before old cut; null pick clears
  the switch); ends-before-resolve falls back to the forced boundary; degrade
  chain.
- **LLM-in-the-loop (eval)**: does the model call `switch_music` on skip/change-the-song
  turns, `end_broadcast` on explicit stop requests (and again only after a
  confirmation), and neither on plain chat or mood remarks — canned turns,
  assert on tool-call traces, not wording.
- **By ear**: the motivating session's script, on the real radio.

---

## 6. Open questions

- **Handover feel**: hard cut vs a short crossfade at the swap (the engine
  already fades on duck; a ~0.5s fade may be one engine call). By-ear decision.
- **Slow-pick cover**: if a pick runs unusually long (> ~60s), should the radio
  volunteer a second "still looking" line, or is the ducked-music wait enough?
  Decide by ear; no mechanism reserved for it.
- **Repeat-skip pressure**: a listener skipping N times in a row re-primes N
  picks serially. Bounded (one in flight, single-slot), but the avoid-list
  depth (spec 05 `recentSongs`) may need to grow to keep skipped tracks out.
- **Settled (recorded so they are not re-asked)**:
  - New spec (11), not an amendment — new behavior, spans 01/03/04; per the
    house rule bug-fix PRs tag specs, but this is a capability.
  - One `switch_music` tool with optional hint, not separate
    `skip_song`/`queue_music` — one decision for the model, one seam.
  - No `search_music` in the reply task; no memory/preference tools (YAGNI,
    compaction covers it).
  - **Handover on resolve, not cut-at-reply** (user decision 2026-08-01): the
    old track keeps playing under the reply, exactly like today's
    interjection; the cut happens only when the new pick is in hand, via the
    ducking engine. Continuity beats immediacy.
  - **`end_broadcast` is two-phase** (user decision 2026-08-01): the first
    call can only arm + ask; a confirmed second call closes. Never close on
    the first ask. `/quit` stays the instant hard override.
  - Reply task runs on the main model tier; `Steer` gains no new variants.
