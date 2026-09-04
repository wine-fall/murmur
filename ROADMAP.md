# murmur — roadmap

_Where the radio goes next. Four lines; a line is deleted when it is done, not
archived. Order is the **P** column, not the row number — the numbers are
names, so a line keeps its own while the order moves. This is the **direction**
layer: the current build focus lives in [`specs/STATUS.md`](specs/STATUS.md).
Where a line names issues, the evidence and close condition live there._

_P1_ changes what murmur **is** · _P2_ is reliability and quality ·
_P3_ is distribution and not rotting.

_Last updated: 2026-09-04 (lines 2 and 0 delivered and deleted)._

**This round has two goals at once, and they do not conflict:** murmur should
be good enough that its own author leaves it on, *and* runnable by someone who
is not its author. Local TTS is **explicitly out of scope** this round — the
hosted voice stays.

| # | Line | What it is | This round delivers | P | Tracked as |
|---|---|---|---|---|---|
| 1 | Sound like a DJ | Talk and music actually interleave, instead of alternating at boundaries | A track gets a lead-in, not a label; the host can interject mid-track, not only at its edges | **P1** | the lead-in and the coda landed (#199, #200) and both already speak over the ducked track; what is missing is the autonomous mid-track beat, [#163](https://github.com/wine-fall/murmur/issues/163) |
| 5 | Log in to the catalogue you already have | The catalogues murmur cannot reach are the ones behind a login | An opt-in, guided login for one auth-gated source — NetEase first | **P1** | new; §5 below |
| 3 | Pick well, play reliably | Candidates come from sources worth trusting, not from keyword soup | Dead stream probes down; picks back under the spec-04 budget | **P2** | [#164](https://github.com/wine-fall/murmur/issues/164), [#149](https://github.com/wine-fall/murmur/issues/149) + new |
| 4 | Others can run it, and it does not rot | A second brain backend, and an eval track under the stochastic behavior | murmur runs without a Claude Code login; prompt regressions get caught by a test | **P3** (its eval half, [#98](https://github.com/wine-fall/murmur/issues/98), is P2 now that line 2 has landed unguarded) | [#89](https://github.com/wine-fall/murmur/issues/89), [#98](https://github.com/wine-fall/murmur/issues/98), [#80](https://github.com/wine-fall/murmur/issues/80), [#153](https://github.com/wine-fall/murmur/issues/153), [#102](https://github.com/wine-fall/murmur/issues/102) |

Lines 1 and 5 are the ones that change what murmur *is*. Line 4's eval half
([#98](https://github.com/wine-fall/murmur/issues/98)) is read first among the
P2s: it is the only line already overdue rather than upcoming, and every prompt
edit on the stochastic surface is unguarded until it lands.

---

## 1. Sound like a DJ

Two halves of one behaviour; the first has landed.

**The intro is no longer a label — landed (#199, #200).** The announce is a
lead-in spoken over the ducked head of the track instead of a title read after
the stream is already under the listener, and the coda is the back-announce at
its tail.

**Nothing is said over a song unprompted.** Speaking over a ducked track is
not the missing piece — the lead-in and the coda both do it today
(`src/director/director.ts`: the handle is ducked, the clip airs, the unduck lifts
behind it), and `Engine.play(voice)` has ducked live music for a clip since
long before that. What is missing is a beat the host starts on its own
*between* those two edges: inside a music segment it is silent from the
announce to the fade unless the listener speaks first, because
`Director.runVoice` races only the song's end, the listener's next line, and a
due switch. Adding that race arm is the feature — with the staleness rule
issue #163 records, since a buffered beat can be minutes old by the time it
airs.

## 3. Pick well, play reliably

`search_music` is a single keyword query against the provider
(`src/music/music-tools.ts:41`). There is no notion of a source, so whatever ranks
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
- **#98** — the first eval track, and it is overdue rather than upcoming: line
  2 shipped a prompt whose whole job is stochastic (does the host bring a real
  item in a host's register, or scrub it back to mood?), and the only thing
  that caught the first draft getting that wrong was a person reading
  `.dev/dev.log`. Every prompt edit on that surface is unguarded until this
  lands.
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
  (`src/music/music-tools.ts`) — never reaching the stream probe. So a listener whose
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
  [#138](https://github.com/wine-fall/murmur/issues/138),
  [#197](https://github.com/wine-fall/murmur/issues/197),
  [#198](https://github.com/wine-fall/murmur/issues/198),
  [#202](https://github.com/wine-fall/murmur/issues/202)) — these are a gate,
  not a direction. They are meant to be walked in one long real session, not
  scheduled as separate work items. [#44](https://github.com/wine-fall/murmur/issues/44)
  now closes on #202's first box: spec 13 is its durable fix, and only an ear
  can say whether it worked.
- **The listener's dropped first line** (issue #145, formerly line 0) — retired
  on 2026-09-04 as **cannot-reproduce, not fixed**: three real `--plain` runs
  (real brain, seeded persona, piped stdin, one line after the second beat)
  all landed the first line, verified at the `settings.json` seam. It is off
  the roadmap because there is nothing to schedule — no repro means no red
  test to write and no cause to fix — not because it was solved. The contract
  and this history live in `specs/spec01/01-core-loop.md` §3.3, and the
  hand-over it turns on is pinned in `test/director-steer.test.ts`. A listener
  losing a first line again reopens this as a line, with the new repro.

- **Doc debt** ([#104](https://github.com/wine-fall/murmur/issues/104)) and
  **watch items** ([#83](https://github.com/wine-fall/murmur/issues/83)) — one
  edit each, taken when they are in the way. #104 grew a third claim to fix:
  spec 13's topic fetch makes the network calls four, not the "three" DESIGN
  still names.
