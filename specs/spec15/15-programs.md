# spec/15 · programs — every minute on the air belongs to a program

> **Status**: **Built 2026-10-15** on branch `box/programs` (stacked on the
> usage-logging change). Unit suite green; a real headless brain smoke
> measured tokens per 1000 spoken characters before and after (numbers in the
> PR body). **§5's by-ear criteria are open** — user-run.
> **Part**: replaces free talk. Supersedes the per-beat `topic` tag and the
> `recentTopics(12)` "don't repeat" cue (spec 05 §3.5 / §3.9), the per-batch
> real-world roll (spec 13 §2.3 / §2.4), the separate time-anchor beat (spec 07
> §3.4), the coda as its own call (spec 04 §3.3-C), and the settings cadence as
> the talk/music law (spec 03-02 §2.3 — it becomes the fallback). Adds one
> steer tool (spec 11 §2.1).
> **Milestone**: companion character. Depends on the harness (03-01), the
> look-ahead (04), memory (05), anchors (07), the steer task (11), the
> settings layer (12), real-world topics (13), taste (14).
> **Conventions**: English; written for a coding agent. Prompt text in
> `src/prompts/`; no CJK in source (master §0) — which is why program names
> live in code as English canonical titles and reach the air in the
> listener's language (§2.2).

---

## 1. Goal & scope

### Why

Measured on a real listener's air (two days): the host said the same thing
about osmanthus three times. Three causes, one shape:

1. The anti-repeat cue was the last 12 free-text topic tags. Between two
   osmanthus lines 14 other tags were recorded, so it scrolled out — and the
   tags never match anyway ("osmanthus suddenly", "Shanghai October
   osmanthus", "October osmanthus by chance").
2. The same 12-tag list, being mostly the current thread's own beats, pushed
   the host OFF its thread: talk jumped.
3. Talk had no material. Each refill got clock, scene, transcript and "carry
   on", so the host invented filler.

### Delivers

1. **Five programs** with fixed names, a target length and a shape (§2.1).
   All self-initiated air time belongs to one. The stock opener and the
   farewell (spec 04 §3.6) stay outside programs.
2. **Two-stage generation**: one planning call per program (thinking on)
   returns a subject, an angle and a factual outline whose points carry the
   material; then one beat call per outline point (§2.4, §2.5). The next
   program is planned in the background while the current one airs its last
   point.
3. **A code-side schedule**: a weighted draw with a two-program gap, weights
   reshuffled every three days, persisted under the murmur home (§2.3).
4. **Program-level anti-repeat**: each program ledgers its category and
   canonical subject; the planner is told the subjects in cooldown, and the
   returned subject is normalized and exact-matched in code (§2.6).
5. **Listener requests** by typing, through a `request_program` steer tool
   (§2.8).
6. **Resume** of an unfinished program within six hours (§2.7).
7. **The status line** `name · subject · 3/7` in the front-end (§2.9).

### Out of scope

- The lieflat rewrite of program beats (decision 16): tested offline in
  `scratch/` only; wiring waits for the user's verdict.
- A slash command for requests: requests are typed as ordinary lines.
- Time-of-day slots: the user rejected them; no time boundary cuts a program.
- An LLM judge for subject duplicates: normalization + exact match only.

---

## 2. Contracts / seams

### 2.1 The catalogue (`src/programs/catalogue.ts`)

| id | Canonical title (English) | Shape | Target | Points | Beats / point | Subject format | Cooldown |
|---|---|---|---|---|---|---|---|
| `puzzle` | Things I Can't Figure Out | philosophy, led by a QUESTION; several thinkers, Chinese and Western, agreeing or contrasting; each thinker's LIFE explains the view; tied to present reality and the listener | ~40 min | 6 | 3–4 | the lead thinker(s) | 30 days per lead thinker; the question is not deduped |
| `today` | This Thing Today | commentary on 2–3 real-world items: what happened + the host's view (spec 13's register, never newsreading) | ~20 min | 3 | 3–4 | — (the rwt ledger already dedupes items) | — |
| `record` | One Record | an artist or an album; the music follows the outline's tracks | ~30 min | 6 | 1–2 | the artist | 30 days |
| `poem` | Read One | a poem or a prose passage, read in the original, then the host's reading; where emotion lives | ~30 min | 4 | 2–3 | author·work | 180 days |
| `origin` | Where It Comes From | where one thing, word or custom comes from | ~30 min | 5 | 3–4 | one canonical noun | 90 days |

- Eligibility: `today` needs ≥ 2 fresh, unused real-world items and the rwt
  knob on. Every other program is always eligible.
