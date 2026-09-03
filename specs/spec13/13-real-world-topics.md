# spec/13 · real-world-topics — an off-loop pool of things that actually happened

> **Status**: **Built 2026-09-03** (this PR). Pool, roll, fetch task, prompt
> rendering, the settings knob and the steer field all land; the unit suite is
> green; a real `fetchTopics` was smoked through the SDK and a real `rwt.offer`
> was read out of `.dev/dev.log` against the beat it produced. **§5's by-ear
> criteria are open** — user-run, tracked as one issue.
> **Part**: The "say real things" line of [`../../ROADMAP.md`](../../ROADMAP.md)
> §2. Gives the self-initiated talk task material from outside its own head:
> news, releases, what is happening where the listener is. Absorbs
> [#44](https://github.com/wine-fall/murmur/issues/44) (the cozy-imagery
> attractor) as the durable fix — a cold boot stops being identical when the
> host has something real in front of it.
> **Milestone**: companion character, after specs 04/05/07/11/12. Depends on
> the harness (spec 03-01), the talk look-ahead (spec 04), the settings layer
> (spec 12) and the steer task (spec 11).
> **Network posture (master §3.1, amended)**: this is the **fourth network
> call** — the host's brain, the voice, the music pull, and now a bounded
> WebSearch task. The "three network calls" wording in `DESIGN.md` is already
> stale ([#104](https://github.com/wine-fall/murmur/issues/104)) and is not
> edited here. Nothing about the listener leaves the machine except what the
> task is told: a language name, a timezone name, and the titles already in
> the pool.
> **Conventions**: English; written for a coding agent. Mechanism and
> contracts, not final code. Prompt text centralized in `src/prompts.ts`; no
> CJK in source (master §0).

---

## 1. Goal & scope

### Delivers

1. **A topic pool** (`RwtPool`): a small file of real-world items — title,
   a two-to-three-sentence gist in the listener's spoken language, a
   category — fetched **off the live loop** and read from at talk-generation
   time. Entries expire; the pool refreshes itself in the background.
2. **A fetch task** (`Brain.fetchTopics`): one bounded agentic run over the
   SDK's built-in `WebSearch` plus one murmur terminal tool, `submit_topics`.
   Neutral system framing — a researcher gathering material for a host, never
   the persona speaking.
3. **A probability roll** (`RwtRoll`): whether a given talk batch is offered a
   topic at all. Not every batch: an item on every batch is a news ticker, and
   the listener said so.
4. **The prompt seam**: `ContextPack.rwt` and `rwtLine()` — rendered as
   *material, not an assignment*. The anchor beats and the coda never carry it.
5. **The knob**: `rwtEnabled` in settings (default on), `--no-rwt`, and a
   `rwt` field on `change_settings` so "stop with the news" typed to the radio
   turns it off.
6. **The taste file**: `$MURMUR_HOME/rwt-policy.md`, the music-policy shape
   (spec 03-01 §2.3) — code owns the contract (shape, freshness, dedupe,
   privacy), the listener owns what to look for.

### Out of scope (explicit non-goals)

- **A live lookup on the talk path.** Picks already run 80–190 s in a bad
  session; anything network-bound at `generateTalks` would break the spec-04
  look-ahead. Talk reads the pool and nothing else.
- **Storing region.** Region is read from the system timezone at fetch time
  and written into the fetch prompt; it is never persisted and never asked
  for. Language is not region (ROADMAP §2).
- **A new onboarding question, a pane row, or a TUI surface.** The knob is
  reachable by flag, file, and the conversation. The pane stays at spec 12's
  eight items.
- **Fact-checking, citations, or source attribution on air.** The host may
  mention what it read; it does not read out URLs or outlets.
- **Personal or private material.** The fetch prompt forbids it outright
  (§3.3); nothing in the pool is about the listener.
- **The stub brain.** `StubBrain.fetchTopics` returns nothing; an empty pool
  never offers, so a stub run is exactly its pre-spec-13 self.

---

## 2. Contracts / seams

### 2.1 The pool entry and the file

```ts
// src/rwt.ts
export type RwtTopic = {
  readonly id: string        // opaque, unique within the file
  readonly title: string     // one line, the thing itself
  readonly gist: string      // 2–3 spoken sentences, in the listener's language
  readonly category: string  // free text from the policy's list
  readonly fetchedAt: number // epoch seconds
  readonly used: boolean     // offered once; never offered again
}
```

- **Location**: `cacheRoot()/rwt.json` (`src/paths.ts` → `rwtPoolPath`). It is
  rebuildable — deleting it costs one fetch.
- **Shape on disk**: `{ refreshedAt?: number, entries: RwtTopic[] }`, parsed
  with zod at the boundary. A missing, unreadable, or malformed file is an
  empty pool, never a boot failure.
- **Expiry**: an entry older than `ttlHours` (default 48) is dropped on load
  and on merge.
- **Refresh due**: `refreshedAt` absent, or older than `staleHours`
  (default 6). Checked once at boot and then at every segment boundary.
- **Take**: `take()` returns the oldest fresh, unused entry, marks it used,
  persists, and returns it — or `null`. Marking happens **at take time**, not
  at air time: a beat that is generated and then discarded (a steer, a quit)
  still burns its topic. Accepted: a burned topic costs nothing, a repeated
  one costs the illusion.

### 2.2 The fetch task — `Brain.fetchTopics`

```ts
export type FetchTopicsRequest = {
  readonly language: string       // the gist's language, a name ("Japanese")
  readonly timezone: string       // IANA, from Intl — the only region signal
  readonly today: string          // YYYY-MM-DD, local
  readonly avoid: readonly string[] // titles already in the pool
  readonly policy: string         // the taste half (§2.5)
}

interface Brain {
  // Bounded WebSearch run; [] on a stub, on a turn budget exhausted, or on
  // any failure the caller treats as "no refresh this round".
  fetchTopics(req: FetchTopicsRequest): Promise<Omit<RwtTopic, 'id' | 'fetchedAt' | 'used'>[]>
}
```

- **Harness change**: `Task<T>` gains an optional `builtins?: readonly
  string[]`. `agenticOptions` puts them on the SDK's `tools` **and**
  `allowedTools` — bounded and pre-approved, so the run neither prompts nor
  reaches anything else. The default stays `[]`: the music pick and the steer
  task are exactly what they were.
- **The fetch task** passes `builtins: ['WebSearch']`, `maxTurns` 12, the
  cheap tier (`rwtModel`, default Haiku), and one terminal tool
  `submit_topics({ topics: [{ title, gist, category }] })` (zod; 1–8 items;
  title ≤ 120 chars, gist ≤ 600, category ≤ 40).
- **System prompt**: `RWT_FETCH_SYSTEM_PROMPT` — "You gather real-world
  material for a radio host" — never the persona.
- **Language**: the request's `language` is the effective spoken language,
  read where the host reads its own: `settings.language` if set, else the
  language the persona says it speaks (`personaLanguage`, the "speak in X"
  clause the bundled seed carries), else the persona's own first line of
  prose held up as the example ("the language this is written in: …") — a
  generated persona is written in the listener's language and never names it
  in English (spec 06 §2.2). Never the machine locale: it is not a record of
  anything once the install is past its first run.

### 2.3 The roll — `RwtRoll`

`RandomCadence`'s shape (spec 03-02 §2.3), one rung down: `{ p, minGap,
maxGap, random }` over a counter of **talk batches since the last offer**.
Never before `minGap` batches; always by `maxGap`; `p` in between. Defaults
`p 0.35, minGap 1, maxGap 4`. Injected `random` for determinism.

### 2.4 The Director seam

```ts
// DirectorDeps
rwt?: {
  offer(): RwtTopic | null   // roll, then take; null = nothing this batch
  maybeRefresh(): boolean    // single-flight background refresh if due
}
```

- `maybeRefresh()` is poked at **every segment boundary**, beside
  `compactor.maybeSchedule()`. It never blocks; a failure costs one debug
  line and the next boundary retries once the pool is still stale.
- `offer()` is called **once per `generateTalks`** whose cue is neither
  `anchor:*` nor `coda`, and only while `settings().rwtEnabled`. A hit lands
  as `ContextPack.rwt = { title, gist }` on that batch's pack.
- Absent (stub runs, tests): no roll, no refresh, no field.

### 2.5 The prompt seam

- `ContextPack.rwt?: { readonly title: string; readonly gist: string }`.
- `rwtLine(ctx)` renders **material, not an assignment**: the item, then the
  usage — one thread of it, in the host's own words, the way a friend mentions
  something they read; never a bulletin, never a headline read out, never a
  list; leave it if it does not fit. Absent → renders nothing.
- `DEFAULT_RWT_POLICY` / `RWT_POLICY_HEADER` / `buildFetchTopicsPrompt(req)`
  live in `src/prompts.ts`. The listener's `rwt-policy.md` replaces the policy
  wholesale (HTML comments stripped, the music-policy discipline).
- `STEER_SETTINGS_RULE` names the new knob so the reply turn knows "stop with
  the news" is a settings ask.

### 2.6 The knob (spec 12's shape)

- `Config.rwtEnabled` (default `true`), `--no-rwt`, `settings.json`
  `rwtEnabled`; layered file < flag exactly like `anchorsEnabled`.
- `Settings.rwtEnabled` in `SettingsValuesSchema` / `SettingsPatchSchema`.
- `change_settings` gains `rwt?: boolean` → `rwtEnabled`.
- Numeric knobs are env-only (`MURMUR_RWT_P`, `MURMUR_RWT_MIN_GAP`,
  `MURMUR_RWT_MAX_GAP`, `MURMUR_RWT_STALE_HOURS`, `MURMUR_RWT_TTL_HOURS`),
  parsed with the same warn-and-default posture as `MURMUR_TTS_*`.

### 2.7 The verifiable seam — `host.debug`

| line | when |
|---|---|
| `rwt.refresh n=<int> ms=<int>` | a background refresh merged `n` new entries |
| `rwt.refresh failed (<reason>)` | the fetch threw or returned nothing |
| `rwt.offer <id>` | a topic was taken for a batch |
| `rwt.pool fresh=<int> used=<int>` | after every load/merge/take |

Read these in `.dev/dev.log` and compare against the beat text before
believing the model did anything. The model's own narration is not evidence.

---

## 3. Design

### 3.1 Off the loop, by construction

The pool is the only thing the talk path touches: `offer()` is a synchronous
file-backed read. The fetch runs where the Compactor runs — launched from a
boundary poke, single-flight, unawaited, total (never rejects). A slow or hung
search delays nothing on air; a listener with no network gets the pre-spec-13
radio plus one debug line per stale boundary.

### 3.2 Not every batch

The roll exists because of one by-ear rule: a topic on every batch reads as a
segment, and a segment is what murmur is not. `maxGap` still bounds the
silence so a fresh pool is not ignored forever. The counter is per process;
it does not persist — a restart may offer on the first batch, which is fine.

### 3.3 The fetch prompt (contract half, code-owned)

`buildFetchTopicsPrompt` states, in this order: the language the gists must
be written in; the timezone with "weight what matters there, international as
the fallback"; today's date and the freshness rule (**today or yesterday**
only); the titles to avoid (already in the pool); the privacy line (nothing
about private individuals, nothing that identifies a person who is not a
public figure); the output contract (call `submit_topics` once, 3–8 items,
each gist two to three spoken sentences a friend could say without reading
from a screen, no URLs, no outlet names). Then `RWT_POLICY_HEADER` and the
policy.

### 3.4 The taste half (listener-owned)

`DEFAULT_RWT_POLICY`: the categories — news, tech, entertainment, sports —
and the weighting: mostly what is happening where the listener is, some of
what the whole world is talking about, nothing that needs a screen to make
sense of, nothing that is only a number, prefer the human-scale angle of a
big story over the headline. Seeded to `rwt-policy.md` on first use so it is
discoverable; read fresh on every fetch.

### 3.5 Language and region without a store

Language: the listener's override, else the persona's own word. The persona
is the record once the install is past its first run — the machine locale
that seeded it may have changed since (measured: a persona reading "Always
speak in Chinese (Mandarin)" on a machine whose `LANG` is now `en_US`, where a
locale read would have produced English gists). Region: `Intl.DateTimeFormat().resolvedOptions().timeZone`, read at
fetch time, in the prompt only. A listener in Tokyo with a French persona gets
French gists about what matters in Japan, which is the intended reading of
"language is not region".

### 3.6 Failure posture

| failure | effect |
|---|---|
| fetch throws / times out / no tool call | one debug line; pool unchanged; retried at a later stale boundary |
| malformed pool file | empty pool; overwritten by the next successful refresh |
| pool write fails | the take still stands in memory; one debug line (`rwt.pool not persisted`), never a throw on the talk path |
| no network at all | never offers; radio unchanged |
| `rwtEnabled` false | no roll, no offer; the refresh still keeps the pool warm so turning it back on is instant |

---

## 4. Dependencies

- Spec 03-01 (`runTask`, the in-process MCP tool seam) — extended with
  `builtins`.
- Spec 04 (`generateTalks` serves both the cold path and the refill) — the
  one call site the roll hangs on.
- Spec 11 (`change_settings`) and spec 12 (the settings store) — the knob.
- Spec 05 §3.5 for where `ContextPack` fields are assembled.

---

## 5. Acceptance criteria

### Unit (deterministic; all green in this PR)

1. Pool: expired entries drop on load; `take()` marks and persists; a second
   `take()` never returns the same id; `refreshDue` obeys `staleHours`.
2. Roll: with injected random, `minGap` holds, `maxGap` forces, `p` decides
   in between.
3. Prompt: `rwtLine` renders the title and gist with the usage lines when
   present, nothing when absent; an `anchor:*` or `coda` cue never carries it.
4. Harness: `agenticOptions` with `builtins: ['WebSearch']` lists it in both
   `tools` and `allowedTools`; the default lists neither.
5. Knob: `--no-rwt` → `rwtEnabled: false`; the store seeds it from Config;
   `change_settings({ rwt: false })` lands `rwtEnabled: false`.
6. Director: a stub/fake `rwt` dep is offered once per non-anchor, non-coda
   batch and never on those two.

### Real seam (done once in this PR, evidence in the PR body)

7. A real `fetchTopics` through the SDK writes ≥ 3 entries into
   `cache/rwt.json`, gists in the requested language, dated today/yesterday.
8. A `make dev` run shows `rwt.offer <id>` in `.dev/dev.log`, and the beat
   generated from that batch is read against the entry's gist.

### By-ear (open — one issue)

9. A mentioned topic sounds like a friend bringing up something they read,
   not a bulletin.
10. The proportion feels right — present but not every stretch.
11. The gist language matches the persona's spoken language.
12. Turning it off by typing works and the host does not keep mentioning news.

---

## 6. Open questions

- Whether the refresh should also fire when the pool is *empty of unused
  entries* rather than only when stale. Left as the stale-only rule until
  by-ear says the pool runs dry.
- Whether `maxGap` should count aired beats rather than batches. Batches are
  what `generateTalks` sees; aired beats would need the roll to move into the
  buffer.
