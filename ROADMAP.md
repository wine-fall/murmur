# murmur — roadmap

_Where the radio goes next, in order. Five lines; a line is deleted when it is
done, not archived. This is the **direction** layer: the current build focus
lives in [`specs/STATUS.md`](specs/STATUS.md). Where a line names issues, the
evidence and close condition live there; line 0 carries its own, having been
folded in from a closed issue._

_Last updated: 2026-08-31._

**This round has two goals at once, and they do not conflict:** murmur should
be good enough that its own author leaves it on, *and* runnable by someone who
is not its author. Local TTS is **explicitly out of scope** this round — the
hosted voice stays.

| # | Line | What it is | This round delivers | Tracked as |
|---|---|---|---|---|
| 0 | Foundations | Land the work already written, and stop losing the listener's first line | A clean `main` and an input path that never drops a typed line | PRs in flight; §0 below |
| 1 | Sound like a DJ | Talk and music actually interleave, instead of alternating at boundaries | A track gets a lead-in, not a label; the host can speak over a ducked song | [#163](https://github.com/wine-fall/murmur/issues/163) + new |
| 2 | Say real things | The host gets real material — news, new releases, what is happening near the listener | An off-loop topic pool, weighted by the listener's language and timezone | [spec 13](specs/spec13/13-real-world-topics.md) (PR #203); by-ear [#202](https://github.com/wine-fall/murmur/issues/202), absorbs [#44](https://github.com/wine-fall/murmur/issues/44) |
| 3 | Pick well, play reliably | Candidates come from sources worth trusting, not from keyword soup | Dead stream probes down; picks back under the spec-04 budget | [#164](https://github.com/wine-fall/murmur/issues/164), [#149](https://github.com/wine-fall/murmur/issues/149) + new |
| 4 | Others can run it, and it does not rot | A second brain backend, and an eval track under the stochastic behavior | murmur runs without a Claude Code login; prompt regressions get caught by a test | [#89](https://github.com/wine-fall/murmur/issues/89), [#98](https://github.com/wine-fall/murmur/issues/98), [#80](https://github.com/wine-fall/murmur/issues/80), [#153](https://github.com/wine-fall/murmur/issues/153), [#102](https://github.com/wine-fall/murmur/issues/102) |

Lines 1 and 2 are the ones that change what murmur *is*. Line 0 comes first
because every by-ear judgement above it is worthless while the first thing the
listener says disappears.

---

## 0. Foundations

**Land what is already written.** Several PRs sit green and unmerged. Two of
them — the clock-and-progress enrichment and the beat-grounding fix — were
built by separate sessions against the same seam: both add a time field and a
music-state field to `ContextPack` and both touch `src/contracts.ts`,
`src/director.ts`, `src/prompts.ts` and the same three test files. They must be
**reconciled into one change before either merges**. The suggested base is the
one with the four-state music union and the anti-fabrication rules, taking the
play-progress arithmetic and the spec amendments from the other.

**The first line a listener types in a session is silently dropped.** Carried
here from issue #145, which is closed in favour of this line.

It never echoes, never reaches the steer turn, and leaves no dev-log trace. The
second line behaves normally. Reproduced 3/3 on 2026-08-25 against the real
brain, with a pre-seeded `persona.md` so first-run onboarding is skipped, lines
written to stdin after the second beat aired plus a 3 s settle:

| run | line 1 | line 2 | result |
|---|---|---|---|
| A | "turn the music off please" | "actually, speak Japanese from now on" | only line 2 echoed and acted |
| B | "hey, can you turn the music off? just talk tonight" | — | nothing echoed; no effect |
| C | "turn the music off" | "turn the music off" | only line 2 echoed; `settings.json` got `musicEnabled: false` |

Run C is the clean isolation — identical text, only the second one lands — so
the defect is **positional**, not content- or intent-dependent.

Suspected, **not verified**: a pre-broadcast `lineReader` (`src/guide.ts:143`)
left legitimately pending from the boot stretch consumes the first queued line
and discards it. `LineQueue.peek()` (`src/host.ts:108`) memoizes one shared
waiting promise, so a stale reader's callback can win the race and `takeLine()`
before the Director's own boundary race sees it. The `settled` guard
(`src/guide.ts:149-156`) exists for this class of loss, but covers only a read
already resolved through EOF or the quit latch — not a reader still pending
when an unrelated line arrives.

Not yet investigated: whether the TUI front-end is affected too (all three runs
were `--plain`), and whether a real TTY behaves differently from the piped
stdin used in the repro.

Spec: `specs/spec01/01-core-loop.md` §3.3 and
`specs/spec03/03-03-guide-harness.md` §3. The contract violated: a typed line
either reaches the Director or is consumed by a reader that is actually asking
something — never dropped.

Done when a regression test pins it (a line pushed while a pre-broadcast reader
is pending still reaches the Director's steer path, fakes only), and a real
plain-mode run shows the **first** typed line echoing and taking effect.

## 1. Sound like a DJ

Two halves of one behaviour.

**The intro is a label, not a lead-in.** Today the whole introduction is one
optional line on `submit_pick` (`src/music-tools.ts`), and it is spoken *after*
the engine has confirmed the stream is playing (`src/director.ts:826-851`), so
the listener hears a title and the song is already under it. What is wanted is
a beat that arrives at the track — why this one, what it follows — and then the
music. Possibly a back-announce when it ends. This likely means promoting the
announce from a field on the pick to a real talk beat, which touches spec 04
and spec 03-02 §3.5.

**Nothing is ever said over a song.** Inside a music segment the host is silent
from the announce to the fade unless the listener speaks first. The engine half
already exists and is in daily use — `Engine.play(voice)` ducks live music for
the clip and pre-schedules the unduck. What is missing is the director asking:
`Director.runVoice` races only the song's end, the listener's next line, and a
due switch. Adding that race arm is the feature — with the staleness rule
issue #163 records, since a buffered beat can be minutes old by the time it
airs.

## 2. Say real things

The self-initiated talk task has **no way to learn anything**. It runs through
`runTask` (`src/brain.ts:356-366`), whose allowlist is built from exactly the
tools the caller hands it — and `nextTalks` hands it one, the terminal
`emit_talk_beats` (`src/brain.ts:377`). `agenticOptions` sets `tools: []` and
allows only murmur's own MCP names, so there are no built-in tools underneath
either. The model holds a persona and a transcript and nothing else, so it
invents its topics, and on a cold start it lands on the same few cozy images
every time (the standing complaint in #44). A topic capability therefore has to
arrive as a murmur tool on that task, or already folded into its prompt —
loosening `isolatedOptions` (`src/brain.ts:97`) changes nothing here; that is
the tool-less plain-text path.

The line: give the host **real material** — news, new releases, what is
happening where the listener is — weighted toward their locale, with
international as the fallback rather than the default.

Two constraints that shape the design rather than being discovered late:

- **Off the live loop.** Picks already run 80–190 s in a bad session (line 3);
  hanging a search off the talk path would be fatal to the look-ahead. Fetch
  into a **topic pool** in `MURMUR_HOME` on a schedule and have talk read from
  the pool. This also keeps the spec-07 token economy honest.
- **Region is not stored, and language is not region.** The spoken language is
  settled at first run and then owned by the persona, with `settings.language`
  able to override it afterwards (`src/app.ts:200-203`, spec 12 §3.9);
  `detectLanguage` reads only `LC_ALL` / `LC_MESSAGES` / `LANG`
  (`src/locale.ts:44`) and is the boot default, not a live signal. So the pool
  has to weight on the **effective** spoken language, read where the host reads
  it — and get *where the listener is* from a separate signal. The system
  timezone is the cheap one; it should not need a new onboarding question.

This is also the durable fix for #44: a cold boot stops being identical when
the host actually has something in front of it.

Cost to accept: this is a **fourth network call**, and the "three network
calls" wording in `specs/DESIGN.md` (already stale, per #104) has to move
again.

## 3. Pick well, play reliably

`search_music` is a single keyword query against the provider
(`src/music-tools.ts:41`). There is no notion of a source, so whatever ranks
first is what gets judged, and nothing vouches for it. The observed cost is in
#164: three dead stream probes in half an hour, one pick abandoned to talk, and
every pick in that session running 1.5–3.5× the recorded spec-04 baseline —
because a dead probe costs a whole extra pick round.

The line: **candidates from places worth trusting** — a channel's uploads, a
curated list — as additional tools beside the open-ended search, so the model
can go somewhere specific rather than fishing. That may also be the fix for the
dead probes, not just a quality improvement.

#149 (does the pick actually stop repeating) belongs here; it is the by-ear
half of the same question.

## 4. Others can run it, and it does not rot

The distribution half and the durability half of the same goal.

- **#89** — a second brain backend so a machine without a Claude Code login can
  still run the radio. The largest single item on this roadmap: a full second
  implementation of the `Brain` / `Harness` / `GuideCapable` seam, including
  permission routing and streaming input.
- **#98** — the first eval track. Lines 1 and 2 are entirely stochastic
  behaviour; without an LLM-in-the-loop test, every prompt edit after them is
  unguarded.
- **#80**, **#153**, **#102** — the first-run path a new listener actually
  walks: onboarding in a real terminal, quitting mid-onboarding, and the setup
  guide's consent rounds.

---

## Not on this roadmap

- **Local TTS** — the recorded want in spec 02 §3.6 stays recorded. The hosted
  voice is the voice this round.
- **The by-ear acceptance passes** ([#79](https://github.com/wine-fall/murmur/issues/79),
  [#81](https://github.com/wine-fall/murmur/issues/81),
  [#99](https://github.com/wine-fall/murmur/issues/99),
  [#138](https://github.com/wine-fall/murmur/issues/138)) — these are a gate,
  not a direction. They are meant to be walked in one long real session, not
  scheduled as separate work items.
- **Doc debt** ([#104](https://github.com/wine-fall/murmur/issues/104)) and
  **watch items** ([#83](https://github.com/wine-fall/murmur/issues/83)) — one
  edit each, taken when they are in the way.