- Present-day facts come ONLY from the real-world pool (spec 13). `puzzle`
  sees up to five fresh items as its reality tie-in without consuming them;
  long-run trends may come from the model's knowledge, never presented as
  latest data; no item fits → trends only. `today` TAKES 2–3 items at plan
  time (marked used and ledgered, spec 13 §3.7's take-time rule).

### 2.2 Names on the air

The catalogue holds English canonical titles. The air speaks the listener's
language, so the first plan of a program in a given language returns its
`name` as a short, literal rendering of the canonical title, written the way
a program title is written in that language (its title marks included). Code
freezes it per (language, program) in the schedule file; every later plan is
handed the frozen name and told to use it exactly. The words AROUND the name
vary every time — the host's own words, never a formula. A listener may edit
the frozen names in `programs.json` by hand.

### 2.3 The schedule (`src/programs/schedule.ts`) — 0 tokens

- **File**: `<data root>/programs.json` (`paths.ts: programsPath()`), zod-
  parsed, best-effort writes: `{ weights: {id: n}, shuffledAt, names:
  {language: {id: name}}, current?: RunState }`.
- **Weights** `[1,1,2,3,4]`, assigned to the five ids at random on first run
  and RESHUFFLED once `shuffledAt` is ≥ 3 days old.
- **Draw**: weighted over the eligible ids minus the last two aired (the
  `program` ledger, across sessions — simulated shares with the gap
  ~14/14/21/25/27%). If that leaves nothing, the gap is relaxed; the radio
  never goes silent for want of a program.

### 2.4 The planning call — `planTask` (`src/programs/plan.ts`)

A harness task, category `plan`, host system prompt (persona + craft), the
SDK's default thinking (on), `maxTurns` 2, one terminal tool:

```
submit_plan({
  name: string,           // the program's name on this air (§2.2)
  subject: string,        // canonical, in the program's subject format
  leads?: string[],       // puzzle only: the lead thinker(s)
  angle: string,          // the host's way in
  points: [{ title: string, content: string, track?: { artist, title } }]
})
```

`content` carries the actual material: original text, key facts, sources,
the host's argument. Facts and quotes are marked with their source; a quote
the planner is not certain of verbatim is given as a paraphrase and said so.
The prompt carries: the program's brief, target length and point count, the
date, the language, the frozen name when there is one, the listener's
*About* section, the taste digest (`record` only), the real-world items
(`today` / `puzzle`), and the subjects in cooldown for this category.

### 2.5 Beat generation — one point per call

`Brain.nextTalks(ctx, count)` is unchanged as a seam; `ContextPack.program`
carries the cue:

```
program?: {
  name, subject, angle,
  outline: string[],          // every point's title
  index: number,              // the point being said (0-based)
  point: { title, content },
  beats: [min, max],          // how many beats this call returns
  opening?: true, closing?: true,
  resumed?: true,             // first point after a relaunch (§2.7)
  returning?: true,           // the listener just spoke; back to the point
  afterSong?: true,           // the first beat goes out as a song ends
  anchor?: 'morning' | 'midday' | 'night', // folded into the opening
}
```

The beat prompt (`src/prompts/program.ts`) names the program and the current
point, shows the whole outline with the current point marked, and replaces
the free-talk head; the clock, scene, music status, profile, taste and the
grounding rules render as before. `count` is the point's `max`; the model
returns `min..max` beats.

### 2.6 Anti-repeat at the program level

- `TalkBeat.topic`, `ContextPack.coveredTopics`, `MemoryStore.recentTopics`
  and the `topic` ledger kind are DELETED.
- A program that opens (its first beat aired) appends a `program` ledger row:
  key = `{"id","label","keys":[...],"requested"?}`. `keys` are the normalized
  cooldown keys (leads for `puzzle`, the subject otherwise, none for
  `today`).
- **Normalization** (`normalizeSubject`): Unicode NFKC, lower case,
  traditional → simplified (opencc-js `t2cn`), strip whitespace,
  punctuation and symbols.
- **Two gates**: the planning prompt lists the category's in-cooldown labels
  to avoid; the returned keys are matched exactly against the in-cooldown
  keys. A hit → replan once with the hit added; a second hit → draw another
  category. No judge call. A dedupable plan with no usable key (a puzzle
  without `leads`) and an outline of fewer than two points are replanned the
  same way.
- The `program` rows are kept by age (200 days, past the longest cooldown),
  never truncated by count, so a busy station cannot outrun a cooldown.
- **Forget**: a forget that erased anything resets the desk — the run on the
  air, the plan behind it and the persisted copy are dropped (an outline is a
  copy of what the planner was told) and the next program is planned from the
  cleaned store. Legacy `topic` rows are still scrubbed by forget.
- `lastOnAir.topics` (spec 05 §3.4) reads the previous sitting's program
  labels.

### 2.7 The run: open, points, wrap, resume (`src/programs/desk.ts`)

`ProgramDesk` owns the current run and the next plan:

- `RunState = { plan, id, name, next, aired, openedAt, updatedAt }` — `next`
  is the index of the point to say; persisted to `programs.json` on open and
  after every point.
- A program **opens** with point 0 (the opening flag; a time anchor due at
  that boundary folds into it and is marked fired when it airs). It **ends**
  when its last point has aired; the last point carries the closing flag.
- The **next plan** is drawn and fired in the background as the current
  program's second-to-last point is generated: a plan took over a minute on
  the box music smoke, longer than one point, and starting at the last point
  left ~40 s of dead air when no song followed it. The run on the air counts
  in the successor's gap and cooldown even before its first beat ledgers it.
- **Resume**: on boot, a persisted run with `next < points` and `updatedAt`
  within 6 h resumes at `next` with `resumed`; older is dropped (what aired
  already counts for cooldown).

### 2.8 Requests — `request_program` (spec 11 §2.1 addition)

`request_program({ program, subject? })`, offered when the desk is wired.
The model maps the listener's free text to a category (and a subject when
they named one). Category only → the host picks the subject under cooldown;
an explicit subject → bypasses cooldown; maps to no category → the tool is
not called, the reply is just a chat reply and the program goes on. On a
call the current program ends at once (its unsaid points dropped; the reply
is its line or two of wrap), the requested program is planned immediately,
and it ledgers `requested: true`. A request that cannot air now (*This Thing
Today* without two fresh items) is refused: nothing changes and the tool
result tells the reply to say so. A superseded plan (by a request or a
reset) spends no further call and freezes no name.

