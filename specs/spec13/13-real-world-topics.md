# spec/13 · real-world-topics — an off-loop pool of things that actually happened

> **Status**: **Built 2026-09-03** (PR #203); **redesigned 2026-09-04**
> (PR #209): the taste file is gone, the profile's *About the listener*
> section steers the fetch, and a told topic is a ledger row the fetch
> avoids. Pool, roll, fetch task, prompt rendering, the settings knob and the
> steer field stand as built; the unit suite is green; a real `fetchTopics`
> was smoked through the SDK with the profile block in the prompt and the
> ledger titles in the avoid list, and a real `rwt.offer` was read out of
> `.dev/dev.log` against the beat it produced. **§5's by-ear criteria are
> open** — user-run, tracked as one issue
> ([#202](https://github.com/wine-fall/murmur/issues/202)).
> **Part**: Delivers the "say real things" line of
> [`../../ROADMAP.md`](../../ROADMAP.md), which deletes a line once it lands —
> so this spec, not that file, is the record. Gives the self-initiated talk
> task material from outside its own head:
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
> edited here. What leaves the machine for the search task: a language name,
> a timezone name, the titles already in the pool and the ledger's recent
> real-world titles, and the profile's *About the listener* section — the
> one section, never *Relationship & style* — under the code-owned line
> "search for what they follow, never for them" (§3.4). The profile already
> leaves for the talk brain on every batch; this is the same text on a
> second, bounded task.
> **Conventions**: English; written for a coding agent. Mechanism and
> contracts, not final code. Prompt text centralized in `src/prompts/`; no
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
4. **The prompt seam**: `ContextPack.rwt` and `rwtLine()` — one item on the
   desk, brought in *as a host does*: named, said in a sentence or two, then
   carried past. The anchor beats and the coda never carry it.
5. **The knob**: `rwtEnabled` in settings (default on), `--no-rwt`, and a
   `rwt` field on `change_settings` so "stop with the news" typed to the radio
   turns it off.
6. **The taste, from the profile**: the fetch reads the profile's *About the
   listener* section at refresh time and leans the search toward what it
   says the listener follows (§3.4). Code owns the contract (shape,
   freshness, dedupe, privacy); the listener's half is what memory already
   knows, and it grows, fades and forgets with the profile — no file, no
   second store.
7. **A ledger footprint**: a topic taken for a batch is `recordEvent('rwt',
   title)`; the fetch is told the ledger's recent titles beside the pool's,
   so a story that outlives the pool's 48 h is not fetched and told again
   (§3.7).

### Out of scope (explicit non-goals)

- **A live lookup on the talk path.** Picks already run 80–190 s in a bad
  session; anything network-bound at `generateTalks` would break the spec-04
  look-ahead. Talk reads the pool and nothing else.
- **Storing region.** Region is read from the system timezone at fetch time
  and written into the fetch prompt; it is never persisted and never asked
  for. Language is not region (§3.5).
- **A new onboarding question, a pane row, or a TUI surface.** The knob is
  reachable by flag, file, and the conversation. The pane stays at spec 12's
  eight items.
- **Fact-checking, citations, or source attribution on air.** The host may
  mention what it read; it does not read out URLs or outlets.
- **Personal or private material.** The fetch prompt forbids it outright
  (§3.3); nothing in the pool is about the listener, and the profile text
  the fetch carries steers the search, never becomes its subject (§3.4).
- **A listener-editable taste file.** The first build seeded
  `$MURMUR_HOME/rwt-policy.md` in the music-policy shape. Removed before it
  ever shipped in a version: a file nobody is told about is not a knob
  (seeded with one debug line, named nowhere a listener reads), and its
  once-only seed (`wx`) froze the policy at install time so a later default
  never reached an installed copy — the sibling `music-policy.md`, same
  shape, measured byte-identical to its template after nine days and 28
  sessions. `music-policy.md` itself is left alone: it has shipped, and a
  music taste is likelier to be edited than a topic taste.
- **Reaction tracking** (did the listener type after a real-world beat) and
  a negative-constraint steer ("no sports") — the signal is too dirty and the
  machinery too heavy for what #202 has shown so far.
- **The stub brain.** `StubBrain.fetchTopics` returns nothing; an empty pool
  never offers, so a stub run is exactly its pre-spec-13 self.

---

## 2. Contracts / seams

### 2.1 The pool entry and the file

```ts
// src/brain/rwt.ts
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
  readonly avoid: readonly string[] // pool titles, then the ledger's recent rwt titles
  readonly follows: string        // the profile's (About the listener) section; '' = none
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
- `rwtLine(ctx)` renders the item **on the desk for this stretch**, then the
  usage: name the thing — the title, who, where, when — say what happened in
  a sentence or two and what you make of it, then carry on; one item, in the
  host's own voice; not a newsreader's rundown, not a "here is the news"
  frame, not a list. The line is drawn on **register, never on content**: an
  earlier draft forbade "a headline read out" and let the host "leave it",
  and the measured result was the item scrubbed to mood (a Netflix release
  became "a friend wanted to watch a show") — the #44 attractor with a fig
  leaf. Absent → renders nothing.
- `DEFAULT_RWT_POLICY` / `RWT_POLICY_HEADER` / `buildFetchTopicsPrompt(req)`
  / `aboutSection(profile)` live in `src/prompts/`. The policy is built in;
  the per-listener half of the taste is `req.follows` (§3.4).
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
only); the privacy line (nothing about private individuals, nothing that
identifies a person who is not a public figure); the titles to avoid (the
pool's, then the ledger's — §3.7); the output contract (call `submit_topics`
once, 3–8 items, each gist two to three spoken sentences a friend could say
without reading from a screen, no URLs, no outlet names); then, when the
profile has one, the *What the listener follows* block (§3.4); then
`RWT_POLICY_HEADER` and `DEFAULT_RWT_POLICY`.

### 3.4 The taste half: the profile, not a file

`DEFAULT_RWT_POLICY` is built in: the categories — news, tech,
entertainment, sports — and the weighting: mostly what is happening where
the listener is, some of what the whole world is talking about, nothing that
needs a screen to make sense of, nothing that is only a number, prefer the
human-scale angle of a big story over the headline, and **keep the hard
nouns** — a title, a name, a place, a date — because they are what make the
thing real said aloud.

The per-listener half is the profile. Without it every install with the
same language and timezone searched for the same things. `profile.md`
already grows (compaction, spec 05 §3.6), fades (`[seen]` tags, spec 05-01
§3.3) and forgets (`forget_memory`, spec 05-01 §3.5), so the taste rides
along for free and keeps no state of its own:

- `aboutSection(profile)` cuts out the *(About the listener)* section of the
  two-section shape both profile writers produce (`PROFILE_SHAPE`, spec 06),
  bookkeeping tags stripped. **Only that section.** *(Relationship &
  style)* is an observation of tone, and tone is not a search term. A
  profile without the labelled section yields `''` — the conservative
  reading, since the text leaves for a search task.
- `buildRwt` reads it at **fetch time** (`memory.profile()` inside the
  `request` closure), so a compaction or a forget lands on the next refresh.
- The prompt renders it as a *(What the listener follows)* block before the
  policy, with the line the code owns and no listener text can loosen:
  *"Lean the search toward these. Search for what they follow, never for
  them, and never for anything that identifies them."*
- Empty → the block is not rendered, and a new listener (or one who declined
  the spec-06 slice-B bootstrap) gets exactly the pre-change fetch.

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

### 3.7 The ledger footprint

rwt was the one content source with no ledger row: a song played is
`recordEvent('song')` and the pick avoids the last 32 (`AVOID_DEPTH`, spec
05 §3.5); a talk beat's topic key is `recordEvent('topic')` and feeds
`coveredTopics`. A real-world item's anti-repeat lived only in
`cache/rwt.json`'s `used` mark — on an entry that expires in 48 h, in a
directory that is rebuildable by design. A story that runs longer than that
(a series airing, a tournament, an argument still going) was fetched again
as new and told again.

- `LedgerKind` gains `'rwt'`; `MemoryStore` gains `recentRwt(n)` beside
  `recentSongs` — the Director's tier, unlike the impl-level `recentEvents`.
- The Director ledgers the **title** at **take** time, in `generateTalks`
  right after `offer()` — the same moment the pool marks it `used` (§2.1),
  so the two records agree on when a topic is spent. Not at air time: a
  batch generated and discarded still burned its topic.
- The fetch is told `pool.titles()` then the ledger's last
  `RWT_AVOID_DEPTH` (32) rwt titles, deduplicated, in `avoid`; a title the
  fetch was told to avoid and returned anyway is dropped before `merge`.
  32 is the music list's settled depth — 8 brought a favourite back every
  other session — and a topic is offered far less often than a song plays,
  so 32 here spans weeks of sessions, long enough to outlast a running
  story, at one prompt line each on a background task.
- `forget_memory` does **not** touch the ledger, by design (spec 05-01
  §3.5 removes history rows and profile lines). What was heard stays
  avoided; what the listener stopped following leaves the profile and so
  leaves `follows` (§3.4). "Don't bring that up again" is served by the two
  together, not by erasing the record of having said it.

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
7. Taste: `aboutSection` returns the About section alone, tags stripped,
   and `''` for a profile without the labelled section; the fetch prompt
   renders the *(What the listener follows)* block with the privacy line
   before the policy, and nothing for an empty `follows`; `buildRwt` reads
   the profile at fetch time and seeds no file under the home.
8. Ledger: `recentRwt` on both stores, persisted across instances; an offer
   ledgers the title once and a null offer none; the fetch's `avoid` is the
   pool's titles then the ledger's, and a covered title returned is not
   merged.

### Real seam (done once in this PR, evidence in the PR body)

9. A real `fetchTopics` through the SDK writes ≥ 3 entries into
   `cache/rwt.json`, gists in the requested language, dated today/yesterday;
   the prompt it ran carries the profile block and the ledger titles, and
   its WebSearch queries are about what the listener follows, not the
   listener.
10. A `make dev` run shows `rwt.offer <id>` in `.dev/dev.log`, the beat
    generated from that batch is read against the entry's gist, and the
    title lands in `ledger.jsonl` as `kind: "rwt"`.

### By-ear (open — one issue)

11. A mentioned topic is named — the title, who, where — and said the way a
    host says it, not a newsreader: one item, no rundown, no list.
12. The proportion feels right — present but not every stretch.
13. The gist language matches the persona's spoken language.
14. Turning it off by typing works and the host does not keep mentioning news.
15. Over a week, the pool leans toward what the profile says the listener
    follows, and a story already told is not told again as new.

---

## 6. Open questions

- Whether the refresh should also fire when the pool is *empty of unused
  entries* rather than only when stale. Left as the stale-only rule until
  by-ear says the pool runs dry.
- Whether `maxGap` should count aired beats rather than batches. Batches are
  what `generateTalks` sees; aired beats would need the roll to move into the
  buffer.
