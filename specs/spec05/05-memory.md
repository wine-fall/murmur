# spec/05 · memory — persistent three tiers + context-pack assembly

> **Status**: **Built (mechanism-level) 2026-07-21.** All contracts and wiring
> land and the unit suite is green; the real `compact_profile` and `next_talks`
> tool paths were smoke-tested through the SDK. The five design forks (topic
> tagging, persona homing, freshness cutoff, compaction cadence, path
> governance) were resolved with the user — see §6; the by-feel constants
> (`_RECENT_MAX_AGE_H`, `_COMPACT_EVERY_TURNS`, the profile cap) remain tunable.
> **Owed (real-run pass):** the on-demand two-run "run 2 sees run 1's tail +
> compaction produces a plausible profile" smoke (§5.10), and profile/topic
> quality by feel (eval track).
> **Part**: The persistent Memory layer (master [`../DESIGN.md`](../DESIGN.md) §6):
> three tiers — ① **Profile** (long-term: who you are, prefs, the persona living
> asset) · ② **History** (conversation log, recent window) · ③ **Ledger**
> (anti-repeat: topics covered, songs played, broadcast times) — plus
> **context-pack assembly** and **periodic compaction**. Makes the spec-01
> in-process `MemoryStore` persistent, giving cross-session "it gets me".
> **Milestone**: cross-session "gets me" (master §10 row 05). Depends on spec 01.
> **Privacy boundary (master §3.1)**: memory **persistence is on-device** — the
> layer is local files and performs no network I/O of its own. Memory content
> reaches the network only inside the already-sanctioned Claude-inference hop
> (rendered into Brain prompts: the context pack, the compaction call); this
> spec introduces no third hop.
> **Conventions**: English; written for a coding agent. Design-level. No CJK in
> source.

---

## 1. Goal & scope

### Delivers

1. **A persistent `MemoryStore`** (`PersistentMemoryStore`) behind the same
   spec-01 Protocol — local files under a config-pointed `memory_dir`, no DB
   (master §10.1 "local files, no DB in v1"). The radio remembers across
   restarts.
