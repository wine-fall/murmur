# spec/05-01 · recall & forgetting — memory v1.5

> **Status**: **Draft, 2026-09-02** — designed from a survey of open-source
> agent-memory systems (§7) and from the real memory dir of the author's
> install (§1.1). Not built. Extends [`05-memory.md`](05-memory.md); nothing
> in spec 05 is contradicted, only its "deferred to v1.5" items are delivered
> and its compaction input is re-scoped.
> **Part**: The Memory layer (master [`../DESIGN.md`](../DESIGN.md) §6), v1.5:
> retrieval over history, a profile whose facts carry dates and fade, a
> listener-only compaction input, and forgetting on request.
> **Milestone**: "it gets me" holds up over weeks, not just across one restart.
> Depends on spec 05 (tiers + compaction), spec 11 (the steer harness that
> carries the new tools), spec 06 (the bootstrapped profile shape it must stay
> compatible with).
> **Privacy boundary (master §3.1)**: unchanged. Everything here is local
> files + one derived SQLite index; memory content reaches the network only
> inside the already-sanctioned Claude-inference hop.
> **Conventions**: English; written for a coding agent. Design-level. No CJK in
> source (listener text in examples is paraphrased in English).

---

## 1. Goal & scope

### 1.1 What the real files showed (why this spec exists)

Measured on the author's install on 2026-09-02, after ~6 weeks of light use:

| Fact | Value |
|---|---|
| `history.jsonl` rows | 137 |
| of which `role: user` | **4** (a track-change request, a slash command, an "is it playing?" question, one "continue") |
| of which `role: radio` | 133 |
| compactions so far | 1 (watermark advanced once) |
| `profile.md` | 732 chars |

The one profile that exists is **polluted**: it states that the listener is
"touched by daily details: light, temperature, sounds, changes outside the
window" and "resonates with time passing and wordless company". Those are the
**host's own monologue topics**, not anything the listener said. It also turns
the single track-change request into "sensitive to music intensity, asks for
adjustments when a track is lively". Two defects, both structural, not prompt
wording:

1. The compaction slice is ~97% host monologue, so the fold attributes the
   host's musings to the listener.
2. One-off, acted-on requests are admitted as durable preferences.

The other three gaps are the ones spec 05 deferred: nothing is ever retrieved
from history beyond the 12-turn tail, no fact carries a date so nothing can go
stale, and there is no way to forget.

### 1.2 Delivers

1. **Listener-only compaction input** (§3.1): the fold sees the listener's
   turns and the one host turn each replied to — never the monologue stream.
   Cadence moves from "100 turns" to "N listener turns".
2. **Admission gate** (§3.2): deterministic, no model call. Slash commands,
   acknowledgements, and steer commands the program already acted on do not
   enter the fold.
3. **Dated, fading profile facts** (§3.3): every profile line carries a
   `[seen YYYY-MM-DD]` tag; the fold refreshes dates when a fact is
   re-confirmed and replaces contradicted facts; a deterministic pass fades
   lines unconfirmed for `FACT_FADE_DAYS` into a faded section that is not
   rendered into prompts but stays searchable.
4. **Recall over history** (§3.4): a derived FTS5 index (`node:sqlite`, zero
   dependencies) over history + faded facts, with CJK-aware tokenizing and a
   recency × source-weighted rerank; exposed as `recall_memory` on the spec-11
   steer harness only.
5. **Forgetting on request** (§3.5): `forget_memory` on the same harness.
   Physical removal from history and profile, index rebuilt. No backup — forget
   means forget.
6. **Prompt grounding** (§3.6): recalled lines render with their dates and
   speaker; the model is told to cite, never to invent, a memory.

### 1.3 Out of scope (explicit non-goals)

- **Embeddings / vector search.** FTS5 keyword recall over a personal history
  of this size is enough; a local embedding runtime costs tens of MB of native
  deps for a gain no one has asked for. `sqlite-vec` was verified to load into
  `node:sqlite` (`allowExtension`) if this ever changes — the index schema keeps
  a rowid per turn so vectors can be added beside it.
- **Recall inside the batched talk call.** Master §7 pillar 1: no new spend
  per boundary. Talk beats keep getting the profile + ledger; the recall tool
  rides the reply turn the listener already pays for. If by-ear later says the
  host "never brings things up on its own", that is a spec-07 pacing decision
  (an anchor that spends one recall), not a change here.
