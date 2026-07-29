# spec/07 · proactive-and-pacing — turning to you, time anchors, activity pacing

> **Status**: **Design. Not yet implemented.**
> **Part**: The companion character of the program: the model-C **"turn to you /
> slide back"** degree (master [`../DESIGN.md`](../DESIGN.md) §2.2), **time
> anchors** via the Scheduler (§2.1 ⏰), **activity-aware pacing** via the
> ActivitySensor (§4), and — **absorbed 2026-07-29 from the dissolved spec 08
> (pillar 5)** — **activity-gated generation** (§7). Gating landed here because
> it *is* a pacing policy and cannot exist without this spec's activity signal.
> **Milestone**: companion character. Depends on specs 01 and 05 (both landed).
> **Privacy boundary (master §3.1)**: the activity signal is **local and
> coarse** — idle seconds, never keystroke content, never a log of what you were
> doing. It reaches the network only as a one-word cue inside the existing Brain
> prompt. No third hop; nothing new is written to disk except one anchor event
> per anchor in the spec-05 ledger.
> **Conventions**: English; written for a coding agent. Design-level — mechanism
> and contracts, not final code. Prompt text centralized in `src/prompts.ts`; no
> CJK in source (master §0).

---

## 1. Goal & scope

### Delivers

1. **The proactive degree (model C).** A **Director-local** policy for when the
   radio turns to the listener and asks something, how it recognizes engagement,
   and **how it slides back** into the program when nobody answers — with no
   pressure and no repeated poking.
2. **Time anchors (Scheduler).** Good-morning / midday / good-night as **fixed
   programming layered on the stream**: each fires once per day inside its
   window, at the next segment boundary, and survives a restart without
   re-firing.
3. **ActivitySensor.** A seam that answers "is the listener around?" from
   **local idle time**, with a v1 implementation that needs no permissions, and
   a shape that lets richer signals plug in later without touching consumers.
4. **Activity-aware pacing + activity-gated generation.** When you are away:
   longer gaps, more music/bed, and **talk generation pauses** — the radio keeps
   playing but stops spending tokens on an empty room (master §7 pillar 5). When
   you come back, it resumes immediately.

### Out of scope (explicit non-goals)

- **ASR / voice input** (master §3.4). Engagement is measured from typed lines.
- **OS-wide input monitoring that needs accessibility permissions, keylogging,
  or any capture of *what* was typed.** The sensor sees timestamps and idle
  seconds only (§3.1).
- **Mining Claude Code logs for activity** — considered and **cut** (master §10
  row 09): a local idle probe is cheaper, more accurate, and has no privacy
  cost.
- **Budget caps / graceful degradation near a quota** — deferred backlog
  (master §7 pillar 7); gating here is about presence, not spend limits.
