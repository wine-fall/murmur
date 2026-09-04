# murmur — roadmap

_Where the radio goes next. Six lines; a line is deleted when it is done, not
archived. Order is the **P** column, not the row number — the numbers are
names, so a line keeps its own while the order moves. This is the **direction**
layer: the current build focus lives in [`specs/STATUS.md`](specs/STATUS.md).
Where a line names issues, the evidence and close condition live there; line 0
carries its own, having been folded in from a closed issue._

_P0_ blocks every judgement above it · _P1_ changes what murmur **is** ·
_P2_ is reliability and quality · _P3_ is distribution and not rotting.

_Last updated: 2026-09-04._

**This round has two goals at once, and they do not conflict:** murmur should
be good enough that its own author leaves it on, *and* runnable by someone who
is not its author. Local TTS is **explicitly out of scope** this round — the
hosted voice stays.

| # | Line | What it is | This round delivers | P | Tracked as |
|---|---|---|---|---|---|
| 0 | Foundations | Land the work already written, and stop losing the listener's first line | A clean `main` and an input path that never drops a typed line | **P0** | §0 below (the reconciliation landed; the dropped line has not) |
| 1 | Sound like a DJ | Talk and music actually interleave, instead of alternating at boundaries | A track gets a lead-in, not a label; the host can interject mid-track, not only at its edges | **P1** | the lead-in and the coda landed (#199, #200) and both already speak over the ducked track; what is missing is the autonomous mid-track beat, [#163](https://github.com/wine-fall/murmur/issues/163) |
| 2 | Say real things | The host gets real material — news, new releases, what is happening near the listener | An off-loop topic pool, weighted by the listener's language and timezone | **P1** | built, green and unmerged: [#203](https://github.com/wine-fall/murmur/pull/203) + [#201](https://github.com/wine-fall/murmur/pull/201) (absorbs [#44](https://github.com/wine-fall/murmur/issues/44)) |
| 5 | Log in to the catalogue you already have | The catalogues murmur cannot reach are the ones behind a login | An opt-in, guided login for one auth-gated source — NetEase first | **P1** | new; §5 below |
| 3 | Pick well, play reliably | Candidates come from sources worth trusting, not from keyword soup | Dead stream probes down; picks back under the spec-04 budget | **P2** | [#164](https://github.com/wine-fall/murmur/issues/164), [#149](https://github.com/wine-fall/murmur/issues/149) + new |
| 4 | Others can run it, and it does not rot | A second brain backend, and an eval track under the stochastic behavior | murmur runs without a Claude Code login; prompt regressions get caught by a test | **P3** (its eval half, [#98](https://github.com/wine-fall/murmur/issues/98), is P2 once lines 1/2 land) | [#89](https://github.com/wine-fall/murmur/issues/89), [#98](https://github.com/wine-fall/murmur/issues/98), [#80](https://github.com/wine-fall/murmur/issues/80), [#153](https://github.com/wine-fall/murmur/issues/153), [#102](https://github.com/wine-fall/murmur/issues/102) |

Lines 1, 2 and 5 are the ones that change what murmur *is*. Line 0 comes first
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

**Checked 2026-09-04 — still neither fixed nor cleared.** No fix has landed:
the `settled` guard predates the repro (it came in on 2026-08-18/19, a week
before), and `LineQueue`'s take/peek semantics have not changed since (#187
added `hasReader()` and reworked the `IpcHost` echo flow around it on 09-02,
which the plain-mode consumption path does not go through). A stub plain-mode run with a
pre-seeded persona echoed and acted on the **first** typed line — but that path
runs with no harness, so neither the crash-report offer nor the setup
conversation opens a pre-broadcast reader, and it therefore neither reproduces
the bug nor clears it. The suspected seam also reads clean today: every `read()`
in the first run, the crash offer and the setup flow is awaited, and `settled`
is set in the race's own `finally`, so a resolved read's stale callback returns
`''` rather than taking. So treat the suspected cause as **unconfirmed** and
start from the **August 25 boot state** — a real brain, a seeded persona, piped
stdin — not from that seam. Note that the crash-report offer did not exist
then (the sentinel landed 08-31, #169/#175), so it cannot have been the reader
that ate that line; it is a *new* pre-broadcast reader worth checking on its
own, not a way back to the original.

## 1. Sound like a DJ

Two halves of one behaviour; the first has landed.

**The intro is no longer a label — landed (#199, #200).** The announce is a
lead-in spoken over the ducked head of the track instead of a title read after
the stream is already under the listener, and the coda is the back-announce at
its tail.

**Nothing is said over a song unprompted.** Speaking over a ducked track is
not the missing piece — the lead-in and the coda both do it today
(`src/director.ts`: the handle is ducked, the clip airs, the unduck lifts
behind it), and `Engine.play(voice)` has ducked live music for a clip since
long before that. What is missing is a beat the host starts on its own
*between* those two edges: inside a music segment it is silent from the
announce to the fade unless the listener speaks first, because
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

## 5. Log in to the catalogue you already have

**Recorded at the start, deferred on purpose.** `specs/DESIGN.md` §5 excludes
both sources by name, and says why: NetEase Cloud Music has the best Chinese
catalogue but only unofficial APIs, **needs a login cookie**, and gates its
good tracks behind VIP; Spotify has no clean no-app-no-membership path — the
desktop app (ads, on-demand limits) or headless librespot, which **needs
Premium**. Spec 03-01 keeps the deferral as a single work item and names
[`cliamp`](https://github.com/bjarneo/cliamp) as the credential reference: how
it obtains, stores and refreshes per-service cookies — **the auth flow only**,
never its user-picks interaction model, since murmur's listener is a listener
and not a selector.

**What has changed since that call**: nothing about Spotify — but yt-dlp,
already murmur's only provider, ships `netease:song / playlist / singer /
djradio` extractors and takes `--cookies FILE` / `--cookies-from-browser`
(checked against yt-dlp 2026.08.19). So the NetEase half is **not a second
provider**; it is a credential reaching the provider murmur already runs, plus
URL-shaped candidate sources beside the open-ended search — which is line 3's
"somewhere specific" by another road.

What it touches:

- `MusicProvider` (`src/contracts.ts:175`) is `search` + `resolve` and nothing
  else: no session, no credential, no notion of a source that can fail on
  *auth*. `src/app.ts:248` constructs `YtDlpMusicProvider` directly, so there
  is no provider choice to configure either. Both need the smallest widening
  that carries a cookie down to yt-dlp and reports an expired one **as expired**.
  Today a yt-dlp auth failure comes back through `provider.resolve`, which
  `submit_pick` catches and hands the model as "pick another"
  (`src/music-tools.ts`) — never reaching the stream probe. So a listener whose
  cookie went stale would watch murmur quietly reject candidate after candidate
  with nothing on screen naming a login.
- **The login is a conversation, not a config field.** The setup guide (spec
  03-03) already walks a listener through a credential murmur cannot mint for
  them — the voice key — and stores it in `~/.murmur/`. A NetEase cookie is the
  same shape of question, with a lazier answer available first:
  `--cookies-from-browser` may mean the listener is already logged in.
- **Opt-in, never a shipped default** (DESIGN §3.7's personal-experiment tier).
  The default install stays login-free yt-dlp; the fragility and the ToS risk
  belong to the listener who mounts the source, which is why they mount it.
  This does not reopen DESIGN §8's v1 exclusion: NetEase stays out of the
  shippable stack, and what this line adds is the mounting path for a listener
  who chooses it on their own machine.
- **Spotify gets the seam and an honest refusal.** Not because a free account
  has no stream — DESIGN §5 records that the desktop app plays one, with ads
  and on-demand limits; it is headless librespot that needs Premium. The
  refusal is that murmur cannot *conduct* that stream: the external-player
  control and duck path is explicitly out of scope in spec 03-02, and an app
  bound over AppleScript cannot honour "play exactly this track", which is the
  whole premise of a brain-picked program.

Done when a listener with a NetEase account hears a track from it that **the
brain picked**, an expired cookie says it is expired, and a listener with no
account sees no change at all.

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