- **A structured fact database** (mem0 / memobase style JSON fact ops). The
  dated-prose profile plus a deterministic fade pass covers dates,
  contradiction and decay at ~1/4 of the code, keeps `profile.md`
  human-editable, and keeps the spec-06 bootstrap output valid as-is.
- **Host self-continuity recall** ("yesterday I talked about the smell of
  cooking"). The ledger already prevents repeats; deliberate callbacks are a
  persona/pacing matter. Host turns stay in the index only so `recall_memory`
  can answer "what did you say about X" if the listener asks.
- **Undo of a forget.** See §3.5.
- **Multi-instance concurrency**, **encryption at rest**: unchanged from spec
  05 non-goals.

---

## 2. Contracts / seams

### 2.1 `MemoryStore` — two additive methods

```ts
// contracts.ts — additive; every fake gains a trivial implementation.
type RecallHit = {
  readonly ts: number          // unix seconds of the source row
  readonly role: 'radio' | 'user' | 'faded'  // 'faded' = a faded profile line
  readonly text: string
  readonly score: number       // final rerank score, higher = better
}

interface MemoryStore {
  // ...spec 05 methods unchanged...
  recall(query: string, limit: number): RecallHit[]
  // Remove every history row and profile line matching `what` (§3.5).
  // Returns how many rows/lines were removed so the tool can report it.
  forget(what: string): { rows: number; lines: number }
}
```

- `InProcessMemoryStore`: `recall` = case-insensitive substring scan over its
  turns (enough for Director/steer tests); `forget` = filter the arrays.
- `PersistentMemoryStore`: §3.4 / §3.5.

### 2.2 Steer harness — two tools (spec 11 §2.2 extension)

`SteerActions` gains an optional `memory` capability; absent → neither tool is
offered (a stub run, or the in-process store when not persisting):

```ts
type SteerActions = {
  readonly music?: ...
  readonly shutdown: ...
  readonly memory?: {
    recall(query: string): RecallHit[]      // limit fixed by the Director (RECALL_LIMIT = 5)
    forget(what: string): { rows: number; lines: number }
  }
}
```

| Tool | Input | Returns to the model | When the prompt tells the model to call it |
|---|---|---|---|
| `recall_memory` | `query: string` — a few words in the listener's language | up to 5 hits as `YYYY-MM-DD HH:MM · listener/host/faded: text` | the listener refers to something not in the transcript or profile ("that project", "like last time", "do you remember"); at most **one** call per reply |
| `forget_memory` | `what: string` — the topic/phrase to erase | `removed N lines` | the listener explicitly asks the host to forget/erase/not remember something. Never on a mood remark. |

`maxTurns` for the steer task goes **3 → 4** (recall → act → reply → slack).
`submit_reply` stays the terminal tool; fallbacks unchanged.

### 2.3 Compaction surface (impl-level, spec 05 §2.1) — re-scoped

- `compactionDue()` = admitted listener turns past the watermark ≥
  `COMPACT_EVERY_USER_TURNS` (**8**; by-feel, spec 05 §6 posture).
- `compactionSlice()` returns only the **admitted listener turns and, for
  each, the host turn immediately before it** (the line it answered), oldest
  first, as `Turn[]` — the fold input. `throughTs` is still the newest history
  row's ts past the watermark (including host rows), so the watermark keeps
  covering the whole tail and the monologue is never re-scanned.
- `applyCompaction(newProfile, throughTs)` additionally runs the **date
  post-pass** and the **fade pass** (§3.3) before writing.

### 2.4 Brain seam — unchanged

`compactProfile(profile, transcript)` keeps its signature. Only the prompt and
the slice change. The stub Brain's no-op stands.

### 2.5 Config / constants

| Name | Default | Where | Note |
|---|---|---|---|
| `COMPACT_EVERY_USER_TURNS` | 8 | `memory.ts` | replaces `COMPACT_EVERY_TURNS` |
| `FACT_FADE_DAYS` | 90 | `memory.ts` | a line unconfirmed this long fades |
| `RECALL_LIMIT` | 5 | `director.ts` | hits handed to the model |
| `RECALL_CANDIDATES` | 40 | `memory.ts` | bm25 top-k before rerank |
| `RECALL_HALF_LIFE_DAYS` | 30 | `memory.ts` | recency decay |
| `RECALL_USER_BOOST` | 3 | `memory.ts` | listener rows over host rows |

No new `Config` fields, no new settings-pane items (spec 12 untouched).

---

## 3. Design

### 3.1 Listener-only compaction input

The fold's job is "what did I learn about the listener". Its input is
therefore the listener's own words plus the minimum context to read them:

```
for each admitted user row U past the watermark:
  emit the nearest preceding radio row (if any, and not already emitted)
  emit U
```

Rendered as `host: ...` / `listener: ...` lines. The prompt (§3.6) states the
rule in words too, but the slice makes it structural: a fold cannot attribute
monologue to the listener because it never sees the monologue.

Consequences, all intended:
- A session in which the listener never types **never folds**. Nothing to
  learn. The ledger keeps doing anti-repeat for the host's own stream.
- Fold input shrinks ~30× against today's slices; the fold gets faster and
  cheaper. The 3 s shutdown flush (spec 05 §3.6) is left as is: with recall
  (§3.4) the un-folded tail is reachable anyway, so a fold that lands on the
  next boot costs nothing the listener can feel.

### 3.2 Admission gate (deterministic, before the fold)

A listener row is **not admitted** to the fold when any of these hold:

| Rule | Example (paraphrased) | Why |
|---|---|---|
| starts with `/` | `/done`, `/settings` | a command, not speech |
| ≤ 2 characters after trim, or matches the ack list (`ok`, `yes`, `no`, `thanks`, `continue`, `hmm`, and their CJK equivalents — a small constant list) | "ok" | nothing to learn |
| the steer turn that consumed it called `switch_music`, `end_broadcast`, or `change_settings` **and** the line is under 12 characters | "next song" | acted-on request, not a preference. Longer lines pass: "skip this, I can't do saxophone tonight" carries a fact |

The Director already knows which tool the steer turn called (spec 11 logs
it); it records the row with a `steered: true` flag in `history.jsonl` (an
additive optional field on the row schema — zod default `false`). The gate
reads the flag; nothing else changes on disk.

Not admitted ≠ not recorded: every row still lands in `history.jsonl` and in
the recall index. The gate only decides what the profile learns from.

**Not** a secrets/injection regex bank (memoripy-style). The listener types to
their own local radio; the trust boundary is the file, already zod-parsed.

### 3.3 Dated, fading profile

**Shape.** `profile.md` keeps its two spec-06 sections. Inside them every
fact is one line ending in a date tag, optionally `[stable]`:

```
(About the listener)
- Works on a personal radio project in the evenings [seen 2026-08-15]
- Prefers tea; said they stopped drinking coffee [seen 2026-09-01]
- Name they go by: Z; speaks Chinese [seen 2026-07-20] [stable]

(Relationship & style)
- Replies in short lines; does not expect guidance [seen 2026-08-30]
```

**The fold's rules** (prompt, §3.6): derive facts only from `listener:` lines;
a fact re-confirmed gets today's date; a newer statement that contradicts an
older fact **replaces** it (keep the newer, one line); a one-off request is
not a preference unless it recurs; mark identity facts (name, language, where
they live, what they do) `[stable]`.

**Date post-pass** (deterministic, in `applyCompaction` and on load): any
fact line without a `[seen ...]` tag gets today's date. This covers the
spec-06 bootstrap output and hand edits without changing either writer.

**Fade pass** (deterministic, in `applyCompaction` and on load): a line whose
date is older than `FACT_FADE_DAYS` and is not `[stable]` moves to
`profile-faded.md` (same line, verbatim, appended). Faded lines:
- are **not** rendered into any prompt (the stable prefix only carries live
  facts);
- **are** in the recall index as `role: 'faded'`, so "you used to drink
  coffee, didn't you" can still be answered;
- come back only through the fold: if the listener re-states the fact it is
  a new live line. (The prompt does not see faded lines; that is deliberate —
  the host should not "remember" something it has visibly forgotten unless
  asked, and asking runs recall.)

Pitfall, accepted: a bootstrapped profile whose listener never types fades
wholesale after 90 days except its `[stable]` lines. That is the right
behaviour for a host that met someone once, three months ago.

**Cap.** `PROFILE_CHAR_CAP` (1500) stands; the fade pass runs before the cap
is checked, so old facts make room before the model is asked to squeeze.

### 3.4 Recall — a derived FTS5 index

**Storage.** `<memory_dir>/index.db`, `node:sqlite`, one FTS5 table
(`unicode61` tokenizer) with columns `(ts, role, body)` plus `rowid`. **Derived
and disposable**: built from `history.jsonl` + `profile-faded.md` on boot when
missing or when its row count disagrees with the source; deleting it costs a
rebuild (< 100 ms at 10k rows). It therefore lives under `data/` beside its
sources but is documented as rebuildable. The JSONL files stay the source of
truth; nothing is written to the db that is not also in a JSONL/markdown file.

**CJK tokenizing.** `unicode61` treats a run of Han characters as one token,
so "coffee" in a sentence never matches. Before insert **and** before query,
every maximal run of Han / kana / Hangul characters is replaced by its
character **bigrams** joined by spaces (a 1-char run stays as is); Latin text
passes through untouched. Verified on Node 24.14 / SQLite 3.51.2: a 2-char
CJK word query hits, a mixed CJK+Latin sentence hits on both halves, bm25
ranks. `trigram` was rejected: it cannot match 2-character words, which are
most Chinese words.

**Query.** The tokens of the shingled query, deduplicated, joined by `OR`,
each quoted. Top `RECALL_CANDIDATES` by `bm25()`. Then a TS rerank:

```
score = relevance × source × recency
relevance = -bm25            (bm25 is negative-is-better)
source    = role == 'user' ? RECALL_USER_BOOST : 1
recency   = 0.5 ^ (ageDays / RECALL_HALF_LIFE_DAYS)  (floor 0.05, so an old
                                                       exact hit still surfaces)
```

Rows inside the current recent window (already in the transcript) are
excluded. Return the top `limit`.

**Why rerank in TS**: one query, one sort, readable in a unit test; the SQL
stays a plain FTS match.

**Warning noise.** `node:sqlite` prints `ExperimentalWarning` to stderr on
first use. The engine process installs a `process.on('warning')` filter for
that one name (or runs with `--disable-warning=ExperimentalWarning` in the
`bin` shim — implementer's pick, but `make pack` must show a clean stderr).

### 3.5 Forget on request

`forget(what)`:
1. `what` is shingled and matched against the index exactly like recall, but
   every hit above a fixed relevance floor is taken, not the top-k.
2. The matched history rows are removed: `history.jsonl` is rewritten
   atomically without them (the one sanctioned non-append write; spec 05 §3.1
   discipline: temp + rename).
3. Profile and faded lines containing any token of `what` (post-shingle,
   case-insensitive) are removed from both files, atomically.
4. The index is rebuilt from the sources.
5. A ledger event `kind: 'forget'` with key = the ISO time (no text) is
   appended, so the host can acknowledge it did forget without keeping what.
6. The in-memory recent window is filtered the same way, so the very next
   pack no longer carries it.

**No backup, no undo.** A forgotten line that is kept "just in case" is not
forgotten; the listener asked for the opposite. The tool's reply names the
count; if it is 0 the model says it found nothing to forget.

Pitfall: over-match. "forget about the coffee thing" shingled includes
"about" / "thing"-like tokens in CJK too. Mitigation: the relevance floor is
set so a row must match at least two tokens or one 3+-char token, and the
tool result lists the removed lines' first 40 chars so the reply can tell the
listener what went. If by-ear says it over-forgets, the floor is the knob.

### 3.6 Prompts (all in `prompts.ts`)

- **Compaction instruction**: rewritten around the §3.3 rules and the
  `host:`/`listener:` labels; keeps the two-section shape; states the
  `[seen]`/`[stable]` syntax with one example line; keeps the char cap.
- **Reply prompt**: a `(From memory)` block renders recall hits as
  `- 2026-08-15, listener said: "..."` (host / faded labelled likewise); an
  added grounding line: *only mention a past moment that appears in the
  transcript, the profile, or a recall result; never invent a date or a
  quote*. Absent hits render nothing.
- **Steer switch rules**: two new bullets gated on `actions.memory`, in the
  spec-11 style, for `recall_memory` and `forget_memory`.

---

## 4. Use cases this must serve (and how)

| # | Scenario | Path |
|---|---|---|
| U1 | Listener returns after two weeks and types "that project is finally done" | steer turn → `recall_memory("project")` → hit from 14 days ago → reply references it by name |
| U2 | Listener says "I stopped drinking coffee" | fold: contradiction rule replaces the older coffee line, dated today |
| U3 | Listener types "next song" three sessions in a row | admission gate drops each (steered, short); no "dislikes music" fact ever forms |
| U4 | Host monologues for an hour, listener silent | no fold; ledger anti-repeat only; profile untouched |
| U5 | A fact from June is never mentioned again | fades in September; still recallable if asked |
| U6 | "Forget what I told you about my sister" | `forget_memory` → rows + lines gone, ledger notes a forget, reply confirms count |
| U7 | Listener asks "what did you say about the evening sky yesterday" | recall over host rows (source weight 1, recency high) → answer |
| U8 | Hand-edited profile line with no date | date post-pass stamps it on next load; behaves like a fresh fact |
| U9 | `index.db` deleted or corrupt | rebuilt from JSONL on boot; one dev-log line |
| U10 | `STUB=1` | in-process store: recall = substring scan, no tools offered (no `memory` action) |

---

## 5. Acceptance criteria

Unit (fakes / `tmp` dir, injected clock, model-free) unless noted:

1. **Slice is listener-only**: 3 user rows among 40 radio rows → the slice has
   exactly 6 turns (3 host + 3 listener), `throughTs` = the newest row of all
   40+3; a slice with 0 admitted user rows is empty and `compactionDue()` is
   false regardless of host-row count.
2. **Admission gate**: each §3.2 rule pinned with one positive and one
   negative case; a `steered` short line is out, a `steered` long line is in.
3. **Date post-pass**: a profile with undated lines gets every line dated
   with the injected clock; dated lines untouched; `[stable]` preserved.
4. **Fade pass**: a line older than `FACT_FADE_DAYS` moves to
   `profile-faded.md` verbatim; a `[stable]` line of the same age stays;
   rendered profile (`profile()`) excludes faded lines; faded lines appear in
   `recall` as `role: 'faded'`.
5. **Shingling**: a 2-char CJK query hits a row containing it; a Latin query
   hits; a query of the row's own text ranks that row first; a row inside the
   recent window is excluded.
6. **Rerank**: with equal bm25, a user row outranks a host row; with equal
   role, a 1-day-old row outranks a 60-day-old one; the recency floor keeps a
   1-year-old exact hit in the result.
7. **Index is derived**: delete `index.db` → next construction rebuilds it and
   `recall` answers identically; a row-count mismatch triggers a rebuild.
8. **Forget**: after `forget("coffee")`, `history.jsonl` lacks the rows,
   both profile files lack the lines, `recall("coffee")` is empty, `recent(n)`
   is filtered, the ledger has one `forget` event whose key carries no text;
   `forget("zzz")` returns zeros and changes nothing.
9. **Steer tools**: with `actions.memory` present the task offers both tools
   and `maxTurns` is 4; absent, neither is offered; a fake harness calling
   `recall_memory` then `submit_reply` yields the reply; the reply prompt
   renders the `(From memory)` block deterministically and renders nothing
   with no hits.
10. **Compaction prompt**: renders `host:`/`listener:` labels, the `[seen]`
    example, the cap; the stub Brain still no-ops.
11. **Contract stability**: existing suites pass; both stores satisfy the
    extended `MemoryStore`; the on-disk row schema accepts rows without
    `steered` (old files load).
12. **No warnings**: `make pack` run shows no `ExperimentalWarning` on stderr
    (manual; recorded in the PR body).
13. **Real smoke** (`murmur-smoke`, on demand): two short real runs; in run 2
    type a line that refers to something said in run 1 and verify from
    `.dev/dev.log` that `recall_memory` was called and its hit carried the
    run-1 row — never from the model's self-report.

---

## 6. Decisions, pitfalls, open questions

### Decided (with the reason, so it is not re-litigated)

1. **No library.** Every surveyed system either makes its own model calls
   (mem0, hindsight, honcho, supermemory's closed local binary), needs a
   server (Letta, Zep, memobase), or bundles a native SQLite/ONNX runtime for
   what `node:sqlite` gives for free (memelord, hippo, Ori-Mnemos, the
   pi-agent extensions). See §7.
2. **Prose profile with inline dates over a fact table.** Memobase's
   `[mentioned on date]` inline tag was the smallest mechanism that gives
   dates, contradiction and decay; it keeps spec 06's writer and the human
   editability untouched.
3. **Listener-only fold input over "better prompt wording".** The pollution
   was structural; a prompt rule against a 97% monologue input would still be
   a coin flip.
4. **Recall only on the reply turn.** Pillar 1. The talk path stays
   tool-less.
5. **Deterministic gate and fade, model-driven merge.** Code decides what
   enters and what expires; the model only decides how to phrase and merge.
   That is the split the pi-observational-memory "preservation floor" and
   memoripy's admission policy both converged on.
6. **Physical delete on forget, no backup.** Honest semantics beat undo.
7. **`node:sqlite` despite the experimental flag.** It is the only zero-dep
   FTS5; the flag has been stable since Node 22.5 and the API surface used is
   three calls. If it breaks on a Node bump, `better-sqlite3` is a drop-in
   with a native build cost — noted, not taken.

### Pitfalls the implementer must not walk into

- **The fold prompt must never see raw host monologue** — do not "helpfully"
  widen the slice for context. One preceding host line per listener line is
  the ceiling.
- **`throughTs` covers host rows too.** If the watermark only advanced to the
  last listener row, the monologue after it would be re-scanned forever
  (harmless but wasteful, and it breaks criterion 1).
- **Shingle both sides.** An index built with bigrams and a query without
  (or vice versa) matches nothing and fails silently. Criterion 5 pins it.
- **bm25 is negative.** Sort ascending on bm25, or negate before multiplying.
- **The recent window exclusion must use the same `ts`** the index stores;
  compare by ts, not by text.
- **Fade before cap.** Otherwise the model is asked to cut live facts to make
  room for dead ones.
- **`steered` is per row, set by the Director**, which is the only place that
  knows which tool ran. Do not infer it from text.
- **Forget rewrites `history.jsonl`** — the only non-append write. Use the
  existing `atomicWrite`; never truncate in place.
- **Tests must inject the dir** (the `~/.murmur` test-isolation gap already
  bit this repo). Never construct a store without `dir` in a test.
- **Index rebuild on boot must not block air**: it is < 100 ms at v1 sizes,
  but do it in the constructor's `load()` synchronously and measure in the
  PR — if it ever exceeds ~300 ms, move it behind the first segment like
  compaction catch-up.

### Open (build-time or by-ear; none blocking)

- The `FACT_FADE_DAYS = 90` / `COMPACT_EVERY_USER_TURNS = 8` values are
  starting guesses.
- Whether the model calls `recall_memory` when it should (and not when it
  should not) is stochastic: eval track, alongside the spec-11 steer
  tool-choice eval (#98).
- The forget relevance floor (§3.5) needs a real-run pass.

---

## 7. Survey of prior art (2026-09-02, recorded so we do not re-survey)

Searched with `gh search` per the repo rule; each candidate's README and core
source read. Column "borrowed" names what this spec took.

| Project | Shape | Why not as a dependency | Borrowed |
|---|---|---|---|
| mem0 (TS SDK) | lib, pluggable LLM incl. Anthropic | hard dep on `openai`, 40+ peer deps, vector store abstraction | the ADD/UPDATE/DELETE fold decision, as prompt rules (§3.3) |
| memobase | server (Postgres+Redis) | server | inline `[mentioned on date]` tags, per-fact merge (§3.3) |
| memoripy | Python lib | language | deterministic admission gate before the fold (§3.2) |
| hindsight | server (Postgres, own LLM loop) | server, own calls | — ("mental models" = our profile already) |
| honcho | server, AGPL | license + server | — |
| MemOS local-plugin | TS lib, host-LLM bridge, FTS5+vector | skill crystallisation / reward backprop far beyond need; `better-sqlite3` | the host-LLM-bridge idea is what our Brain seam already is |
| supermemory | SaaS; "local" = closed binary | closed | static vs fading facts (§3.3) |
| claude-mem | Claude Code plugin, Chroma + Bun worker | Python/Chroma | 3-layer progressive disclosure (not needed at our size) |
| memelord | TS lib, Turso native | native dep for what node:sqlite has | EMA weight + decay + contradict-deletes → simplified to §3.4 rerank + §3.5 |
| hippo-memory / Ori-Mnemos | CLIs with native sqlite/onnx, graph | apps, not libs | recency × importance × relevance (§3.4) |
| opencode-agent-memory | OpenCode plugin | coupled | Letta-style capped, labelled blocks = our two sections |
| A-mem | Python paper code | 2+ model calls per memory | — |
| pi-observational-memory | pi extension, 2.8k lines | coupled | relevance tiers + "drop only once covered" → our gate/fade split (§6.5) |
| pi-hermes-memory | pi extension, 13k lines, better-sqlite3 | size, native | correction detection → folded into the contradiction rule |
| jayzeng/pi-memory | pi extension, single file, zero deps | coupled | forget-with-archive; we took forget, dropped the archive (§3.5) |
| samfoy/pi-memory | pi extension, `node:sqlite` FTS5 | coupled | the `node:sqlite` + FTS5 store shape (§3.4); its exclusion-list extraction prompt |
| sqlite-vec | SQLite extension, npm 0 deps | not needed yet | verified loadable; reserved (§1.3) |