- **New front-end surface.** Anchors and invites are ordinary segments; the Host
  seam is unchanged (a TUI status badge is spec 10's business).
- **Notifications, alerts, or anything that leaves the terminal.**
- **Persona/profile change.** Anchors and invites are content the existing
  persona speaks; nothing here writes `persona.md` (master §2.3 amended) and
  nothing here rewrites the profile (spec 05/06 own that).

---

## 2. Contracts / seams

### 2.1 `ActivitySensor` — the presence seam

```ts
// Coarse presence, derived from idle time. Three states are enough to drive
// every policy below; more states would be knobs nobody can tune by ear.
export type Activity = 'engaged' | 'present' | 'away'

export interface ActivitySensor {
  // Pure given the sensor's recorded state: the caller supplies the clock, so
  // every threshold is unit-testable without wall-clock waits.
  state(now: Date): Activity
  // Milliseconds since the last observed sign of life; null = never observed.
  idleMs(now: Date): number | null
  // The Host calls this on every typed line (the always-available signal).
  noteInput(at: Date): void
}
```

- **Thresholds** (module constants, by-ear tunable — spec 04 §3.3 precedent):
  `ENGAGED_MS = 5 min`, `PRESENT_MS = 30 min`; beyond `PRESENT_MS` → `away`.
  Never observed (a fresh session where nobody has typed) → **`present`**, not
  `away`: a cold start must not open in the quiet mode.
- **v1 implementation** — `IdleSensor`: the most recent of (a) the last typed
  line into murmur, and (b) an **optional OS idle probe**, taken at segment
  boundaries only (never a timer). On macOS the probe is
  `ioreg -c IOHIDSystem` `HIDIdleTime` — a plain subprocess read, no
  entitlements, no content. If the probe is missing, fails, or is slow, the
  sensor **degrades silently to murmur's own input recency**; the radio never
  waits on it.
- **Extension shape**: consumers depend on `ActivitySensor`, never on the probe.
  A richer signal later (editor activity, a Claude Code heartbeat, a desk
  presence sensor) is a new implementation or a `max()` composite behind this
  same interface — no consumer changes. This is the "design the seam so richer
  signals plug in later" requirement, satisfied by keeping the interface at
  *presence*, not at *sources*.

### 2.2 `ContextPack.activity` — the field spec 05 reserved

Spec 05 §2.2 reserved `activity` for this spec. It lands as an optional field,
exactly like `scene`:

```ts
readonly activity?: Activity   // absent = render nothing (degrade silently)
```

The Director fills it in `context()` from the sensor, next to `currentScene()`.
Prompt rendering appends a short cue (`src/prompts.ts`), and the cue is written
so the host **adjusts its manner, never narrates the surveillance** — no "you
seem to be away"; more like "the room is quiet, keep it low and unhurried". A
`null`/unmapped value appends nothing.

### 2.3 `Scheduler` — time anchors

```ts
export type AnchorId = 'morning' | 'midday' | 'night'

export interface Scheduler {
  // The anchor due right now, or null. Pure given the fired-history it was
  // constructed with plus `now` — the Director supplies the clock.
  due(now: Date): AnchorId | null
  // Record that an anchor aired (persisted via the ledger, §2.4).
  markFired(id: AnchorId, now: Date): void
}

// The identity of one occurrence of an anchor. NOT the calendar date it aired
// on — the local date its window OPENED (§2.3 "anchor day"), so a wrapping
// window is one occurrence across midnight.
export function anchorDay(id: AnchorId, now: Date): string   // "YYYY-MM-DD"
```

- **Windows** (module constants): `morning` 06:00–10:00, `midday` 11:30–14:00,
  `night` 22:00–01:00 (wraps past midnight, like `scene_for`). Reuse
  `scene.ts`'s bucketing style — pure function, injected clock, unit-pinned
  boundaries.
- **Fire-once semantics**: an anchor fires at the **first segment boundary
  inside its window** and at most once per **anchor day** — *not* per calendar
  day. A window missed entirely (radio off) is **dropped, never replayed** — a
  good-morning at 15:00 is worse than none.
- **Anchor day (the midnight rule — a wrapping window is ONE occurrence).**
  `night` runs 22:00–01:00, so a single night window straddles two calendar
  dates; keying an occurrence by the date it aired on would let 23:10 fire
  `night` and 00:30 fire it *again* eighty minutes later, both "once per
  calendar day" by the letter. The occurrence is therefore keyed by the local
  date on which its window **opened**:

  ```
  anchorDay(id, now):
    (startHour, endHour) = WINDOW[id]
    wraps = startHour > endHour                       # night: 22 > 1
    if wraps and localHour(now) < endHour:            # inside the post-midnight tail
        return localDate(now - 1 day)                 # belongs to yesterday's window
    return localDate(now)
  ```

  Non-wrapping anchors (`morning`, `midday`) are unaffected — `anchorDay` is
  their local date. For `night`: 23:10 on the 3rd and 00:30 on the 4th both
  yield `2026-07-03`, so the second boundary sees the occurrence already fired
  and airs nothing. The next `night` occurrence is `2026-07-04`, opening at
  22:00 that evening. `anchorDay` is a **pure function of `(id, now)`** — the
  same clock-injected, boundary-pinned shape as `scene_for` (spec 04 §3.4), and
  it is the *only* place the wrap is reasoned about: `due()` and `markFired()`
  both go through it, so the read and the write can never disagree.
- Anchors are checked **before** cadence at each boundary, so an anchor always
  wins the boundary it is due at.

### 2.4 Anchor persistence — one additive ledger read

The fired-history must survive a restart (relaunching at 09:30 must not re-fire
good-morning), so it lives in the spec-05 tier-③ ledger rather than in Director
memory:

- `LedgerKind` (spec 05 §2.1, `src/contracts.ts`) gains `'anchor'`; the key is
  `"<id>@<anchorDay(id, now)>"` — the **window-opening** local date (§2.3), not
  the date the beat aired — written by `recordEvent` at air time. Using the air
  date here would reintroduce the midnight double-fire at the storage layer even
  with a correct `due()`, so the same helper produces both sides of the check.
- `MemoryStore` gains one additive read: `recentAnchors(n: number): string[]`
  (last n anchor keys, most-recent-last) — mirroring `recentSongs`. Both stores
  implement it; the in-process store keeps the same in-memory shape.
- *Rejected alternative*: Director-only in-process state. It re-fires anchors on
  every restart, and restarts are frequent during development and after a
  crash — the exact case where a duplicated "good morning" is most jarring.

### 2.5 Cadence + pacing integration (no new scheduling machinery)

`CadenceState` (`src/cadence.ts`) already documents "later specs extend it
(pacing in 07)". This spec adds the field and one decorator:

```ts
export type CadenceState = {
  readonly talksSinceMusic: number
  readonly situation?: string
  readonly activity?: Activity     // added here
}

// Wraps the configured policy (every_n | random | brain) instead of replacing
// it: presence policy composes with whatever cadence the user chose.
export class PacingCadence implements CadencePolicy {
  constructor(inner: CadencePolicy) {}
  nextKind(state: CadenceState): Promise<SegmentKind>
}
```

`PacingCadence` short-circuits to `'music'` when `state.activity === 'away'`
(and only then); otherwise it delegates. Because it short-circuits **before**
delegating, an `away` room also skips the opt-in `brain` cadence call — gating
saves that token too.

### 2.6 Invite marking — one optional field on the existing batch tool

The "turn to you" beat needs no new call. The spec-04 `emit_talk_beats` tool
schema gains an **optional** per-beat `invite?: boolean`, exactly as spec 05
§3.9 added `topic`:

```ts
export type TalkBeat = {
  readonly text: string
  readonly topic?: string
  readonly invite?: boolean   // this beat ends by turning to the listener
}
```

The Director asks for an invite by rendering a cue into the batch prompt; the
model marks which beat carries it. Zero extra calls, zero hardcoded copy
(master §7 pillars 1–2). A model that ignores the field simply produces a normal
beat — the policy degrades to "no invite this round", never to a broken segment.

---

## 3. Design

### 3.1 Sensing presence (local, coarse, cheap)

- Every typed line already flows through the Host into the Director; the Host
  stamps `sensor.noteInput(new Date())` as it queues the line. That alone gives
  a usable signal with zero new dependencies.
- The optional OS idle probe runs **at segment boundaries** (a few times a
  minute at most), with a short timeout, and its result is cached until the next
  boundary. No polling loop, no timer, nothing on the audio path.
- Only two numbers ever exist: "when did we last see life" and "how long ago is
  that". No content, no history, nothing persisted.

### 3.2 Pacing when nobody is around

At each boundary the Director reads `state(now)` once and uses it three ways:

| Activity | Gap | Segment mix | Talk generation |
|---|---|---|---|
| `engaged` | `gapSeconds` (config) | cadence as configured | normal look-ahead depth |
| `present` | `gapSeconds` | cadence as configured | normal |
| `away` | `gapSeconds × AWAY_GAP_FACTOR` (~3) | **music/bed only** (`PacingCadence`) | **paused** (§3.3) |

The dead-air law still holds in `away`: the stream keeps playing (music, or the
spec-03-04 bed when music is unavailable). "Quiet" means *no new talk*, never
*silence*.

### 3.3 Activity-gated generation (absorbed master §7 pillar 5)

Gating is one rule applied at the two places talk work is started:

- **`prefetchTalk()` (spec 04 §3.3) returns immediately when `away`.** No
  batched `nextTalks`, no parallel synthesis — the two most expensive things the
  radio does. Buffered beats are **kept**, not discarded: they are not stale
  (no user turn intervened), and they are exactly what should air the moment the
  listener returns.
- **The talk branch, when the buffer is empty and `away`, does not run the cold
  inline batch** — it yields to music/bed for that boundary.
- **Resume is immediate and needs no new trigger**: a typed line moves the state
  to `engaged` and takes the existing talkback path, which already refills the
  look-ahead right after the reply airs (spec 04 §3.3, post-steer refill). An OS
  probe that sees fresh input has the same effect at the next boundary.
- **An anchor overrides gating**: a due good-morning fires even after an away
  night — the anchor is precisely the "welcome back" moment. This is the one
  sanctioned Brain call in the away state.

### 3.4 Time anchors on the stream

1. At each boundary, before cadence: `scheduler.due(now)`.
2. If an anchor is due, the segment is an **anchor talk segment**: one
   `nextTalks(ctx, 1)` whose prompt carries an anchor cue (`src/prompts.ts`,
   per-anchor wording), aired like any talk beat.
3. Record it in history as usual, `recordEvent('anchor', "<id>@<date>")` at air
   time (aired, not merely intended — the same rule the music ledger follows).
4. The look-ahead buffer is **untouched**: the anchor is inserted ahead of it,
   and the buffered beat airs at the following boundary. No discard, no refill
   churn (the buffered beat predates nothing the listener did).
5. Anchor copy is **model-written**, not templated: it must speak in persona and
   reference the actual day (profile, recent topics, scene). The cost is three
   single-beat calls a day — negligible against the pillar-2 batch savings.

### 3.5 Turning to you, and sliding back

**Local policy decides *whether*; the model writes *what*.**

- **Eligibility (0 tokens, all local):** an invite may be requested when
  ① `activity !== 'away'`, ② at least `INVITE_EVERY_N` (~4) segments have aired
  since the last invite, ③ no invite is currently outstanding, ④ the listener
  has not typed in the last segment (they are already engaged — asking is
  redundant). When eligible, the batch prompt carries the invite cue; the model
  marks one beat `invite: true`.
- **Outstanding window**: after an invite beat airs, the Director holds
  `awaitingReply` for `INVITE_WINDOW` (~2 segments **or** ~90 s, whichever comes
  first — a song can outlast two segments).
- **If the listener answers** inside the window: nothing new happens — the
  existing prepare-then-barge-in talkback path (spec 01 §3.3) handles it. The
  window clears. This is what "if you engage, you chat for a bit" already means
  mechanically.
- **If nobody answers**: the window expires, `awaitingReply` clears, and the
  next batch prompt carries a short **slide-back cue** — move on gracefully,
  do not repeat the question, do not comment on the silence. That cue is the
  entire "slides back into the program" mechanism; there is no state machine
  beyond one flag and one deadline.
- **Escalation is forbidden by design**: a missed invite never triggers a second
  one sooner; the `INVITE_EVERY_N` counter restarts from the invite that aired.
  Pressure-free companionship (master §2.2) is a property of *not* having a
  retry path.

### 3.6 Local policy (0 tokens) vs brain-involved — explicit ledger

Per master §7 pillar 1, every decision here is classified:

| Decision | Where | Cost |
|---|---|---|
| Is the listener engaged / present / away | `ActivitySensor` (local, optional subprocess probe) | 0 tokens |
| Is an anchor due; which one | `Scheduler` (pure clock + ledger) | 0 tokens |
| Talk vs music at this boundary | `PacingCadence` over the configured policy | 0 tokens (unless the user opted into `cadence=brain`, spec 03-02) |
| Gap length; whether to generate at all | Director + sensor state | 0 tokens (and it *saves* tokens) |
| Whether an invite is allowed now; when it expires | Director-local counters + deadline | 0 tokens |
| **The words** of a talk beat, an invite, an anchor | Brain (`nextTalks`, existing calls) | inside the existing batch; anchors add 3 single-beat calls/day |
| The reply when the listener answers | Brain (`respond`, spec 01) | unchanged |

Nothing in this spec adds a per-boundary model call. The only new Brain traffic
is three anchor beats a day, and gating *removes* traffic.

### 3.7 Config knobs and constants

Following spec 04's posture — **behavioral shape as module constants** (tunable
by ear in one place), **on/off as config**:

