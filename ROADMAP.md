# murmur — roadmap

_Where the radio goes next. Four lines; a line is deleted when it is done, not
archived. Order is the **P** column, not the row number — the numbers are
names, so a line keeps its own while the order moves. This is the **direction**
layer: the current build focus lives in [`specs/STATUS.md`](specs/STATUS.md).
Where a line names issues, the evidence and close condition live there._

_P1_ changes what murmur **is** · _P2_ is reliability and quality ·
_P3_ is distribution and not rotting.

_Last updated: 2026-09-06 (line 5 retitled: taste, not transport — spec 14)._

**This round has two goals at once, and they do not conflict:** murmur should
be good enough that its own author leaves it on, *and* runnable by someone who
is not its author. Local TTS is **explicitly out of scope** this round — the
hosted voice stays.

| # | Line | What it is | This round delivers | P | Tracked as |
|---|---|---|---|---|---|
| 1 | Sound like a DJ | Talk and music actually interleave, instead of alternating at boundaries | A track gets a lead-in, not a label; the host can interject mid-track, not only at its edges | **P1** | the lead-in and the coda landed (#199, #200) and both already speak over the ducked track; what is missing is the autonomous mid-track beat, [#163](https://github.com/wine-fall/murmur/issues/163) |
| 5 | Learn from the catalogues the listener already keeps | murmur picks from a listener it barely knows; their taste already exists on the platforms they use | Five opt-in sources read into a bounded taste digest the brain picks with; the pick task can search a named catalogue (YouTube, Bilibili, NetEase); an expired login says so; one light invitation form for `/sources`, `/bug`, `/feature-request` | **P1** | [`specs/spec14/14-listening-taste.md`](specs/spec14/14-listening-taste.md) |
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

## 5. Learn from the catalogues the listener already keeps

**Retitled 2026-09-06 after a requirements pass.** The earlier reading —
"log in to the catalogue you already have", i.e. *play from* NetEase — was
the mechanism, not the requirement. The requirement, in the user's words:
*see what the listener likes on the platforms they already use, and recommend
music that suits them better.* That is a **taste** problem, and taste is
metadata: a list of titles, artists and playlist names read with a
credential. It needs no audio decryption, no Spotify Premium, no headless
browser and no new playback transport — every hard part of the earlier
reading belonged to *playback from* the platform, which this line does not do.

Spec: [`specs/spec14/14-listening-taste.md`](specs/spec14/14-listening-taste.md)
— the record; this section is the pointer. In one paragraph: five opt-in
sources (YouTube, Bilibili, NetEase via browser cookie through yt-dlp;
Spotify via OAuth on a free account; Soda Music via a Douyin QR scan) are
read into a deterministic **taste digest** the music pick task and the
context pack receive; the pick task can **search a named catalogue** —
YouTube, Bilibili, NetEase (the one place yt-dlp cannot search, so a small
client fills it) — and play through today's yt-dlp path, cookie attached
where mounted (VIP tiers included). **An expired login says so on screen,
once**, instead of today's silent "pick another". Login is never required;
the only nudge is an **invitation** — the same light form `/bug` and
`/feature-request` get, made context-gated and fading. Playback from Spotify
and Soda is out (Premium at the protocol level; CENC decryption in the class
master §5 declined for `musicdl`) — both are complete as read-only sources.

What was checked to get here (2026-09-06, all verified against the code or
the tool): yt-dlp 2026.08.19 has seven `netease:*` extractors, walks the VIP
quality tiers from the account's own, raises a distinct login-required
error (`-462`) and a geo error — and has **no** NetEase search; it reads
YouTube's liked/history/subscriptions and Bilibili's favourites with a
cookie; Soda has zero yt-dlp support and zero yt-dlp issues (never asked,
not refused). Reference implementations and their licences are in spec 14
§7 — cliamp (no licence) does **not** implement Bilibili or Soda, contrary to
what master §5 said until today.

Done when spec 14 §5 holds: no account → no change (byte-identical yt-dlp
arguments); a mounted NetEase account's liked artist appears in the digest
and a NetEase search result plays; a logged-out cookie produces the one
on-screen line while the radio keeps playing from YouTube; Spotify and Soda
mount and read on the user's own accounts; the invitations table passes.

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