### 2.9 The status line

`ProgramState.program?: string`, rendered by the Director as
`name · subject · n/total` while a program is on; the TUI shows it in the
strip.

### 2.10 Music

- The program owns the talk/music ratio: a song after each outline point
  (`record`'s points are one track each with 1–2 beats, so one song per 1–2
  beats; `poem`'s points are the reading and its layers). The settings
  cadence (`musicEveryN` / random / brain) applies only while no program is
  on the air.
- Only `record` picks from its outline: the pick for the song after a point
  is asked for that point's track as a request (it bypasses the familiar-
  slot rule). The other four pick by taste as before, with the program's
  name and subject as a mood hint line.
- The coda is no longer its own call: the next point's beats are generated
  when the song starts, with the song in the music status, and the point's
  first beat is the transition out of it — it rides the outro exactly as the
  coda did (spec 04 §3.3-C's ride mechanics stand).

### 2.11 Usage

Category `plan` joins the usage log (DESIGN §7 row 3).

---

## 3. Design

### 3.1 The prepared presenter

`HOST_CRAFT` gains whole-role framing: the host comes to the air prepared —
a program with a subject and an outline — and talks from that material the
way a presenter talks from their notes. No point rules (the project norm);
the listener's `persona.md` is never migrated.

### 3.2 Without a program

A stub brain has no harness to plan with, and a test may wire none: with no
desk the Director is the pre-program talk loop (minus the deleted topic
cue). With a desk but no plan yet (cold boot), the boundary plays music if
music is on, else waits for the plan; the stock opener covers the first
seconds as before.

### 3.3 Failure posture

A planning call that fails or never submits is retried once, then the draw
moves on to another category; the boundary falls back as in §3.2. A beat
call that fails degrades like any batch (spec 04). A bad schedule file is a
fresh one.

---

## 4. Dependencies

Specs 03-01, 04, 05, 07, 11, 12, 13, 14. New runtime dependency:
`opencc-js` (MIT/Apache-2.0) for traditional → simplified normalization.

---

## 5. Acceptance criteria

### Unit (deterministic)

1. The draw never returns one of the last two aired ids while another is
   eligible, relaxes the gap when it must, and reshuffles weights after 3
   days.
2. `normalizeSubject` folds traditional to simplified, width, case,
   whitespace and punctuation.
3. A plan whose keys hit the cooldown is replanned once, then another
   category is drawn.
4. The Director generates one point per call, plays a song after a point,
   opens with the opening flag (anchor folded in), closes with the closing
   flag, and fires the next plan during the last point.
5. A reply discards the point's unsaid beats and the refill returns to the
   point; a `request_program` call ends the run and plans the request.
6. A run persisted < 6 h ago resumes with `resumed`; older is dropped.
7. No beat carries a topic; no prompt carries a "recently covered" line.

### Real seam

8. A headless real-brain smoke (stub voice, no music) airs whole programs;
   tokens per 1000 spoken characters are compared with the pre-program
   baseline in the PR body.

### By-ear (open)

9. Programs sound prepared — material, not filler; no repeats inside a
   program; the open and the wrap vary in wording.
10. Over a day, no subject repeats inside its cooldown.