```
Config (new):
  anchorsEnabled: boolean   default true    (--no-anchors)
  invitesEnabled: boolean   default true    (--no-invites)
  gatingEnabled:  boolean   default true    (--no-gating)

Module constants (src/activity.ts, src/scheduler.ts, src/director.ts):
  ENGAGED_MS, PRESENT_MS, AWAY_GAP_FACTOR, INVITE_EVERY_N, INVITE_WINDOW,
  anchor windows
```

An override for by-ear work mirrors `MURMUR_SCENE` (spec 04 §3.4):
`MURMUR_ACTIVITY=engaged|present|away` forces the state; an invalid value warns
and degrades to the real sensor.

### 3.8 Failure posture

Every new component is **total**: a probe failure, a scheduler error, or a
sensor with no observations degrades to today's behavior (normal pacing, no
anchor, no invite) with at most one dev-log line. None of them can stall a
boundary — the boundary never awaits anything that is not already bounded.

### 3.9 Interaction with the spec-04 look-ahead (stated, because it is subtle)

- An **anchor** inserts ahead of the buffer; the buffer survives.
- An **invite** is a normal buffered beat that happens to be marked — it is
  generated by the same refill, so it is *pre-synthesized* like any other beat.
  Consequence to accept: an invite is decided a beat or two before it airs, so
  it can land just after the listener typed. The `awaitingReply` window makes
  that harmless (an answered invite is indistinguishable from normal talkback),
  and the eligibility check is re-evaluated at request time, not at air time.
