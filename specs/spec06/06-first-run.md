# spec/06 · first-run & relationship — persona seeding, profile bootstrap, relationship memory

> **Status**: **Built 2026-07-29.** All three slices land with the unit suite
> green; slices A and B were smoke-tested through the real SDK (a generated
> persona and a two-section `profile.md` verified from the files, never the
> model's report). Where the code refined this design: `FirstRunDeps` also
> carries `model` (the good tier, §3.3) and an optional `ccRoot` (injectable
> data root, defaulting to `paths.claudeCodeRoot()`); `ProfileWritable` lives in
> `src/first-run.ts` beside its consumer, the way `CompactionStore` lives in
> `compaction.ts`; slice B is offered only when onboarding actually produced a
> persona, so a run that skipped every question is not asked a fourth question.
> The by-feel constants (`PERSONA_CHAR_CAP`, `MAX_SESSIONS`, `MAX_READ_CHARS`,
> `BOOTSTRAP_MAX_TURNS`) remain tunable (§6).
> **Owed**: criterion 12's first-run pass in a real terminal (user-run), and the
> eval-track judgment of whether a bootstrapped profile is *accurate*.
> **Part**: What happens the **first time** murmur runs (there is no persona and
> no profile yet), plus the one memory extension that makes the radio feel like
> it knows *us*, not just *you*. Master [`../DESIGN.md`](../DESIGN.md) §2.3
> (amended), §6 (memory tiers), §10 row 06.
> **Rescoped (2026-07-29)**: this spec **was** `persona-lifecycle` = "onboarding
> seed Q&A + persona evolution loop (observe → rewrite)". The evolution loop is
> **cut** (master §2.3, amended): the persona is a **stable, user-editable
> asset**; the tier-① **profile** is what grows, through machinery spec 05
> already ships. This spec therefore delivers three slices and **no new
> machinery loop**. It also **absorbs** the profile half of the retired spec 09
> (`claude-code-ingestion`) as slice B.
> **Amended (2026-08-25)**: the host's language is no longer hardcoded. The
> bundled seed named Chinese outright; it now carries a `{{language}}` slot and
> the default comes from the machine's locale, with English as the floor
> (§3.2). One boot-time read, no watcher — the persona remains the authority.
> **Milestone**: first run + relationship. Depends on spec 05 (landed).
> **Privacy boundary (master §3.1)**: everything here is **on-device**. The
> onboarding answers, the Claude Code transcripts read in slice B, `persona.md`
> and `profile.md` never leave the machine except inside the **already-sanctioned
> Claude-inference hop** — the same single network path the radio uses for every
> beat. This spec opens **no third hop** (§3.5 states exactly what text crosses
> it, and slice B is refused unless the user explicitly consents).
> **Conventions**: English; written for a coding agent. Design-level — mechanism
> and contracts, not final code. Prompt text centralized in `src/prompts.ts`; no
> CJK in source (master §0).

---

## 1. Goal & scope

### Delivers

1. **Slice A — first-run onboarding.** On a real (persistent) run where no
   persona file exists at its memory-dir home, the host **asks ~3 seed
   questions** through the CLI Host, one Brain call turns the answers into a
   **persona seed**, and that text is written to `<memoryDir>/persona.md`. The
   radio then boots on it, exactly as spec 01 boots on the bundled seed today.
2. **Slice B — Claude Code history → **profile** bootstrap** (absorbed from the
   retired spec 09). **Optional, explicitly consented, one-shot**: a background
   task on the spec-03-01 harness seam reads the user's local Claude Code data
   (`~/.claude/projects/*` session transcripts, `~/.claude/CLAUDE.md`) and
   produces an initial **profile** — never a persona — written through the
   existing spec-05 memory seam. Declining is a first-class outcome: the profile
   then accrues slowly through normal compaction.
3. **Slice C — a relationship section in the profile.** The spec-05 compaction
   prompt is extended so `profile.md` maintains a **"relationship & style"**
   section (what tone lands with this listener, running jokes, callback-worthy
   moments) alongside the existing listener facts. **Zero new mechanism** — a
   prompt/contract extension of the compaction call spec 05 already makes.

### Out of scope (explicit non-goals)

- **Persona auto-evolution / any machine rewrite of `persona.md`** — cut by
  master §2.3 (amended 2026-07-29). After the seed is written, murmur **never**
  writes that file again; the user edits it in an editor and the next load picks
  it up. A *user-invoked* "propose a persona diff, I approve it" flow is a noted
  future path, **not v1**, and not designed here.
- **Persona inference from Claude Code history** — cut with the same decision.
  Slice B produces a profile only. A bootstrap that tried to *guess a character*
  is exactly the mean-reverting failure mode §2.3 rejects.
- **Claude Code data as an activity signal** — cut; spec 07 senses activity
  locally (keyboard idle), which is cheaper and more accurate (master §10 row
  09).
- **New memory tiers, stores, or file formats.** Slices B and C write through
  the spec-05 tier-① surface; the on-disk layout of spec 05 §3.1 is unchanged.
- **A re-onboarding UX, persona editor, or setup wizard.** Editing is "open the
  file". One explicit CLI re-entry exists for slice B (§3.4); nothing more.
- **ASR** — onboarding is typed (master §3.4).
- **Anything network beyond the Brain hop** (master §3.1).

---

## 2. Contracts / seams

### 2.1 First-run detection replaces the unconditional seed copy

Today `resolvePersonaPath(config, persistent)` (`src/app.ts`, spec 05 §3.2)
copies the bundled seed to `<memoryDir>/persona.md` when that file is absent, and
loads from there afterwards. This spec keeps the *homing* rule and replaces the
*content* of the "absent" branch:

| Case | Behavior |
|---|---|
| `persona.md` exists | load it (unchanged — this is every run after the first) |
| absent, persistent run, interactive | **run onboarding (slice A)** → write the generated seed → load it |
| absent, persistent run, onboarding skipped / declined / failed / non-interactive (EOF) | **copy the bundled seed** (today's behavior) → load it |
| stub run (`--brain stub`) | load the bundled seed directly; nothing is written (spec 05 §3.7 stub isolation) |

The seam is one function in a new `src/first-run.ts`:

```ts
export type FirstRunDeps = {
  host: Host                  // the same CLI Host the Director uses (spec 01)
  brain: Pick<Brain, 'seedPersona'>
  harness?: Harness           // slice B only; absent = slice B never offered
  memory: ProfileWritable     // §2.4
  memoryDir: string
  fallbackSeedPath: string    // config.personaPath — the bundled seed
}

// Returns the path to load the persona from. Total: never throws, never blocks
// the radio; every failure degrades to the bundled seed.
export function isFirstRun(memoryDir: string): boolean
export async function runFirstRun(deps: FirstRunDeps): Promise<string>
```

- **Reads are serialized and EOF-safe**: onboarding uses `lineReader(host)` from
  `guide.ts` (spec 03-03) — the consuming, chained reader whose EOF resolves
  `''`. A piped/non-interactive run therefore *declines every question* and falls
  through to the bundled seed instead of wedging startup. This is the same
  primitive the music setup guide already uses; no second input mechanism.
- **Placement in the boot sequence**: after the startup checks (spec 03-02 §2.4)
  and **before** the banner and the first segment. Onboarding is the first thing
  a new user sees; the radio does not start talking over the questions.
- **Interruption**: Ctrl-C during onboarding exits without writing anything —
  the next run is still a first run.

### 2.2 `Brain` — one additive method (slice A)

```ts
// Turn the onboarding answers into a persona seed: a complete System Prompt
// for the host, in the listener's own language. Pure text generation, no tools
// (same posture as spec 05's compactProfile).
seedPersona(answers: readonly SeedAnswer[]): Promise<string>

export type SeedAnswer = { readonly question: string; readonly answer: string }
```

- `StubBrain` returns the bundled seed text unchanged (offline no-op), so a stub
  run's onboarding is inert and testable.
- The prompt lives in `src/prompts.ts` (`buildSeedPersonaPrompt`,
  `SEED_PERSONA_SYSTEM_PROMPT`), English scaffolding, with a hard character cap
  (§3.3).
- *Rejected alternative*: running the seed generation as a harness task
  (03-01). There is nothing to search or read — it is a one-shot text fold, so
  the tool-less `Brain` seam is the smaller surface. Slice B, which genuinely
  must *choose what to read*, is the one that earns the harness.

### 2.3 Slice B — a harness task with a path-scoped reader

Slice B is a bounded agentic task on the **existing** `Harness.runTask<T>` seam
(spec 03-01 §2.1) — the second capability hung on it after music discovery. It
earns the harness because Claude Code history is large and uneven: the model must
*select* which sessions are worth reading rather than have everything shipped
into one prompt.

```ts
type ProfileBootstrap = { profile: string }   // what the terminal tool finishes with
```

Tools handed to the task (all murmur-owned, in-process, zod-validated args):

| Tool | Purpose | Bound |
|---|---|---|
| `list_sessions()` | metadata only for the CC data root: project name, session id, last-modified, byte size | at most `MAX_SESSIONS` newest entries; **stat-only** — no session file is opened (a turn count would mean reading every history in full, synchronously, in the live radio's process) |
| `read_session(id, maxChars?)` | the transcript text of one session id from `list_sessions` — the **speaking turns only**, extracted from the JSONL; a file that yields none is refused rather than sent raw (its tool payloads and pasted buffers are exactly what the extraction drops) | `maxChars` capped at `MAX_READ_CHARS`; ids not produced by `list_sessions` are refused |
| `read_instructions()` | the user's `~/.claude/CLAUDE.md`, if present | one file, capped |
| `submit_profile(profile)` | **terminal** — finishes the task with the initial profile text | `PROFILE_CHAR_CAP` (spec 05, `src/prompts.ts`) |

**Trust boundary (this is a read of the user's private data — do not simplify it
away):** the reader tools resolve every path with `realpath` and refuse anything
that escapes the CC data root; ids are opaque handles minted by `list_sessions`,
not caller-supplied paths; nothing outside the root is reachable, and there is no
write tool. The root is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`; resolved
in `paths.ts` (spec 05 §2.3 — the single module allowed to resolve user-level
paths).

### 2.4 The write-through surface (slice B)

Slice B writes the profile through spec 05's tier ①, not around it:

```ts
// The spec-05 store surface slice B needs. PersistentMemoryStore already has
// profile(); writeProfile is the additive impl-level method (deliberately NOT
// on the MemoryStore contract — the Director never writes the profile).
export interface ProfileWritable {
  profile(): string
  writeProfile(text: string): void   // atomic temp+rename, spec 05 §3.1
}
```

**Apply rule**: write **only if `profile()` is still empty** at apply time.
Rationale: the bootstrap runs in the background while the radio is already on
air, and spec 05's compaction may land first on a long first session. A
non-empty profile means the listener picture has already started forming — the
bootstrap then logs and drops its result rather than clobbering it.

### 2.5 Slice C — the compaction contract, extended

No new call, no new field. `COMPACTION_INSTRUCTION` (`src/prompts.ts`, spec 05
§3.6) is extended so the returned profile carries **two labelled sections**:

```
(About the listener)   <- today's content: identity, preferences, recurring topics, standing context
(Relationship & style) <- new: what tone lands with this listener, how they talk back, running jokes,
                          moments worth calling back to, subjects to handle lightly
```

- The profile stays **one file, one string, one cap** (`PROFILE_CHAR_CAP`) —
  rendering into the pack is unchanged (spec 05 §3.5: the profile is a stable
  block adjacent to the persona). The cap is a by-feel constant and may need
  raising once two sections share it (§6).
- The instruction must state that the relationship section is **observational,
  not directive** — it records what has worked, and the persona (not the
  profile) still owns who the host is. This is the guardrail that keeps slice C
  from becoming persona evolution through the back door.

---

## 3. Design

### 3.1 Slice A — the first-run flow

1. `isFirstRun(memoryDir)` → `<memoryDir>/persona.md` does not exist.
2. The host prints a short framing line (what murmur is, that these questions
   shape the voice, that an empty line skips a question).
3. Ask the **~3 seed questions** in order (§3.2), reading each answer with the
   serialized reader. An empty answer = skipped.
4. If **every** answer is empty (including the non-interactive/EOF case): log
   one line, copy the bundled seed, done — no Brain call.
5. Otherwise `brain.seedPersona(answers)` → persona text → atomic write to
   `<memoryDir>/persona.md` (temp + rename in the same directory, spec 05 §3.1
   discipline) → the host confirms with the persona's first line and tells the
   user the file path so they know where to edit it later.
6. Any failure (Brain error, empty/degenerate result, write error) → one info
   line + bundled-seed fallback. **The radio always boots.**

### 3.2 The seed questions (design-level content)

Exactly three, short, answerable in one line, in this order. Wording lives in
`src/prompts.ts`; what they must elicit is fixed here:

1. **Who is listening** — what to call you, and what your days usually look like
   (work, study, hours). *Feeds*: name/address form, the host's assumptions
   about context.
2. **What you want on the air** — company while you work / someone to think out
   loud with / late-night talk / mostly music. *Feeds*: the balance the host
   strikes and what it talks about unprompted.
3. **How you like to be talked to** — tone (dry, warm, chatty, quiet), and the
   language it should speak. *Feeds*: voice, register, and the output language
   (master §0: the prompt scaffolding is English; the persona sets the spoken
   language).

**The output language is decided here, once.** No language is hardcoded
anywhere in the source. `detectLanguage()` (`src/locale.ts`) reads the machine's
message locale once at boot and names it in English (`zh_TW` ->
`Traditional Chinese`, `ja_JP` -> `Japanese`, `sr_RS@latin` ->
`Serbian (Latin)`; the region is dropped, the script kept only where it departs
from the language's default, including the script a glibc `@latin`/`@cyrillic`
modifier selects). Precedence is POSIX: `LC_ALL`, then `LC_MESSAGES`, then
`LANG`, and the **first one that is set is the answer** — a set `LC_ALL=C`
overrides a localized `LANG` rather than falling through to it. `C`, `POSIX`,
an unnameable tag, or an environment that sets none of the three all yield
`English`, the floor. That name is the **default**, and the seed
persona prompt ranks it last: what the listener **asked for** wins, then the
language they **wrote their answers in**, then the detected default. The
generated persona states its language explicitly, and murmur never rewrites the
file — so nothing re-reads the locale afterwards. Changing the language later
means editing `persona.md`; changing the default means the environment murmur
launches in.

The bundled seed (`src/prompts/persona-seed.md`) therefore names no language of
its own: it carries a `{{language}}` slot, filled by `renderPersona()`
(`src/persona.ts`) wherever the seed is read or lands at the listener's home. A
persona that states its own language has no slot, so filling one is a no-op.

The generated persona must be a **complete standalone System Prompt** — the
bundled seed is the shape reference, so a hand-written seed and a generated one
are interchangeable to spec 01's loader.

### 3.3 Persona generation bounds

- One Brain call on `config.model` (the good tier): it happens **once per
  install** and every later beat inherits its quality.
- Hard cap `PERSONA_CHAR_CAP` (~1200 chars, by-feel, module constant next to
  `PROFILE_CHAR_CAP`). A persona that outgrows the cap eats the cacheable stable
  prefix on every call (master §7 pillar 4).
- The prompt instructs: write the host's character, not a summary of the
  answers; keep it time-neutral (spec 04 §3.4 supplies the time-of-day mood
  cue); do not invent biography the answers do not support; return only the
  persona text.
- Degenerate output (empty, or under a floor length) is treated as failure →
  bundled seed.

### 3.4 Slice B — consent, execution, and the one-shot rule

**Offered during first run**, immediately after the persona is written, and only
when a harness is available (a real brain). One prompt, `[y/N]`, default **no**:

- The offer states plainly: it reads your local Claude Code history to get to
  know you; the transcripts stay on this machine, but **excerpts it chooses to
  read are sent to Claude** as part of the analysis — the same hop the radio
  already uses for every beat; it runs once, in the background; skipping is fine
  and costs nothing but time (the profile then accrues through normal
  compaction).
- Anything but an explicit yes = declined. Declining is **not** recorded and
  **never re-asked** — murmur does not nag. The re-entry for a later change of
  mind is an explicit CLI action, `murmur --bootstrap-profile` (mirroring
  `--setup-music`, spec 03-03), which runs the same task standalone.
- **No new state file marks "already offered."** The existence of `persona.md`
  is the first-run marker, and the offer only ever happens on a first run.

**Execution** (accepted case):
- The task is launched **in the background after the radio is on air** — the
  same posture spec 05 §3.6 uses for startup catch-up compaction. It must never
  delay the first beat.
- `harness.runTask<ProfileBootstrap>` with the §2.3 tools, `maxTurns` bounded
  (~12), `model = config.model`. One-shot: no retry loop, no schedule.
- On finish: apply per §2.4 (write only if the profile is still empty), then one
  info line ("got a first sense of you from your Claude Code history"). On
  `null` (turn budget exhausted) or any error: one dev-log line and nothing
  else. A failed bootstrap costs the accelerator, never the radio.
- **Shutdown**: an in-flight bootstrap is dropped, like the other background
  work (STATUS: "no cancellable-task seam"). Nothing half-written can result —
  the write is a single atomic apply at the end.

**What the model is told to produce**: a listener profile in the *same shape*
compaction maintains (§2.5's two sections), so the first compaction merges into
it instead of fighting it. It is instructed to record durable signal (domains
they work in, tools and languages, how they phrase things, recurring problems,
working hours) and to **exclude** secrets, credentials, employer-confidential
detail, and anything that reads as surveillance rather than acquaintance.

### 3.5 Privacy boundary — exactly what crosses the network

Per master §3.1 there are two hops, and this spec adds none:

| Data | Where it lives | What crosses the Claude hop |
|---|---|---|
| onboarding answers | RAM, then folded into `persona.md` | the three answers, inside the `seedPersona` call |
| `persona.md` | `<memoryDir>` (local) | as the system prompt of every Brain call (already true in spec 01) |
| CC transcripts / `CLAUDE.md` | the user's `~/.claude` (local, read-only) | **only** the excerpts the model reads via the capped reader tools, during the one consented bootstrap task |
| `profile.md` | `<memoryDir>` (local) | as the stable-prefix profile block (already true in spec 05) |

Slice B is the only part that reads data murmur did not create, and it is gated
on an explicit yes.

### 3.6 Slice C — what changes and what does not

- **Changes**: the compaction instruction text, and the acceptance test that
  pins section structure.
- **Does not change**: the compaction trigger, cadence, single-flight, watermark
  arithmetic, failure posture, cap enforcement, pack rendering, or the store.
  Slice C is a prompt edit with a test — the smallest possible delivery of "it
  remembers how we get on".

### 3.7 Cost

| Slice | Calls | When |
|---|---|---|
| A | 1 (`seedPersona`) | once per install |
| B | 1 bounded agentic task (~12 turns max) | once, opt-in |
| C | **0 extra** | rides the compaction call spec 05 already makes |

### 3.8 Stub / offline posture

`--brain stub` (STUB=1) runs none of this: no persona home, no persistent
memory, no harness (spec 05 §3.7 stub isolation). Unit tests drive the slices
with fakes and a `tmp_path`-rooted store — model-free and fast.

---

## 4. Dependencies

- **spec 05** (landed) — the persona home (`<memoryDir>/persona.md`, §3.2), the
  tier-① profile file and its atomic write discipline, and the compaction call
  slice C extends. This spec adds `writeProfile` to the persistent store
  (impl-level, additive) and extends the compaction prompt.
- **spec 01** — the `Host` seam (questions/answers) and the persona load path;
  `Brain` gains `seedPersona` (additive, existing call sites untouched).
- **spec 03-01** — `Harness.runTask` for slice B; **spec 03-03** — the
  `lineReader` / consent-prompt pattern reused verbatim, not reinvented.
- **Not** spec 07: nothing here needs activity or anchors, and spec 07 needs
  nothing here. They are independently buildable.

---

## 5. Acceptance criteria (feature level)

Unit (fakes / `tmp_path`, model-free) unless noted.

1. **First-run detection**: with no `persona.md` in the memory dir, a persistent
   run enters onboarding; with one present, it does not (loads and boots).
2. **Onboarding writes a persona**: three canned answers + a fake brain →
   `<memoryDir>/persona.md` contains the fake's output, and the run loads that
   file (not the bundled seed).
3. **Skip / non-interactive**: all-empty answers, and a closed stdin (EOF),
   both produce the **bundled seed** at the persona home with no Brain call, and
   the radio still boots.
4. **Failure degrades**: a throwing `seedPersona`, an empty result, and a write
   failure each fall back to the bundled seed with one info line and no crash.
5. **Persona is never rewritten afterwards**: a run whose persona home exists
   performs **zero** writes to `persona.md` (assert on the filesystem, not on
   intent) — the §2.3-amended invariant, pinned as a test.
6. **Slice B consent gate**: declining (any non-`y`, and the EOF case) runs
   **no** harness task; accepting runs exactly one, with the music task
   unaffected.
7. **Slice B sandbox**: `read_session` refuses an id not minted by
   `list_sessions` and any path resolving outside the CC data root (symlink
   escape included); no tool in the set can write.
8. **Slice B apply rule**: a finished bootstrap writes the profile when the
   store's profile is empty; with a non-empty profile it logs and writes
   nothing. A `null` result or a thrown error writes nothing and never
   propagates.
9. **Slice B is off the live loop**: with a bootstrap task that never resolves,
   the Director still airs its segments (verified on fakes — the same shape as
   spec 04's no-block criterion).
10. **Slice C structure**: the compaction prompt requests both sections; a fake
    brain returning a two-section profile is stored verbatim and renders as the
    single stable profile block in the pack (spec 05 §3.5 assertions still
    pass); the cap is still enforced.
11. **Stub isolation holds**: a `--brain stub` run touches neither `memoryDir`
    nor the persona home (spec 05 §5.8 unchanged).
12. **Real smoke** (murmur-smoke, on-demand): a throwaway `MURMUR_HOME` → first
    run asks the three questions, a real persona lands on disk and the radio
    speaks in it; with consent, the bootstrap produces a plausible
    `profile.md`. Verified from the **files and `.dev/dev.log`**, never the
    model's self-report (CLAUDE.md red line).

---

## 6. Open questions

- **Question count and wording (slice A)**: three is the starting guess — enough
  to shape a voice, short enough that nobody bails. Tune by feel on real first
  runs.
- **Profile cap with two sections (slice C)**: `PROFILE_CHAR_CAP = 1500` was
  sized for one section. Watch whether the relationship section starves the
  listener facts; raising it trades against the cached stable prefix.
- **Bootstrap depth (slice B)**: `MAX_SESSIONS` / `MAX_READ_CHARS` / `maxTurns`
  are unmeasured. Too shallow reads only the newest project; too deep burns a
  large one-time cost.
- **Profile quality is eval-track** (master §10.3): whether the bootstrap's
  profile is *accurate* and whether the relationship section is *useful* are
  by-feel/eval judgments, not unit assertions. The unit layer pins mechanism
  only.
- **The user-invoked persona diff** (master §2.3 amended, future path): if it is
  ever built, it belongs here as a fourth slice — brain proposes, user approves,
  never silent. Not v1; recorded so the idea is not lost.