2. **The three tiers** (master §6), each with an explicit on-disk home (§3.1):
   - ① Profile: `profile.md` (natural-language facts about the listener) +
     `persona.md` (the persona living asset's persistent home — see §3.2).
   - ② History: `history.jsonl` (append-only turn log; the recent window is its
     tail).
   - ③ Ledger: `ledger.jsonl` (append-only events: topics covered, songs
     played; every event timestamped, so broadcast times come for free).
3. **Context-pack assembly** — `ContextPack` grows the master-§6 fields
   (`profile`, `covered_topics`; `scene` is **ratified** from spec 04 §3.4 — see
   §2.2) and the Director assembles them from the store per Brain call.
   *Master touch (applied)*: DESIGN §6 formerly worded the pack field as "topics
   already covered **today**"; issue #44 shows anti-repeat must survive the
   midnight boundary, so the field is **recent topics (cross-day)** — DESIGN §6
   was amended to match when this spec landed.
4. **Periodic compaction** — a background, off-the-live-loop Brain call that
   folds un-compacted history into `profile.md`, so the profile improves over
   time and the pack never grows unbounded.
5. **Anti-repeat wiring** — recently played songs feed the music-pick prompt;
   recently covered topics feed the talk prompts. Motivating case:
   [issue #44](https://github.com/wine-fall/murmur/issues/44) — cold boots with
   an empty transcript keep re-picking the same opener imagery. The
   cross-session window prime (§3.4) plus the **cross-day** ledger anti-repeat
   (§3.5) are that issue's durable fix. (Its cheap prompt-nudge stopgap is an
   independent one-line prompts edit, not this spec's scope; the two compose.)

### Out of scope (explicit non-goals)

- **Semantic / vector recall — deferred to v1.5** (master §6). The row format
  (§3.3) keeps `ts` + `session` + full text so embeddings can be added later
  without a data migration; no recall machinery ships here.
- **Persona evolution + onboarding Q&A** — spec 06. This spec only gives the
  persona its persistent, writable home; nothing here rewrites it.
- **The `activity` pack field, ActivitySensor, time anchors, pacing** — spec 07
  (see §2.2 for the exact 05/07 boundary).
- **Prompt caching / tiered models / budget** — spec 08. This spec only keeps
  the pack ordering cache-friendly (§3.5) so 08 lands without reshuffling.
- **Multi-instance concurrency.** One murmur process per `memory_dir` is an
  assumption, not enforced (no lockfile). Documented; revisit if it ever bites.
- **History rotation / GC.** Append-only JSONL at radio scale (short text
  lines) stays trivially small for v1; compaction advances a watermark, it
  never deletes.
- **Encryption at rest.** Local plaintext files, same trust level as the
  persona seed.

### Considered alternatives (researched — recorded so we don't re-litigate)

Third-party memory libraries were surveyed and rejected for v1 — full survey in
[issue #45](https://github.com/wine-fall/murmur/issues/45). Summary: mem0 makes
its **own** LLM calls (bypassing the Brain seam and the master-§3.1
two-network-hops line); Letta is an agent server/runtime, not an embeddable
store; Zep's self-hosted edition is retired; the small local SQLite libraries
(AIngram / agentmem / memoirs) are **retrieval engines** — the half deferred to
v1.5 — and bundle embedding models. The v1 need is ~stdlib-small (§3). For
v1.5 semantic recall, the reserved candidate is a thin **sqlite-vec / FTS5**
adapter over the same JSONL rows, not a framework.

---

## 2. Contracts / seams

### 2.1 `MemoryStore` Protocol — extended, not broken

Spec 01 declared (`contracts.py`): `record(turn)` / `recent(n)`. Those
signatures are untouched. Spec 05 **adds** methods (additive extension is the
sanctioned move — contracts.py header):

| Method | Returns | Tier |
|---|---|---|
| `record(turn: Turn) -> None` | (existing) appends to History | ② |
| `recent(n: int) -> list[Turn]` | (existing) last n turns, oldest-first — now **cross-session** (§3.4) | ② |
| `profile() -> str` | current profile text; `""` when none yet | ① |
| `record_event(kind: str, key: str) -> None` | append a Ledger event; `kind ∈ {"topic", "song"}` | ③ |
| `recent_topics(n: int) -> list[str]` | last n topic keys, oldest-first — **spans sessions/days** (anti-repeat must survive cold boots and the midnight boundary, issue #44) | ③ |
| `recent_songs(n: int) -> list[str]` | last n song keys (`"title — artist"`), most-recent-last | ③ |

Both implementations satisfy the extended Protocol:
- **`PersistentMemoryStore`** (new, `memory.py`) — the file-backed real store.
- **`InProcessMemoryStore`** (existing) — extended with in-memory dict/list
  equivalents; it remains the unit-layer fake (DESIGN §11.1), and stays the
  store for **stub runs** (§3.7).

Compaction is deliberately **not** on the Protocol — the Director never drives
it. The persistent store exposes it as impl-level surface (§3.6):
`compaction_due() -> bool`; `compaction_slice() -> (profile, turns,
through_ts)` where `through_ts` is the slice's last row timestamp;
`apply_compaction(new_profile: str, through_ts: float) -> None`. The watermark
travels **with the slice**: the fold runs in the background while `record()`
keeps appending, so apply must advance `meta.json` exactly to the
`through_ts` it was handed — never "the latest row" — leaving turns recorded
during the fold in the next backlog.

### 2.2 `ContextPack` — spec 05 owns the assembly contract

`ContextPack` (spec 01 §2.1) after this spec (all additions optional-with-
default, so every existing call site and fake keeps working):

```
persona: str                      # spec 01 (unchanged)
recent: list[Turn]                # spec 01 (unchanged)
scene: str | None = None          # spec 04 §3.4 — RATIFIED here, see below
profile: str = ""                 # spec 05, tier ① — "" = no profile yet
covered_topics: tuple[str, ...] = ()  # spec 05, tier ③ — recent topic keys
                                      # (cross-day; tuple: an immutable default,
                                      # valid on the frozen dataclass)
# activity: spec 07 adds (NOT this spec)
```

**Reconciliation with the time-of-day scene (spec 04 §3.4 — landed, PR #39,
`MURMUR_SCENE` override #43).** That work shipped the "current time" element
of the master-§6 pack on `ContextPack`: an optional `scene: str | None`
bucket, derived by the pure seam `scene.scene_for(now: datetime) -> str` with
the real clock supplied by the Director at `_context()` time. **This spec
ratifies that contract as-is** — field name, bucket values
(`morning/afternoon/evening/late-night`), `None` default, pure-derivation seam
— as the canonical time field of the context pack. Spec 05 builds **no second
time mechanism**; spec 04 §3.4 is the implementation of this contract's time
slice, landed early.
*Companion edit (rides in this spec's PR):* spec 04's "the proper home is the
future spec-07 time/activity context" note is redirected — the
**field/assembly** home is **this spec** (now ratified); spec 07 remains the
home only for time-driven *behavior*.

**The 05 / 07 boundary (so it never blurs):**
- **Spec 05 (this spec)** owns the memory tiers, the `ContextPack` fields
  sourced from them (`profile`, `covered_topics`), the ratified `scene` field,
  and pack assembly — i.e. *what the Brain is told*.
- **Spec 07** owns time **anchors** (Scheduler: morning/night segments),
  **activity pacing** (ActivitySensor → talk density), the proactive
  "turn-to-you" degree, and adds the `activity` pack field when the sensor
  exists — i.e. *what the Director does about it*.

### 2.3 Path governance + config

Local storage today is scattered (audited 2026-07): the bed cache hardcodes
`Path.home()/".cache"/murmur/bed` (ignoring `$XDG_CACHE_HOME`), the persona
seed lives **inside the installed package** (`prompts/persona_seed.md` — fine
read-only, unwritable for spec 06), and TTS clips go to the system tmp under
three different prefixes. Since this spec introduces the first *data*
directory, it also sets the repo-wide rule:

**`paths.py` (new, stdlib-only) is the single module allowed to resolve
user-level paths.** Everything murmur keeps lives under **one home** —
`~/.murmur` by default, relocatable with `$MURMUR_HOME` (a blank value degrades
to the default) — so backing up or moving murmur is one directory, not a hunt
across `~/.cache` and `~/.local/share` (chosen over strict XDG split: this is a
single-user local companion, where "one visible home, one directory to take with
you" beats XDG orthodoxy; `$MURMUR_HOME` keeps the escape hatch). Two roots
beneath it, one criterion — "what happens if you delete it":

| Root | Resolution | Holds | Criterion |
|---|---|---|---|
| `data_root()` | `$MURMUR_HOME/data`, fallback `~/.murmur/data` | `memory/` (this spec, §3.1 — incl. `persona.md`, the living asset's writable home) | **irreplaceable** — deleting it loses user state |
| `cache_root()` | `$MURMUR_HOME/cache`, fallback `~/.murmur/cache` | `bed/` (migrates here from `~/.cache/murmur/bed`, now under the one home) | **rebuildable** — deleting it only costs a re-pull |

- Resolvers are **pure** (compute a path, don't create it); each writer
  `mkdir(parents=True, exist_ok=True)` at its own write site, as today.
- **Ephemeral clips** stay in the system tmp (`tempfile`, `murmur-*` prefixes),
  owned and cleaned by their creator on `aclose` — throwaway, not user storage,
  so out of `paths.py`'s scope. (The pre-existing leaks in `voice/remote.py` /
  `voice/mlx_backend.py` were a separate chore, issue #46 — fixed independently.)
- **Repo-relative `.dev/`, `scratch/`, `graphify-out/`** are dev-loop tooling,
  not app storage — out of scope, unchanged. A user-supplied path (e.g. the
  `$MURMUR_DEV_LOG` target) may still be `expanduser`'d at its use site: honoring
  a `~` the user typed is not hardcoding a location.
- No module outside `paths.py` may hardcode a `Path.home()` / `~`-literal
  location; a pre-commit gate (`scripts/check_paths.py`, AST-based) enforces it.

**Build order note:** `paths.py` + the `bed/` migration + the gate landed
**ahead of the rest of this spec** (a storage-consolidation chore, PR alongside
issue #46), since the two persistent roots are the shared foundation the memory
store writes into. This spec's build adds `memory/` beneath `data_root()`.

**Config additions**:

```
memory_dir: Path      # default: paths.data_root() / "memory"
compact_model: str    # cheap tier for compaction (default = the haiku id, master §7 pillar 3)
recent_window: int    # existing knob, unchanged (pack tail size)
```

### 2.4 Brain seam — one additive method

`Brain` gains `compact_profile(profile: str, transcript: list[Turn]) -> str`
(async): fold the transcript's durable facts into the profile text; return the
updated profile (bounded — the prompt instructs a size cap, §3.6). The stub
Brain returns `profile` unchanged (compaction becomes a no-op offline). Prompt
lives in `prompts/memory.py` (centralized-prompts rule, master §0).
*Rejected alternative*: running compaction as an 03-01 harness task — the
harness exists for tool-using agentic work; compaction is a pure text fold, so
a plain tool-less call on the existing Brain seam is the smaller surface.

---

## 3. Design

### 3.1 On-disk layout

```
<memory_dir>/
  persona.md      # tier ① — persona living asset (seeded on first run, §3.2)
  profile.md      # tier ① — listener facts (compaction-written, §3.6)
  history.jsonl   # tier ② — one Turn per line, append-only
  ledger.jsonl    # tier ③ — one event per line, append-only
  meta.json       # compaction watermark {"compacted_through": <ts>}
```

Write discipline: JSONL files are **append-only** (one `write` + flush per
line; a torn trailing line is tolerated on load — §3.8). `profile.md` /
`persona.md` / `meta.json` are rewritten **atomically** (temp file + `rename`
in the same directory).

### 3.2 Tier ① — Profile (and the persona's home)

- `profile.md` is a **natural-language markdown document** — who the listener
  is, preferences, favorite topics, standing context. It is Brain-written
  (compaction, §3.6) and human-editable (the user may correct it in any
  editor; next load picks it up). Injected verbatim into the pack.
- **Persona homing**: master §6 puts the persona living asset in tier ① ("why
  persona lives in Memory", master appendix). On first run, the configured
  seed (`Config.persona_path`) is **copied once** to `<memory_dir>/persona.md`;
  thereafter the app loads persona from the memory dir. That gives spec 06 its
  writable evolution target with no further plumbing. This spec never writes
  `persona.md` after the seed copy.

### 3.3 Tier ② — History rows

One JSON object per line: `{"ts": <unix float>, "session": <run id>,
"role": "radio"|"user", "text": ...}`. `record()` stamps `ts`/`session`
internally — the `Turn` dataclass and every producer stay unchanged. Rows keep
full text + timestamps so v1.5 semantic recall can embed them later without
migration (structure reserved, master §6).

### 3.4 Recent window across sessions

- In-process behavior is unchanged: a bounded deque is the hot cache;
  `record()` appends to both deque and file; `recent(n)` never touches disk.
- **Startup prime**: the deque is seeded from the tail of `history.jsonl`,
  bounded by a **freshness cutoff** — only turns younger than
  `_RECENT_MAX_AGE_H = 48` (module constant, by-feel tunable) are primed.
  Rationale: last night's closing turns *are* the continuity the master wants
  ("take the last N for continuity"); a week-old line resurfacing as "recent"
  reads as a glitch. Older continuity reaches the Brain through the profile
  (compaction), not the window.

### 3.5 Pack assembly + prompt rendering

- `Director._context()` reads `profile()` and `recent_topics(n)` from the store
  (alongside the existing recent window and scene) into the pack. No new
  Director state.
- **Prompt rendering** (`prompts/talk.py`): the profile renders as a stable
  block adjacent to the persona (the **stable prefix** — persona + profile —
  so spec 08's prompt caching lands on this ordering, master §7 pillar 4);
  `covered_topics` renders as one volatile "recently covered — don't repeat"
  line near the transcript. Because it is ledger-backed and cross-day, it
  holds even when the transcript window is empty or stale (a long-idle cold
  boot — the issue-#44 case). Empty profile / empty ledger render nothing
  (same degrade-silently posture as the scene cue).
- **Anti-repeat for music**: the Director threads `recent_songs(n)` into the
  music-pick task prompt (`prompts/music.py`) as an "avoid repeating these"
  line — the master-§6 "checked at segment selection".

### 3.6 Compaction (periodic, off the live loop)

- **Trigger**: after each `record()`, when the un-compacted backlog reaches
  `_COMPACT_EVERY_TURNS = 100` (module constant), the app schedules **one**
  background compaction task (single-flight, mirroring the Director's
  `_pending_pick` pattern); a graceful shutdown also attempts a final one.
  Startup checks the backlog too (catches killed sessions) and, if due, runs
  it **in the background after the radio is on air** — compaction never blocks
  or delays a segment.
- **Mechanism**: read `compaction_slice()` (current profile + turns since the
  watermark + that slice's `through_ts`) → `Brain.compact_profile(...)` on
  `compact_model` (cheap tier) → `apply_compaction(new_profile, through_ts)`
  writes `profile.md` atomically and advances `meta.json`'s watermark exactly
  to the handed-in `through_ts` (§2.1 — the fold races `record()`; turns
  appended meanwhile stay in the next backlog).
- **The prompt** (in `prompts/memory.py`) instructs: merge durable facts
  (identity, preferences, recurring topics, standing context) into the
  existing profile; drop ephemera; **stay under a hard size cap** (~1500
  chars) so the pack's stable prefix stays compact.
- **Failure posture**: any error (Brain failure, bad output) → keep the old
  profile, leave the watermark unmoved, one dev-log line. Never crash or
  block the radio. Stub Brain → compaction is a logged no-op (§2.4).

### 3.7 Store selection & stub isolation

`app.py` wires `PersistentMemoryStore(config.memory_dir)` for real runs.
**When `brain_provider == "stub"`** (STUB=1 / offline dev), the app keeps the
`InProcessMemoryStore`: canned stub chatter must never pollute the real
profile/history. Unit tests use the in-process fake (loop tests) or a
`tmp_path`-rooted persistent store (persistence tests — pure file I/O, still
model-free and fast).

### 3.8 Corruption tolerance

Loading either JSONL skips undecodable lines (the torn-tail crash case) with a
dev-log warning and continues — a damaged memory degrades, it never prevents
the radio from booting. `meta.json` unreadable → treat as "never compacted".

### 3.9 Topic keys — where they come from

Talk beats are free text; the ledger needs a compact topic key per beat.
Decided mechanism: the spec-04
`emit_talk_beats` tool schema gains an **optional** per-beat `topic` field
(2–5 word key) — the batch call already returns structured output, so tagging
costs **zero extra calls** (token economy, master §7). Beats arriving without
a tag simply ledger no topic (degrade silently). Song keys need no model:
the Director already holds `title`/`artist` on the pick.

---

## 4. Dependencies

- **Spec 01** — the `MemoryStore` / `ContextPack` contracts this extends; the
  Director/`_context()` assembly point.
- **Spec 04 §3.4** (landed — PRs #39/#43) — the `scene` field + `scene_for`
  seam this ratifies verbatim (§2.2).
- **Spec 03-01 / 04** — `emit_talk_beats` schema (topic tag, §3.9) and the
  music-pick prompt (anti-repeat, §3.5).
- Consumed by: **spec 06** (persona evolution writes `persona.md`; profile
  machinery), **spec 07** (ledger timestamps for anchors/pacing; adds
  `activity`), **spec 08** (stable-prefix caching).

---

## 5. Acceptance criteria (feature level)

Unit (fakes / tmp_path, model-free) unless noted:

1. **Cross-session round-trip**: record turns via one `PersistentMemoryStore`;
   a fresh instance on the same dir returns them from `recent(n)`,
   oldest-first, merged seamlessly with newly recorded turns.
2. **Freshness cutoff**: turns older than `_RECENT_MAX_AGE_H` at load are not
   primed into the window (injected clock — never wall-clock in tests).
3. **Ledger queries**: `recent_topics(n)` returns the last n topic keys in
   order, unaffected by session or midnight boundaries (pinned with injected
   clock/timestamps); `recent_songs(n)` returns the last n song keys in order.
4. **Pack assembly**: `_context()` carries `profile` and `covered_topics`;
   the talk prompts render the profile block and the don't-repeat line
   deterministically; empty values render nothing. The music-pick prompt
   carries the avoid-list.
5. **Compaction**: reaching the backlog threshold schedules exactly one
   background task; a fake-Brain result atomically replaces `profile.md` and
   advances the watermark **exactly to the slice's `through_ts`** — turns
   recorded while the fold was in flight remain in the next backlog (the
   §2.1/§3.6 race, pinned); a fake-Brain failure leaves profile and watermark
   untouched; a stub Brain no-ops. Nothing on the compaction path blocks
   segment airing.
6. **Corruption tolerance**: a garbage trailing line in either JSONL → load
   succeeds minus that line, with a dev-log warning.
7. **Contract stability**: the existing unit suites pass unchanged; both
   stores satisfy the extended `MemoryStore` Protocol (`isinstance` via
   `runtime_checkable`); `ContextPack` additions are all defaulted (existing
   constructions compile untouched).
8. **Stub isolation**: a `brain_provider="stub"` app wiring leaves
   `memory_dir` untouched.
9. **On-device**: the memory layer performs no network I/O — its only imports
   are stdlib + project contracts (inspectable); compaction's network happens
   inside the existing Brain seam only.
10. **Real smoke** (murmur-smoke, on-demand): two short real runs
    back-to-back; verify from the files + `.dev/dev.log` (never the model's
    self-report) that run 2's first context pack carried run 1's tail and that
    a forced compaction produced a plausible `profile.md`.

---

## 6. Resolved decisions + open questions

### Resolved (user sign-off, 2026-07-21)

1. **Topic tagging** (§3.9): `emit_talk_beats` gains an optional per-beat
   `topic` field (zero extra calls). The single-shot `next_talk` and `respond`
   paths stay untagged (no structured output there).
2. **Persona homing** (§3.2): seed-copy `persona.md` into `memory_dir` on
   first run; spec 06 gets its writable evolution target.
3. **Freshness cutoff** (§3.4): 48h (`_RECENT_MAX_AGE_H`), with the cross-day
   ledger line (§3.5) backstopping repetition when the window is empty
   (issue #44).
4. **Compaction cadence** (§3.6): backlog ≥ 100 turns + graceful shutdown +
   startup catch-up, all off the live loop.
5. **Path governance** (§2.3): the `paths.py` two-root rule (XDG data/cache
   homes) incl. the bed-cache migration; a single `~/.murmur/` was rejected.

### Still open (build-time / eval-track, none blocking)

- **The by-feel constants** — `_RECENT_MAX_AGE_H = 48`,
  `_COMPACT_EVERY_TURNS = 100`, the ~1500-char profile cap — are starting
  guesses; tune on real-run feel, same posture as the bed gains (03-04 §6).
- **Topic-tag quality** (does the model produce useful, stable keys?) is
  stochastic — an eval-track concern (DESIGN §10.3), not a unit assertion.
- **Compaction prompt wording** (what counts as a durable fact) will need a
  real-run pass; the unit layer only pins the mechanism (§5.5).