- **Gating** pauses refills but never discards the buffer (§3.3).
- A **steer** still discards the buffer (spec 04 §3.3) and clears any
  outstanding invite window — the listener took the floor.

---

## 4. Dependencies

- **spec 01** — the Director loop, the `gapSeconds` pacing, the `Host` input
  path (which stamps the sensor), and `ContextPack` (gains `activity`).
- **spec 05** — the ledger (anchor persistence, `LedgerKind` extended,
  `recentAnchors` added), the `activity` pack field it reserved (§2.2), and the
  profile/topic context anchors and invites speak from.
- **spec 03-02** — the `CadencePolicy` seam that `PacingCadence` wraps; the
  music branch and the 03-04 bed are what fill an `away` stream.
- **spec 04** — the look-ahead this spec gates and inserts around (§3.9).
- **Independent of spec 06**: no shared contract. Either may be built first.

---

## 5. Acceptance criteria (feature level)

Unit (fakes, **injected clock and injected sensor** — never wall-clock waits)
unless noted.

1. **Sensor thresholds**: idle < `ENGAGED_MS` → `engaged`; between → `present`;
   beyond `PRESENT_MS` → `away`; never-observed → `present`. Boundaries pinned
   with fixed `Date` values.
2. **Sensor degradation**: a probe that throws, hangs past its timeout, or is
   absent leaves the sensor working on murmur's own input recency; no boundary
   is delayed (assert the boundary completes with a hanging probe).
3. **Pack field**: `activity` reaches the `ContextPack` and renders its cue in
   the talk prompts; an absent/unknown value renders nothing (deterministic
   string assertions, spec 04 §3.4 pattern).
4. **Pacing**: in `away` the inter-segment gap is `gapSeconds ×
   AWAY_GAP_FACTOR`; in `engaged`/`present` it is unchanged.
5. **Gating (the pillar-5 criterion)**: with the sensor forced `away`, a run
   over fakes makes **zero** `nextTalks` calls and **zero** `synthesize` calls
   while continuing to air music/bed segments; the pre-existing buffered beats
   are **still present** afterwards.
6. **Resume**: after an `away` stretch, a typed line produces a reply and the
   look-ahead refills — the next boundary airs talk again, with no extra trigger.
7. **Gating composes with cadence**: in `away`, `PacingCadence` returns
   `'music'` without delegating (a fake inner policy records that it was not
   consulted) — including with `cadence=brain`, so no cadence call is made.
8. **Anchor windows + the midnight rule**: `due()` returns each anchor inside
   its window and `null` outside; the boundary hours and the midnight-wrapping
   `night` window are pinned with injected `Date` values; two boundaries inside
   the same window fire the anchor **once**. Specifically pinned for the wrap:
   - `anchorDay('night', 23:10 on the 3rd)` and `anchorDay('night', 00:30 on
     the 4th)` both return `2026-07-03`; `anchorDay('morning', …)` and
     `anchorDay('midday', …)` return the plain local date.
   - **No midnight re-fire**: `night` airs at 23:10 on the 3rd; at 00:30 on the
     4th — still inside the same window, a *new calendar day* — `due()` returns
     `null`. (This is the case a naive per-calendar-day key gets wrong: it would
     air a second good-night eighty minutes after the first.)
   - The occurrence **does** come back: at 22:05 on the 4th, `due()` returns
     `'night'` again.
9. **Anchor persistence**: an anchor recorded in the ledger is not re-fired by a
   **fresh** Scheduler constructed over the same store within the same **anchor
   day** — including a restart at 00:30 that lands in the previous evening's
   `night` window; the next anchor day it fires again.
10. **Anchor beats the buffer**: with a due anchor and a warm look-ahead, the
    anchor airs at that boundary and the buffered beat airs at the next one
    (nothing is discarded or regenerated).
11. **Anchor overrides gating**: with the sensor forced `away` and an anchor
    due, the anchor beat is generated and airs.
12. **Invite eligibility**: no invite before `INVITE_EVERY_N` segments have
    aired since the previous one, none while one is outstanding, none when
    `away`, none right after a user line — verified on the prompt (the invite
    cue is present/absent) rather than on model text.
13. **Slide-back**: an aired invite with no reply inside `INVITE_WINDOW` clears
    the window and puts the slide-back cue into the next batch prompt; **no**
    second invite is requested sooner than the normal interval.
14. **Answered invite**: a line inside the window takes the ordinary talkback
    path (reply airs, program resumes) and clears the window — no special-case
    branch beyond clearing the flag.
15. **Everything is switchable off**: `--no-anchors` / `--no-invites` /
    `--no-gating` restore exactly the pre-spec-07 behavior (the existing spec
    01/03-02/04 suites pass unchanged with them set).
16. **Human acceptance (sensory, user-run — the real gate)**: over a real day,
    does "occasionally turns to you" feel *inviting rather than needy*, does the
    slide-back feel graceful, do the anchors land at the right moments, and does
    walking away make it go quiet without feeling dead? The agent produces the
    checklist; the user judges (master §11.2 layer 3).

---

## 6. Open questions

- **Every constant here is a by-ear guess** — `ENGAGED_MS` / `PRESENT_MS`,
  `AWAY_GAP_FACTOR`, `INVITE_EVERY_N`, `INVITE_WINDOW`, and the three anchor
  windows. They are the tuning surface of the whole spec; expect the first real
  day to move several.
- **Is `present` doing any work?** If nothing ever distinguishes it from
  `engaged`, collapse the state to two. Kept for now because a mid-idle listener
  is the case where an invite is most welcome and a firehose least.
- **Should the invite ever be a *question about the listener's day* vs about the
  topic on air?** A content question, i.e. prompt wording — settle it by ear,
  not by mechanism.
- **OS idle probe portability**: macOS `ioreg` is the v1 path (the dev
  platform). Linux/Windows equivalents can land behind the same seam, or the
  probe can stay macOS-only with the input-recency fallback everywhere else.
- **Anchor catch-up**: dropping a missed window is the chosen posture. If it
  turns out a 10:30 launch *should* still say good morning, widen the window
  rather than adding replay logic.
- **Does the away state deserve a different *music* policy** (quieter bed,
  longer tracks, no DJ announce)? Plausible, unproven — a spec 03-02/03-04
  follow-up if the ear asks for it.
