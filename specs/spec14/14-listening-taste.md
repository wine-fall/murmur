# spec/14 · listening-taste — the catalogues the listener already keeps

> **Status**: **Built 2026-09-07** (PR #214 — see "As built" notes inline,
> marked *as built*). Drafted 2026-09-06. Replaces the "log in to the
> catalogue" reading of [`../../ROADMAP.md`](../../ROADMAP.md) line 5 after a
> requirements pass (session of 2026-09-06): the listener's goal is **better
> picks from what murmur can learn about their taste**, not playback from a
> particular platform. That reframing removes every hard part the earlier
> reading carried — no audio decryption, no Spotify Premium, no headless
> browser, no new playback transport. Playback stays exactly the yt-dlp path
> that exists today.
> **Part**: Delivers ROADMAP line 5 (retitled with this spec). Feeds the music
> pick task (spec 03-01 §2.3) and the context pack (spec 05 §2.2) a **taste
> digest** read from the platforms the listener opts in, and lets the pick task
> **search a named catalogue** (YouTube, Bilibili, NetEase, and the curated
> `channels` pool of §2.9) with that taste in hand. Does not touch the ducking engine (spec 03-02), the director's segment
> loop (spec 04), or `profile.md`'s ownership (spec 05 §3.2, spec 13 §3.4).
> **Milestone**: companion character. Depends on the music task (03-01), the
> memory pack (05), settings (12), the command grammar (10 §3.2-C), and the
> Director's floor-parking used by `/setup` (03-03 §4 amended 2026-08-19).
> **Network posture (master §3.1, amended)**: credentials travel **only to the
> platform that issued them** — a browser cookie to that site through yt-dlp
> or a small HTTP client, a Spotify token to Spotify, a Soda session to Soda.
> The brain sees **titles, artists, album and playlist names** in a bounded
> digest, never a credential. Nothing from these platforms is written to
> `profile.md`.
> **Conventions**: English; written for a coding agent. Mechanism and
> contracts, not final code. **Reference implementations are read for
> mechanism only and never copied** — see §7.

---

## 1. Goal & scope

### The one requirement

> *"I want to see what the listener likes on the platforms they already use,
> and use that to recommend music that suits them better."*

Everything below serves that sentence. Two capabilities, in this order of
importance:

1. **Taste read.** From each platform the listener opts in, read what they
   keep — liked tracks, playlists, listening history, "top" lists — into a
   deterministic, bounded **taste digest** the brain reads when it picks music
   (and when it talks).
2. **Catalogue search.** The pick task can search **a named catalogue** —
   YouTube (today's default), Bilibili, NetEase — so a taste learned on one
   platform can be acted on where the music is reachable. Not every platform
   is a search target: Spotify and Soda are **read-only** here.

### Delivers

- **Six sources**, all opt-in, each mounted by its own short conversation:

  | source | taste read | search | play | how the listener mounts it |
  |---|---|---|---|---|
  | **YouTube / YouTube Music** | history (`:ythistory`), the subscriptions feed (`:ytsubs`); `:ytfav` names the account only | yes (exists) | yes (exists) | signs in to Chrome — the one source with no scan to offer |
  | **Bilibili** | watch history (with its category), accounts recently followed, accounts most visited, space audio | yes (`bilisearch`) | yes | scans a code with the Bilibili app |
  | **NetEase Cloud Music** | liked-songs playlist, own + collected playlists | yes (own client) | yes (yt-dlp with cookie, VIP tiers included) | scans a code with the NetEase Cloud Music app |
  | **Spotify** | top tracks, top artists, liked tracks, playlist names | no | no | OAuth in their browser, free account is enough |
  | **Soda Music (Qishui)** | collection, own playlists, daily mix | no | no | scans a QR with Douyin |
  | **QQ Music** | liked songs, own + favourited playlist names | yes (own client, signed in) | yes (yt-dlp with cookie, free tracks; VIP dropped at search) | scans a code with WeChat, or signs in to Chrome |

- **`$MURMUR_HOME/sources.json`** — the mounted sources and their credentials
  (§2.1). Secret-bearing; guarded like `voice.json` (03-03 §3).
- **`$MURMUR_HOME/data/taste/<source>.json`** — one snapshot per source
  (§2.2), refreshed on a fixed policy (§3.5).
- **The taste digest** (§2.3): a pure function of the snapshots, rendered into
  the context pack and the music pick situation.
- **Named-catalogue search** in the pick task (§2.4) and **cookie-aware
  resolve** in the yt-dlp provider (§2.5).
- **Typed auth failure** end to end (§2.6): an expired cookie *says* it has
  expired, on screen, once — never "pick another" in silence.
- The **`/sources`** command (§3.1) — mount, list, refresh, unmount.
- **Invitations** (§3.8): the one light form in which the radio ever suggests
  a side-errand — `/sources`, `/bug`, `/feature-request` — replacing today's
  fixed placeholder carousel with a context-gated, fading set. **Login is
  never required**; an invitation is the only nudge there is.
- **One onboarding card** (§3.9): a new listener is offered the connection once, and a yes runs `/sources` there and then.

### Out of scope (explicit non-goals)

- **Playback from Spotify or Soda.** Spotify streaming needs Premium at the
  protocol level (librespot's own README: "will remain the case"); Soda's
  audio is CENC-encrypted and needs a reverse-engineered key derivation — the
  class master §5 already declined for `musicdl`. Neither is a placeholder:
  these two sources are complete as **read-only** taste sources. A listener
  who wants to *hear* a Spotify or Soda track gets it via catalogue search on
  YouTube / Bilibili / NetEase, which is the whole point of §2.4.
- ~~**Playback from QQ Music, and searching it.**~~ Both are **in** scope as
  of this build: QQ Music searches through its own client (§2.4) and plays
  through yt-dlp with the mount's cookie (§2.5). The sentence this bullet used
  to carry — that yt-dlp's extractor was broken — was simply false.
- **A brain-written taste summary.** The digest is deterministic (§2.3). The
  brain forms its own picture inside the pick task; whether a distilled
  paragraph would pick better is an eval question (#98), not a build item.
- **Writing to `profile.md`.** It stays the compaction's (05 §3.6) and the
  listener's. The digest is a sibling input to the pack, not a profile edit —
  this is not the "taste file" #209 removed (that was a hand-edited rwt
  policy; this is derived data with its own refresh).
- **Restructuring first-run (spec 06)** — its by-ear pass is open (#80).
  Onboarding gains exactly **one consent card** (§3.9) and nothing else; the
  card never asks for a login itself. Mounting is always the listener's own
  act — through `/sources`, whether entered from that card or later.
- **A generic plugin/provider registry.** Five concrete adapters behind one
  interface. A sixth is a sixth adapter.

### Considered alternatives (recorded so we don't re-litigate)

- **Play from the platform, not just read it** — the earlier line 5. Rejected
  for this round on cost/legality (decryption, Premium) once the requirement
  turned out to be *taste*, not *transport*. The playback seam is untouched, so
  the door is not closed; it is simply not this spec.
- **yt-dlp for everything.** It reads YouTube's and Bilibili's personal lists
  natively and resolves NetEase (with VIP tiers) — but it has **no NetEase
  search extractor** and no way to answer "who am I" on NetEase or Bilibili.
  Hence the two small identity clients (§2.8).
- **`profile.md` as the destination.** Rejected: collides with compaction's
  atomic rewrite and with the ownership rule; and a 500-line liked list is
  not a profile fact.
- **A guide-brain conversation for mounting** (as the voice endpoint has,
  03-03 §7.2). Rejected: every mount here is a fixed, deterministic dialogue
  (a browser name; an OAuth round-trip; a QR poll) — `Host.ask` questions,
  unit-testable, no model in the loop.

---

## 2. Contracts / seams

### 2.1 `sources.json` — mounted sources

Path from `src/paths.ts` (`sourcesConfigPath`, path governance applies).
zod-validated; unknown keys dropped with one warning; a corrupt file is
reported once and treated as empty (never crashes the radio).

```ts
type BrowserName = 'chrome' | 'chromium' | 'brave' | 'edge' | 'firefox' | 'safari' | 'vivaldi' | 'opera'
type SourceStatus = 'ok' | 'expired' | 'error'
type Mounted<T> = T & { mountedAt: string /* ISO */; status: SourceStatus; lastRefresh?: string; lastError?: string }

// How the cookie was obtained. A mount made before the scan existed carries
// no `auth` key at all, which is what makes an older file readable untouched.
type Access =
  | { auth: 'qr'; cookie: string }
  | { auth?: 'browser'; browser: BrowserName; profile?: string }

type SourcesFile = {
  youtube?:  Mounted<{ browser: BrowserName; profile?: string }>   // `chrome:Profile 1` style
  bilibili?: Mounted<Access & { mid: string }>
  netease?:  Mounted<Access & { userId: string; likedPlaylistId: string }>
  spotify?:  Mounted<{ clientId: string; refreshToken: string; accessToken: string; expiresAt: string }>
  qishui?:   Mounted<{ sessionCookie: string; deviceId: string; installId: string }>
}
```

- **Secrets**: `spotify.*Token`, `qishui.sessionCookie`, and `netease`/
  `bilibili` `cookie` on a scanned mount. The file joins the
  secret-bearing path list in the guide's `PreToolUse` guard and `cliPermission`
  (03-03 §3) — the setup guide may never read it. The dev log never prints a
  value from it (§3.6).
- **A browser mount stores the browser name, never the cookie**: yt-dlp reads
  the store at call time (`--cookies-from-browser`), and nothing is copied.
  **A scanned mount stores the cookie itself** — the platform handed it to
  murmur directly and there is no browser to read it back out of. It lives
  only in `sources.json`, under the same guard as the Soda session, and never
  reaches the log (§3.6).
- **`BrowserName` keeps its full list** even though YouTube is the only
  source murmur still mounts through a browser, and only ever through Chrome
  (§3.1): a listener's file may name any of the eight from a mount made
  earlier, and narrowing the enum would make that whole file unparseable —
  which is a lost mount, not a migration.
- Single writer: the `/sources` flow. Atomic write (tmp + rename), like
  `settings.json` (12 §2.1); owner-only (0600) like `voice.json`, the
  snapshots too. A corrupt file is reported once per version of the file.
- *As built (review round 2)*: the store carries an **epoch**, bumped by
  every mount and unmount. A background read that started before one is
  writing for an account that may be gone — its snapshot and any rotated
  Spotify token are dropped on a changed epoch — and a remount deletes the
  previous account's snapshot **before** reading the new one, so a first read
  that fails leaves no taste rather than the wrong account's under a fresh
  mount date.

### 2.2 `TasteSource` and the snapshot

```ts
type TasteItem = {
  readonly kind: 'liked' | 'history' | 'top-track' | 'top-artist' | 'playlist' | 'favourite' | 'subscription' | 'daily'
            | 'follows' | 'frequents'    // an account they recently followed / one they keep visiting
  readonly title: string          // track title, artist name, playlist/channel name
  readonly artist?: string
  readonly album?: string
  readonly at?: string            // ISO, when the platform says it was liked/played/watched (if it says)
  readonly ref?: string           // a URL the resolve path could play (cookie sources only)
  readonly category?: string      // the platform's own category for a watched row (Bilibili's sub-zone)
}
type TasteSnapshot = {
  readonly source: SourceId       // 'youtube' | 'bilibili' | 'netease' | 'spotify' | 'qishui'
  readonly takenAt: string
  readonly items: readonly TasteItem[]   // bounded per source, §3.5
}

interface TasteSource {
  readonly id: SourceId
  verify(): Promise<{ ok: true; who: string } | { ok: false; reason: AuthFailure }>   // cheap identity check
  snapshot(): Promise<TasteSnapshot>                                                 // may throw SourceAuthError
}
```

`who` is a display name the mount conversation echoes back ("signed in as
…") — it is the listener's proof the right account was read.

Written to `data/taste/<source>.json` atomically. **Rebuildable** (a fresh
snapshot replaces it), but it lives under `data/` not `cache/` because it is
listener data by the master's own definition (§2.3 path governance).

### 2.3 The taste digest — pure, bounded, deterministic

```ts
function renderTasteDigest(snapshots: readonly TasteSnapshot[], now: Date, budget = 1500): string
```

A pure function; same inputs, same output; unit-tested on fixtures. Shape
(markdown, English headings, values verbatim):

```
## What the listener keeps (as of 2026-09-06)
Sources: NetEase (312 liked, 9 playlists), QQ Music (40 liked, 6 playlists)
Artists they return to: Cheer Chen (41), Bon Iver (27), ...              <- top 25 by count; with the two lines above, <= 300 chars
Playlists: late drive, deep focus, Liked from Radio, ...                 <- names only, <= 12
Lately they have been listening to: "..." Night Tape - ...               <- songs-only sources, weight 1, <= 8
Spotify says (top, medium term): artists - ...; tracks - ...             <- Spotify's own ranking, <= 10 each
```

**The invariant** (*added 2026-09-18*, the listener's own rule on their own
rendered digest): **every row in the block traces either to a source that
carries nothing but songs, or to an artist name that matched.** Nothing
reaches the brain because a video platform said it was music.

That splits the mounted sources in two, and the split is the rule — not a
per-row guess:

- **Songs-only sources** — NetEase, QQ Music, Spotify, Soda Music. Their
  catalogue *is* songs, so every row they return is music by construction.
- **Video platforms** — YouTube, Bilibili. Their rows are music only when
  something says so, and nothing they offer says so reliably (below). Their
  `history`, `follows` and `frequents` rows **never reach the rendered
  block**, counts included. They still go into the ledger (§2.11) and are
  still searchable by the moment-matched half (§2.12), where a hit on an
  artist or playlist name is the guarantee this rule asks for.
- A video platform's `liked` rows are the exception the rule already covers:
  Bilibili's are the account's own **audio** uploads, which are songs.

**Why the platform's own category is not enough** (measured 2026-09-18 on the
listener's snapshots): of 200 Bilibili history rows, 4 carry a music
sub-zone, and 3 of those 4 are gossip clips their uploader filed under
`yin yue zong he` or `guo chan yuan chuang xiang guan`. The tag is the only
category Bilibili's API offers and it is wrong at the source, so a
`isMusicCategory` gate would trade 196 rows of noise for 3 more. YouTube's
history carries no `category` field at all (97 rows of 97), so there is
nothing to gate on there. `isMusicCategory` therefore **stays in the code as
a scoring signal inside §2.12's pool** — a cheap prior among many, where
being wrong costs a rank — and is no longer a ticket into the block.

**What this deletes.** `Recently followed` and `Who they keep going back to`
are gone from the digest. They were 12 Bilibili channel names each and, on
the real snapshot, they were stock-market, DOTA and bar-exam channels
spending about 200 characters to say nothing about music. They can never
satisfy the invariant — a followed account is neither a songs-only source nor
an artist match — so they leave rather than being ranked last.

**The two halves.** Under the heading the block is a **fixed half** and a
**flexible half**:

- **Fixed half — `Sources`, `Artists they return to`, `Playlists`, together
  at most `FIXED_SHARE` = a fifth of the budget, so 300 characters of the
  default 1500.** (A fraction rather than a constant, so a caller asking for
  a different budget gets the same proportions.) These three are the listener's
  shape rather than their moment: they say who this person is in the fewest
  words and read the same on every pick of the day. `Sources` is served
  first, out of **half** the half: it is one phrase per mounted source and
  cannot be shortened by dropping items, so an equal third starves it, while
  the whole half starves the other two (measured in review: six verbose
  summaries with staleness stamps took all 300 and `Artists they return to`
  vanished). `Artists they return to` and `Playlists` split what it leaves,
  equally, rolling forward. Whatever the half leaves unspent rolls into the
  flexible half.
- **Flexible half — the rest of `budget`**, claimed by weight, in this order,
  the first line rolling what it does not use forward to the second:

  | line | weight | item cap |
  |---|---|---|
  | `Lately they have been listening to` | 1 | 8 |
  | `<platform> says (top, medium term)` | 1 per source | 10 each |
  | `<platform> suggests today` | 1 per source | 10 |

  The platform lines take a **share**, they are not appended after the budget
  is spent: appended, the widened song layer pushed them off the block whole
  while the `Sources` line went on counting them (codex review).

  A line's share is `left * weight / (sum of the weights not yet served)`.
  Equal shares are the special case where every weight is 1. A line that runs
  out of room ends at an item boundary with a trailing `...`.

Why the order is this one: the first build led with what the listener
**watched** and gave the musical rows whatever was left. Measured on the
listener's own snapshots (2026-09-18: four mounted sources, 125 KB, a 1462
character digest over 8 lines), that put three Bilibili gossip clips on the
first content line, spent about 200 characters on followed accounts, and left
`Songs they keep` **14 of 186 liked songs** before the ellipsis — the other
172 were never visible to the brain at all. For choosing a song the kept
songs *are* the signal, so the budget runs in that order. The bound the old
equal-share rule existed for still holds: no one layer may eat the block,
because every layer has a ceiling before the next one is asked.

**The `Sources` line counts only what the block can show**, so it no longer
claims a Bilibili history of 200 next to a block that carries none of it.
A source left with nothing countable drops out of the line entirely, which is
the rule §2.3 already applies to a snapshot with nothing to say.

**Nothing collected is taste** (the listener's decision, 2026-09-16, taken on
their own rendered digest): a Bilibili favourites folder is where a Java
course, a recipe and an audiobook are filed, and it drowned everything
musical in the block. So Bilibili's favourites folders, their contents and
watch-later are not read at all, and YouTube's liked list is read only to
name the account (its uploader), never for its items. *Superseded in part
2026-09-18*: what they watched and who they follow is no longer the block's
signal either — it is retrieval material (the invariant above). The reads
themselves stay, because the ledger and §2.12 use them.

The render enforces this on **any** snapshot, not only a freshly read one: a
returning listener keeps yesterday's `bilibili.json` until the next refresh,
so the render drops every `favourite` row, every Bilibili `playlist` row (a
favourites folder) and YouTube's `liked` rows outright, counts included. The
kinds stay in the union so an old file still parses; nothing produces them
any more. A snapshot left with nothing to say drops out of the `Sources`
line rather than standing there as an empty pair of brackets.

**Artist counts come from the musical rows alone** (`liked`, `favourite`,
`top-artist`, `top-track`, `daily`): a watched video's uploader is not an
artist and neither is a followed channel, or a Java course channel outranks
every musician in "artists they return to". *Amended 2026-09-18*: when a
ledger exists the count is the **ledger's** count of that artist's distinct
musical entries (§2.11), not the current snapshot's — that is what makes
"they return to" a long-term claim rather than a claim about this week.

(The example above is romanised only because committed sources are
English-only; the real digest keeps every value verbatim in its own script.)

Rules: artist counts merge across sources by exact string after trim (from
the musical rows only, above);
no translation, no romanisation; items whose `title` is empty are dropped;
the block is cut to `budget` characters at a line boundary with a trailing
`…`. With no snapshots it renders `''` and nothing is injected. Stale
snapshots (older than 30 days) still render, stamped with their date — a
listener who stopped refreshing still has a taste.

**Consumers**:

*As built (review round 2)*: the reader renders only the sources
`sources.json` currently holds. A snapshot file can outlive its mount — a
corrupt file, a process that died between the unmount and the delete — and
§5.1's "no account, no change" has to hold on the file that decides, not on
whatever is left in `data/taste/`.

- **Context pack** (05 §2.2): a new optional field `taste: string`. Rendered
  after the profile, before recent turns. Talk and steer prompts receive it
  through the pack; the prompt tells the host to *know* it, not recite it
  (one line added to `src/prompts/talk.ts` and `steer.ts`: taste is
  background, mention a kept song at most when the moment earns it).
- **Music pick situation** (03-01 §2.3): the digest is appended to the
  situation the pick task receives, under the same heading, with one added
  instruction: prefer what fits the moment; the listener's kept music is a
  strong prior, not a playlist to replay.

### 2.4 Named-catalogue search in the pick task

`search_music` (in `src/music/music-tools.ts`) gains one optional argument:

```ts
catalogue: z.enum(['youtube', 'bilibili', 'netease', 'qqmusic', 'channels']).optional()
  .describe('where to search; default youtube. bilibili, netease, qqmusic and channels are available only when mounted — the tool result says which are')
```

- The tool's description lists the catalogues **currently mounted**, so the
  model never asks for one it cannot have; asking for an unmounted one
  returns `{ ok: false, reason: 'not-mounted', mounted: [...] }` and the
  model continues (non-terminating, like a failed pick).
- `MusicProvider.search(query, limit, catalogue?)` — the third argument is
  additive; existing callers unchanged.
- **YouTube**: `ytsearch{N}:` as today.
- **Bilibili**: `bilisearch{N}:` through yt-dlp (`BiliBiliSearch`), flat, and
  anonymous — a signed-in search trips Bilibili's risk control (§2.5).
- **NetEase**: the NetEase client's `search(query, limit)` (§2.7) → candidates
  whose `ref` is `https://music.163.com/#/song?id=<id>`; `resolve` then goes
  through yt-dlp with the cookie (§2.5). The client requires a mount.
- **QQ Music**: the QQ Music client's `search(query, limit)` (§2.10) →
  candidates whose `ref` is `https://y.qq.com/n/ryqq/songDetail/<mid>`;
  `resolve` then goes through yt-dlp with the cookie (§2.5). Like NetEase's,
  it requires a mount — and unlike NetEase's, it requires the **login**: the
  service answers an unsigned search `code: 0` with an empty list, a silent
  nothing indistinguishable from "no such song", so a mount carrying no
  credential is refused with `login-required` rather than returning no hits.
  **VIP hits are dropped here** (§2.5): the result rows carry `pay.pay_play`,
  and a track this account cannot play is not a candidate. The search asks for
  three times the limit (capped at 30) so the playable remainder still fills
  it — roughly two thirds of a real result page is VIP. The rights miss at
  resolve time stays as the safety net, because the flag can be stale.
- Candidates keep today's shape (`ref, title, uploader, durationS`) plus
  `catalogue`.

### 2.5 Cookie-aware resolve

`YtDlpMusicProvider.resolve(ref)` consults the mounted sources: when `ref`'s
host belongs to a mounted source, that mount's cookie is leased for the call
and released after it. How the lease is obtained follows the mount (§2.1):

- **browser mount** → yt-dlp exports the store
  (`--cookies-from-browser <browser>[:<profile>]`, Chrome always by a named
  profile — §3.1) into a jar the call loads;
- **scanned mount** → the stored header is written as a Netscape jar for that
  one call and deleted with the lease. No browser is opened, nothing is
  decrypted, and the argument yt-dlp sees is the same `--cookies <file>` it
  sees for a browser mount.

```ts
function cookieLeaser(deps): (source) => Promise<CookieLease | null>   // null when no mount applies
```

Hosts: `youtube.com`/`youtu.be`/`music.youtube.com` → youtube;
`bilibili.com`/`b23.tv` → bilibili; `music.163.com`/`163cn.tv` → netease;
`y.qq.com` and its subdomains → qqmusic. No mount → no cookie flag → today's
behaviour exactly (a listener with no account sees no change — acceptance
§5.1).

**The QQ Music rights miss — a dropped candidate, never a lost login.**
About a third of a real listener's liked list is `pay_play: 1`. For such a
track the vkey call answers `req_1.code: 0` with **every** format's `purl`
empty (`result: 104003`), yt-dlp finds no format, and — because its
`_get_uin()` reads a `uin` cookie a **WeChat** sign-in never sets, so
`is_logged_in` is false — it reports `This video is only available for
registered users`. Those are the words of a lost login and they are the wrong
reading: nothing about the mount is stale, and flipping it to `expired` would
send a signed-in listener to renew a login that works. So a rights-shaped
failure on a `y.qq.com` ref becomes its own type, never a `SourceAuthError`:

```ts
class TrackRightsError extends Error { readonly source: SourceId }   // "no rights to that track here — pick another"
function rightsMiss(source: SourceId, text: string): boolean          // qqmusic alone
```

It travels the plain-error road: `submit_pick` answers `{ ok: false, error }`,
the model picks another candidate, the `SourceAuthWatch` hears nothing, the
mount keeps `status: 'ok'` and no catalogue is closed. yt-dlp's own advice
("Use `--cookies-from-browser` … for the authentication") is stripped from the
detail, because it is the one move that cannot help here. The rights read is
QQ Music's alone: NetEase words a genuinely stale login the same way, and its
rights-less answer is the preview trap (§2.6) rather than an error.

**Where the jar does NOT go.** Two calls are anonymous on purpose, because
the cookie makes them fail:

- **YouTube playback.** Under a signed-in web client yt-dlp reports that
  "some web_embedded client https formats have been skipped … YouTube may
  have enabled the SABR-only streaming" and the googlevideo URL it prints
  answers **403** to ffmpeg, so the probe kills the pick; the same video
  resolved with no cookie probes clean. YouTube's mount therefore serves the
  taste read alone (§2.8) — with one exception: when an anonymous resolve
  fails with text `classifyAuthFailure` recognises (an age-restricted or
  private video), the resolve is retried once with the jar.
- **Bilibili search.** A signed-in `bilisearch` can answer "HTTP Error 412:
  Precondition Failed" (Bilibili's risk control on the search API) where the
  same query with no cookie returns hits. Bilibili *playback* keeps the jar —
  it resolves and probes fine with it, and needs it for the better tiers.

So the jar is for the taste reads, and for Bilibili, NetEase and QQ Music playback.

*As built (review round)*: the cookie reaches yt-dlp as a **leased jar**
(`--cookies <tmp>`, owner-only, deleted when the call returns) rather than
`--cookies-from-browser` on every spawn — yt-dlp opens and decrypts the
whole browser store per spawn, and on macOS that is a Keychain prompt per
pick unless the listener chose "Always Allow". The store is opened once per
browser per site per ten minutes (`CookieJars`, `src/music/sources/build.ts`),
only that site's rows are kept in memory, and `sources.json` still holds the
browser name alone. The YouTube list reads take the same lease.

### 2.6 Typed auth failure — the contract this spec exists to fix

Today an auth failure surfaces from `provider.resolve` as a generic error,
`submit_pick` reports `ok: false`, and the model picks another — a listener
with a stale cookie watches candidates rejected one by one with nothing on
screen naming a login. That ends here.

```ts
type AuthFailure = 'login-required' | 'expired' | 'geo' | 'rate-limited'
class SourceAuthError extends Error { readonly source: SourceId; readonly reason: AuthFailure }
```

- **Classification** is one pure function over yt-dlp's stderr / the client's
  response, unit-tested on captured fixtures: NetEase `code -462` /
  "Login required" → `login-required`; yt-dlp "Sign in to confirm" /
  "cookies are no longer valid" → `expired`; `raise_geo_restricted` text →
  `geo`; HTTP 429 → `rate-limited`. Unknown text stays a plain error.
- **`submit_pick`** returns `{ ok: false, reason: 'auth', source, detail }` —
  and the tool result text tells the model this catalogue is unavailable for
  the rest of the task, so it does not retry it. *As built*: a lost login or
  a rate limit closes the catalogue (youtube included — the default search
  answers `unavailable` then); a `geo` block is one track's problem and only
  costs that pick, since a rights-less VIP track says nothing about the
  catalogue.
- **The Director** surfaces it **once per session per source** as a host
  `info` line: *"your NetEase login has expired — type /sources to renew it;
  I'll pick from elsewhere meanwhile."* Dev log: `sources.auth <source>
  <reason>`. `sources.json` gets `status: 'expired'` (single writer: the
  Director calls the same store the `/sources` flow uses). *As built*: the
  once-per-session gate is `SourceAuthWatch` (`src/music/sources/auth.ts`),
  handed to the pick task's tools by the app and reset by a successful mount
  or refresh; the Director itself holds no auth state.
- **Taste refresh** on a failed source keeps the last snapshot and stamps the
  digest with its date; it does not blank the taste. *As built*: a mount
  whose status is `expired` is never re-read by the refresher — only a new
  mount renews it (NetEase serves a public list anonymously, so a read that
  "worked" would hide the lost login; the NetEase adapter also checks the
  account before every snapshot) — and a failed read is not retried for an
  hour, so a dead platform is not hit at every segment.
- **The preview trap** (yt-dlp issue 14142): NetEase can return a 30-second
  preview instead of the track when rights are missing, with no error. The
  resolve path treats a NetEase clip whose duration is under 45 s while the
  candidate said over 90 s as `login-required` for this pick (the stream
  probe already knows the decoded duration — 03-02 §3.1-TS). Unit-tested on
  the two durations.

### 2.7 Invitations — wire and model

```ts
type Invitation = { readonly command: '/sources' | '/bug' | '/feature-request'; readonly why: string }
// additive wire message, engine → front-end (spec 10 §3.2-D inventory):
//   { type: 'invitations', rows: Invitation[] }   — the CURRENT set; replaces the previous one
function dueInvitations(state: InvitationState, now: Date): Invitation[]     // pure
type InvitationState = {
  readonly segmentsAired: number
  readonly sessionStartedAt: Date
  readonly mounted: readonly SourceId[]         // from sources.json
  readonly filed: readonly ('bug' | 'feature')[]  // this session
}
```

`dueInvitations` is the entire policy (§3.8) and is unit-tested as a table.
The engine sends `invitations` whenever the result changes (boot, after the
first segment, at the 10-minute mark, after a mount, after a filing). The
plain host has no idle surface but its banner; it prints the boot-time set
once there and nothing later — spec 10 §3.2-C's rule stands: **no engine
line in the transcript about the program itself**.

### 2.8 The two identity clients and the NetEase search

Small, single-purpose HTTP clients under `src/music/sources/`, each a file:

- **`netease.ts`** — the plaintext `music.163.com/api` endpoints the
  platform's own web pages serve: ordinary GETs carrying the browser's cookie
  as it stands, no signing and no borrowed client key.
  Endpoints: `/api/nuser/account/get` (`who`, `userId`), `/api/user/playlist`
  (the liked-songs list is marked `specialType=5`), `/api/v6/playlist/detail`
  (`n` = the §3.5 cap: one read returns the whole list titled *and* dated —
  `trackIds[].at` is when each was kept), and `/api/search/get` (type song),
  which answers anonymously and needs no cookie at all.
  **Sign-in (scan)**: `GET /api/login/qrcode/unikey?type=1` → `{code:200,
  unikey}`; the code encodes `https://music.163.com/login?codekey=<unikey>`.
  `GET /api/login/qrcode/client/login?key=<unikey>&type=1` polls, and its
  whole answer is its own `code` — **801** waiting · **802** the phone has it
  · **803** confirmed, the cookie arriving as `Set-Cookie` (`MUSIC_U` and
  friends, collected into one header) · **800** the code is spent. Any other
  code reads as waiting; the loop's deadline is what ends it. Verified
  against the live endpoints 2026-09-15.
  Cookie, for a mount made before the scan existed: read from the browser
  store **through yt-dlp** — `yt-dlp --cookies-from-browser <b> --cookies <tmpfile> …` writes
  a Netscape jar the client reads and deletes after the call (no second
  cookie-store reader to maintain; the jar never persists). *As built (review
round 2)*: the export is coalesced per browser per site — a cold YouTube
snapshot reads three lists at once and they share one browser-store unlock —
and an export that found nothing for the site is never cached, so a listener
who signs in and retries at once reaches the browser again rather than the
empty answer from a minute ago.
- **`bilibili.ts`** — **sign-in (scan)**: `GET
  passport.bilibili.com/x/passport-login/web/qrcode/generate` → `{code:0,
  data:{url, qrcode_key}}`, and the platform's own `url` is what the code
  encodes. `GET …/web/qrcode/poll?qrcode_key=<key>` polls; the envelope is
  `0` throughout, so the answer is the code **inside** `data` — **86101**
  waiting · **86090** the phone has it · **0** confirmed, with `SESSDATA`,
  `bili_jct` and `DedeUserID` arriving as `Set-Cookie` · **86038** the code is
  spent. Verified against the live endpoints 2026-09-15.
  Then `x/web-interface/nav` (who, `mid`), and the taste reads, all from the
  same web APIs yt-dlp's extractors call (yt-dlp's flat output for these
  lists carries ids alone, and a taste is titles — so the client reads the
  JSON directly). Verified against the live endpoints 2026-09-16:
  `x/web-interface/history/cursor?ps=30&business=archive` — the watch
  history, newest first, each row carrying the title, `author_name`,
  `view_at` and `tag_name`, which is Bilibili's own sub-zone and becomes the
  item's `category`; the next page is asked for with the `max` and `view_at`
  the last page's `cursor` handed back.
  `x/relation/followings?vmid=<mid>&ps=50&pn=1` — the accounts followed, the
  platform's default order being follow-time descending (`uname`, `mtime`,
  `mid`) → `follows`; the same read with `&order_type=attention` is ordered
  by how often the listener visits them → `frequents`.
  `audio/music-service/web/song/upper` — the account's own audio uploads.
  The favourites folders, their contents and watch-later are **not** read
  (§2.3: collected is not taste). Playback still goes through yt-dlp with
  the cookie (§2.5).
- **`spotify.ts`** — OAuth 2.0 **PKCE** (no client secret) against the
  listener's own registered app (`clientId`); local redirect
  `http://127.0.0.1:39917/callback` (*as built*: a registered redirect URI
  must match exactly, port included, so the port is fixed and falls back to
  an ephemeral one only when taken — the conversation prints whatever was
  bound); scopes `user-top-read
  user-library-read playlist-read-private`; refresh handled on expiry;
  endpoints `/me`, `/me/top/artists`, `/me/top/tracks` (`medium_term`),
  `/me/tracks` (paged), `/me/playlists` (names). Browser opened through the
  Director's injected `openUrl` — never launched from a test.
- **`qishui.ts`** (*as built*: a dead session answers the account endpoints
  with HTTP 200 and a non-zero status, which parses as empty lists — so that
  status is read as the login being gone, or a refresh would silently replace
  the last good snapshot with nothing) — the Luna app transport (`User-Agent: Luna/<ver> Android`,
  cookie header, JSON): QR issue + status poll (the QR is scanned with
  **Douyin**, not the Soda app — the upstream flow's own text says so), `me`,
  own playlists, collection, daily mix. The QR is rendered in the terminal
  as UTF-8 half-blocks via the `qrcode-generator` package (**the one new
  dependency**: MIT, zero runtime dependencies — *as built*: `qrcode` on npm
  carries three, so the zero-dependency encoder is the one that clears
  ponytail rung 5). The daily mix answers a bare session with the app's
  "not for this caller" status; that read is then empty, never a failure.
  No decryption code exists anywhere in murmur.

Both scan flows run the **same loop** (`qr.ts`): draw the code, poll every
`QR_POLL_MS`, give up after `QR_TIMEOUT_MS`, Esc checked on both sides of the
wait. A confirmation that arrives without a cookie is *not* a sign-in — it
waits out the deadline, because a mount with no credential is worse than a
fresh code. Soda Music keeps its own passport flow (§6) and shares the
cadence.

Every client: timeouts, one retry on network error, no retry on auth error,
rate-limit → `rate-limited`. Every response parsed with zod at the boundary
(trust boundary — CLAUDE.md types rule).

### 2.10 The QQ Music client — taste, search and a playable ref

**`qqmusic.ts`** — one endpoint does all of it: `POST
https://u.y.qq.com/cgi-bin/musicu.fcg`, whose body names a `module` and a
`method` and whose answer is `{code, req:{code, data}}`. The **inner**
`req.code` is the real one; the envelope is always HTTP 200 with an outer
`code: 0`. Nothing is **played** here: this client identifies the account,
reads what it keeps and answers the search catalogue (§2.4). Playback is
yt-dlp's, through the same mount's cookie (§2.5) — a song's `ref` is
`https://y.qq.com/n/ryqq/songDetail/<mid>`, which is exactly what that
extractor takes, and the search is what puts such a ref in the brain's hands
in the first place.

**Credential — the browser's own.** A signed-in `y.qq.com` jar carries
`qm_keyst` (the key, also spelled `qqmusic_key`), the account number as `uin`
(a QQ sign-in) or `wxuin` (a WeChat one), and `euin`, its encrypted form —
the lists are addressed by the encrypted one. Every signed-in read carries
those cookies plus `g_tk = hash33(key, 5381)` in the `comm` block
(`ct:24, cv:4747474, platform:'yqq.json'`). yt-dlp exports one row per
domain, so a name can appear twice (`.qq.com` and `.y.qq.com` both carry
`qm_keyst`); the first non-empty one wins. A jar with no key or no uin holds
no login, and is answered **without a round trip**.

Modules, verified against the live service 2026-09-16:

| what | module.method | param |
|---|---|---|
| who am I | `music.UserInfo.userInfoServer.GetLoginUserInfo` | `{}` → `data.info.nick` |
| created lists | `music.musicasset.PlaylistBaseRead.GetPlaylistByUin` | `{uin}` → `data.v_playlist[]` (`dirId`, `dirName`, `tid`, `songNum`) |
| liked songs | `music.srfDissInfo.DissInfo.CgiGetDiss` | `{dirid:201, song_begin:0, song_num:<§3.5 cap>, enc_host_uin:<euin>, …}` → `data.songlist[]` |
| favourited lists | `music.musicasset.PlaylistFavRead.CgiGetPlaylistFavInfo` | `{uin:<euin>, offset:0, size:<§3.5 cap>}` → `data.v_list[].name` |
| search | `music.search.SearchCgiService.DoSearchForQQMusicDesktop` | `{query, search_type:0, num_per_page, page_num:1, highlight:0}` → `data.body.song.list[]` |

- **`dirid` 201 is the liked list**, fixed across accounts — its *name* is
  localised, its dir id is not. It is one of the created lists, so it never
  also contributes a playlist name.
- **One read, no paging.** `song_num` at the §3.5 cap returns the whole list
  (verified against a 167-song list). A song carries `mid`, `name`,
  `singer[].name`, `album.name` and `interval`, but **no kept-at date** —
  `time_public` is the release date, not when the listener kept it — so the
  liked items carry no `at`, and the digest orders them as the platform did.
- **Search needs the signed-in cookie, and says so.** The same query answered
  5 hits signed in and **0 hits, `code: 0`** anonymously (verified
  2026-09-16). A silent empty page is the worst possible failure here — it
  reads as "no such song" — so a credential-less mount is refused before the
  round trip. `highlight: 0` keeps the service from wrapping the matched words
  in markup that would reach the brain inside the title. A hit carries `mid`,
  `name`, `singer[].name`, `album.name`, `interval` and `pay.pay_play`.
- **The login is checked first, every snapshot.** With the key flipped,
  `GetLoginUserInfo` answers `code 1000` but `GetPlaylistByUin` **still
  returns the account's lists** — it authenticates on the `uin` alone. A
  snapshot that skipped the check would read a signed-out account as healthy
  and never say "expired". The who-am-I answer is also what the reads are
  addressed with, so the check costs nothing extra.
- **Auth failures**: inner `1000` / `104401` / `104400` → `login-required`;
  inner `104604` and HTTP 429 → `rate-limited` (§2.6). The existing
  expired/reconnect road then works unchanged.
**Sign-in — the WeChat scan, or Chrome** (§3.1). Both roads end in one
cookie header, so nothing downstream learns which was taken.

The scan, verified against the live endpoints 2026-09-16:

1. `GET open.weixin.qq.com/connect/qrconnect?appid=wx48db31d50e334801&…`
   answers a page carrying a `uuid`. The platform also serves the code as a
   JPEG, but murmur draws its own: the image encodes
   `https://open.weixin.qq.com/connect/confirm?uuid=<uuid>` (decoded from the
   served file), which `qrHalfBlocks` renders like every other scan here.
2. `GET lp.open.weixin.qq.com/connect/l/qrconnect?uuid=…` is a **long poll**
   — the platform holds it ~15 s — whose body is
   `window.wx_errcode=<n>;window.wx_code='<code>'`. **408** waiting · **404**
   scanned, waiting for the confirm · **405** confirmed, the code in
   `wx_code`. `402` / `403` (expired, refused) were never reached in the
   capture and are **not claimed**: an unknown code reads as waiting, and the
   scan loop's own deadline ends it — the same rule §2.8 states for NetEase.
   Because the loop only hears a stop between polls, the poll carries its own
   12 s patience: a listener pressing Esc is not held for the platform's hold,
   and a timed-out poll reads as waiting, which is what it was.
3. `music.login.LoginServer.Login` (`param {code, strAppid}`, `comm
   {tmeLoginType: 1}`) exchanges the code for the credential.

**`str_musicid`, never `musicid`.** The exchange answers with both. The
account number is 19 digits, and `JSON.parse` rounds it through a double: a
real uin of `…943987` comes back from `musicid` as `…944000`, and reads
addressed with that number target an account that does not exist.

**The scanned entry is a cookie header**, minted from the credential —
`uin` / `wxuin` = `str_musicid`, `qm_keyst` / `qqmusic_key` = `musickey`,
`euin` = `encryptUin` — and stored in §2.1's existing scanned arm
(`{auth:'qr', cookie}`). `credentialFrom()` parses it exactly as it parses a
browser jar, so the scan adds no second read path. A mount made before the
scan existed carries no `auth` key and keeps parsing as the browser arm.

**The account is read back before it is mounted.** The exchange also returns
a `nick`, but it comes back **blank** for a returning listener, so the name
is taken from the credential's own first `GetLoginUserInfo` — which also
proves the minted cookie signs in, so no mount is ever made on a credential
that does not work.

---

### 2.9 Curated music channels — a place to LOOK, never taste

> *Added 2026-09-16.* A committed list of music channels becomes an extra
> **search source**. It is not a taste source and must never be read as one.

**The one distinction.** The listener's own accounts (§2.2/§2.3) decide **what
kind** of song to look for. The curated channels are one of the **places to
look for it**. Nothing from this list may enter the taste digest ("What the
listener keeps", §2.3) or the situation block (spec 03-01 §2.5) — those speak
about the listener, and a channel someone else curated says nothing about them.
Code-wise this is structural: `src/music/channels.ts` never imports the digest
and is never handed to the pack.

**The manifest** — `assets/music_channels.txt`, exactly the shape of
`assets/bed_sources.txt` (spec 03-04): one URL per line, blank lines and `#`
comments ignored, anything that is not an `http(s)` URL skipped. Adding a
channel is adding a line. Two shapes are understood:

| Shape | Read by |
|---|---|
| `https://www.youtube.com/@<handle>/videos` | yt-dlp `--dump-json --flat-playlist` |
| `https://space.bilibili.com/<mid>/video` | Bilibili's own space API, wbi-signed |

**Runtime refresh.** The list is re-read from
`https://raw.githubusercontent.com/wine-fall/murmur/main/assets/music_channels.txt`
so a channel added upstream reaches a listener **without a release**. Cached at
`$MURMUR_HOME/cache/channels/manifest.json` (rebuildable → `cacheRoot`, never
`~/.cache`) with a **12 h** TTL: the file changes when a human edits the repo,
so hourly polls a constant and a week makes an added channel feel broken. The
fallback chain is total and never throws — cache inside TTL → fresh fetch →
stale cache → **the copy that shipped**. A body with no URLs in it (a 404 page,
a half-written file) is treated as a failure, not as "the list is now empty".

**The pool.** Each listed channel's newest **20** uploads (title, ref,
uploader) are pulled into `$MURMUR_HOME/cache/channels/pool.json`. A channel
that fails costs that channel; a refresh where **nothing** answers keeps the
pool it already had, so the catalogue never silently unmounts. A refresh that
was **attempted** is not attempted again for `RETRY_MS` (1 h) whatever its
outcome — the taste refresh's own cooldown, and the reason an offline listener
does not respawn yt-dlp over the whole list once a song. Refreshed on the
**same clock as the taste refresh** (§3.4, `STALE_MS` = 24 h) and through the
same shape — a staleness gate plus a single-flight guard, poked from the music
pipeline at a pick boundary. There is **no second scheduler**.

**Why Bilibili needs a signature.** yt-dlp's flat read of a space
(`--flat-playlist https://space.bilibili.com/<mid>/video`) returns the refs with
**every title empty** — measured — and a pool searched by title is useless
without them. Bilibili's own listing (`/x/space/wbi/arc/search`) carries the
titles and refuses an unsigned request, so `src/music/sources/wbi.ts` signs it:
the two image URLs in the anonymous `nav` answer spell a 64-char raw key, a
fixed permutation of it cut to 32 is the **mixin key**, and the sorted query
plus `wts` is md5'd with that key appended as `w_rid`. The request also carries
a site-issued `buvid3` and the web player's constant fingerprint fields —
without them the same correct signature is answered `412`. Everything here is
**anonymous**: the channels are public, so this never touches the listener's
cookie or a mounted Bilibili account.

The signing material is re-read once it ages past **10 minutes**: Bilibili
rotates the keys, one handshake serves a whole refresh, and a process that runs
across a rotation must not go on signing with a dead key (yt-dlp's own
extractor gives it a short TTL for the same reason). The request deadline
covers the **response body**, not only the headers — reads are serial, so one
stalled body would otherwise hold the refresh and its single-flight lock open
for good.

*Measured ceiling (2026-09-16):* Bilibili rate-limits a burst of space reads
per IP with `412` and an HTML body. Reads are spaced 1.5 s and a failed channel
is simply skipped; a daily refresh that loses a channel picks it up the next
day. If a listener's list ever grows to many Bilibili channels, the upgrade is
a longer spacing or a resume across refreshes — not a retry loop.

**The catalogue.** `search_music(catalogue: 'channels')` is a **local**
substring match over the pool on **title and uploader** — every word of the
query has to land — with **no network at search time**. It returns the same
`TrackCandidate` shape as every other catalogue, so `submit_pick` resolves the
ref through the unchanged yt-dlp path (§2.5). Like the other catalogues it is
offered **only while it holds something**: an empty pool is not mounted, and
asking for it returns the same `{ ok: false, reason: 'not-mounted' }`.

**A chapter is a song.** *(Added 2026-09-16.)* A city-pop or lofi channel
uploads one **1.5-2 h** file and marks each song as a **YouTube chapter**
(`@90sNeonSoul` is the case that motivated this: `kx22t0PBrKM` is 7506 s with
16 chapters, `ZD8G8Bo40-w` 5987 s with 29). Played whole that upload is not a
song at all; played per chapter it is twenty. So the pool reads chapters and a
**chapter becomes one candidate**:

- **The mix threshold** — `MIX_DURATION_S` = **12 min**. Under it, an upload is
  a song and reaches the pool exactly as it did before. Over it, the upload has
  to justify itself with chapters, and **a long upload with no chapters is
  dropped** — `@MidnightHavenJazz`'s 68-minute mixes carry zero chapters and
  zero description timestamps, and nothing about them is a track. Twelve
  minutes clears the longest thing anyone calls a song and is far under the
  shortest thing anyone calls a mix. A duration of **0** is *unknown*, not
  long: a live stream or an extractor that omits the field keeps today's
  behaviour.
- **Where the chapters come from.** The flat listing the pool is built from
  carries **no chapters** — measured. A chaptered upload therefore costs **one
  full-metadata call** (`yt-dlp --dump-json <video>`, no `--flat-playlist`),
  whose `chapters: [{start_time, end_time, title}]` is the song list. That is
  paid **once per upload, ever**: the expansion is cached at
  `$MURMUR_HOME/cache/channels/chapters.json`, keyed by the upload's ref and
  bounded at 500 entries. A video that will **not** answer is remembered as
  nothing, exactly like a mix: otherwise the same handful of failing uploads
  would spend the whole budget every refresh and the good ones behind them
  would never be read. The cost of that choice is one transiently-failing
  upload dropped from a pool that holds dozens.
- **The call budget** — `CHAPTER_LOOKUPS_PER_CHANNEL` = **4** per channel per
  refresh. Only a long upload is ever asked, the cache answers the rest, and a
  daily refresh therefore adds at most a few seconds of network per channel.
  A channel's remaining long uploads are read on a later refresh.
- **Which chapters count.** Dropped: yt-dlp's placeholder run-up chapter
  (`<Untitled Chapter N>`, the intro before the creator's first marker);
  anything shorter than `MIN_CHAPTER_S` = **45 s** (an intro, an outro, a
  sting); and anything **longer than the mix threshold** — a real playlist's
  closing "Replay The Vibes" chapter is a 3754 s re-run of its own first half.
- **The caps** — `MAX_CHAPTERS_PER_UPLOAD` = **12** (an evening's worth from a
  single file) and `TRACKS_PER_CHANNEL` = **40**, so 20 uploads x 29 chapters
  cannot swamp the catalogue and crowd out every other channel.
- **The old pool is discarded once.** `pool.json` carries a version; the
  chapter rules changed what belongs in a pool, so a file written before them
  reads as no cache at all. Without that, a listener whose channels are all
  long-mix uploads would hit the "nothing answered, keep what we had" rule and
  keep serving the very mixes these rules exist to drop.
- **A segment that cannot play is refused at resolve.** If the resolved source
  is shorter than the segment claims, `resolve` throws rather than hand back a
  clip that would seek past the end and decode nothing — ffmpeg **exits 0**
  doing that, so the playability probe would wave it through and the announce
  would cover silence. `submit_pick` turns the throw into "pick another".
- **The candidate.** A chapter's `ChannelTrack` carries the **chapter title**
  as its title, the **channel** as its uploader, the **chapter's length** as
  `durationS`, and as its ref the upload's own url plus a **W3C media
  fragment**, `#t=<start>,<end>` in seconds
  (`https://www.youtube.com/watch?v=kx22t0PBrKM#t=612,868`). `sourceOfRef` keys
  on the hostname, so nothing about the mount, the cookie rule or the stream
  headers changes; yt-dlp resolves the fragment-carrying url exactly as it
  resolves the bare one (verified), and `resolve` strips it anyway. What the
  fragment becomes on the clip is spec 03-01 §2.2's business.

**What the model is told** (`CHANNELS_GUIDANCE`, `src/prompts/music.ts`), one
sentence rendered only while the pool is non-empty: the catalogue searches
recent uploads from a curated list of music channels — good for something new,
a cover, or a recent release a plain search would bury. That sentence is about
**where to look**. It must not describe the listener.

### 2.11 The ledger — what accumulates, next to the snapshot that does not

*Added 2026-09-18.* A snapshot is the **latest read**: `refreshOne` overwrites
the whole file, and `BOUNDS.history` = 200 is a rolling window, so three
months of listening leaves murmur knowing the last 200 plays and nothing
else. The ledger is the other half of that: one **append-only** file per
source, beside the snapshot, that only ever grows.

```ts
const LedgerEntrySchema = TasteItemSchema.extend({
  key: z.string(),        // the dedup key, below
  firstSeen: z.string(),  // ISO, the takenAt of the read that first saw it
  lastSeen: z.string(),   // ISO, the takenAt of the most recent read that saw it
  seen: z.number().int(), // how many reads saw it — a refresh count, never a play count
})
const TasteLedgerSchema = z.object({
  source: z.enum(SOURCE_IDS),
  updatedAt: z.string(),
  entries: z.array(LedgerEntrySchema),
})
```

- **Path**: `data/taste/<source>.ledger.json`, written by the same atomic
  `tmp + rename` at mode `0600` the snapshot uses. It is listener data by the
  same definition; `unmount` deletes it with the snapshot (§3.1), and
  `dropSnapshot` drops it too — a remount of a different account must not
  inherit the old one's history.
- **Dedup key**: `ref` when the item has one, otherwise
  `<kind>|<title trimmed>|<artist trimmed>`. Same key = same entry.
- **The merge**, on every read that returned a snapshot: for each item, an
  unseen key is appended with `firstSeen = lastSeen = snapshot.takenAt` and
  `seen = 1`; a known key keeps its `firstSeen`, takes the new `lastSeen`,
  increments `seen`, and takes the newest reading of `title`, `artist`,
  `album`, `category` and `ref`. **Nothing is removed by a read** — an item
  that fell out of the 200-row window stays in the ledger. A **partial**
  refresh (§3.4) merges only the kinds it read; the kinds it did not read are
  untouched.
- **The byte cap**: `LEDGER_MAX_BYTES` = 4 MB, four times the snapshot cap
  because a ledger is meant to accumulate. Past it, entries are dropped
  **oldest `lastSeen` first** until the file fits, and the drop is logged as a
  count only (`sources.ledger <source> dropped=<n>`, §3.6 — never a title).
  A ledger file that fails to parse is renamed aside once and started fresh
  rather than blocking the refresh.
- **`seen` is a refresh count.** A liked song is seen by every read that
  reaches it, so `seen` says how long murmur has known about the item, not
  how often the listener played it. Nothing may present it as a play count.
- **The read clock rides here, not in `sources.json`.** The ledger file
  carries `lastRead: { [kind]: iso }` — when each of this source's lists was
  last asked for (§3.4). `sources.json` is the secret-bearing file (a Spotify
  refresh token, a scanned cookie) and a three-hour clock would rewrite it
  eight times a day to record something that is rebuildable bookkeeping, not
  a credential. A missing or unparsable `lastRead` means every kind is due,
  which is one full read and then the new clock.
- **What reads it**: the `Artists they return to` count (§2.3) and the
  moment-matched half (§2.12). The digest's other lines still come from the
  snapshots, which keep meaning exactly what they mean today.

### 2.12 The moment-matched half — chosen in code, before the prompt

*Added 2026-09-18.* The flexible half of §2.3 renders the same rows on every
pick of the day. This section replaces **what goes into** `Songs they keep`
and `Lately ...` with a selection made against the ledger for the moment the
pick is happening in. The fixed half, the budget and the line shapes are
unchanged.

**Scope: the pick, not the pack.** `TasteReader` keeps today's no-argument
`digest()` — memoised on the snapshot files' mtimes — and that is what the
context pack (05 §2.2) hands talk and steer. The Director's
`buildMusicSituation` call gets `digest(moment)` instead. Talk needs to know
who the listener is, not which songs match this minute; a conversation prompt
whose song list moved every beat would only tempt the host into reciting it,
and the pack's memoisation would be gone for nothing.

**Red lines** (the reason this is a section and not a tool):

- It runs **in code, before the situation string is assembled**. No new tool
  is offered to the brain, and no extra model call is made. The adapter the
  Director takes is built in `buildTaste` beside the reader, not spelled out
  at the call site: written out there, `digest` was given no moment
  parameter and dropped it silently, so every real pick got the static
  render while the tests were green. A pick's median
  is already 142 s (measured 2026-09-18); this step may not add to it.
- Its budget is **5 ms on the listener's machine**, asserted in its own test
  as the **median** of fifteen warmed runs over a 4000-row ledger (measured
  2.5 ms, 2026-09-20). A median, because one scheduling stall is not what the
  budget is about and a mean lets that stall fail a green build. The bound is
  **scaled on CI** (25 ms): a shared runner is about three times slower
  (8.1 ms measured there), and a flat wall-clock number that only holds on
  one class of machine is the flake issue #269 already costs. What the test
  is for is a blow-up -- a per-row tokenise, an index build -- which is an
  order of magnitude, not a factor of three. It is a local scan, nothing
  more.
- With no ledger, no musical entries, or no usable signal, it returns exactly
  what §2.3 renders today. Degrading is silent and is the default.

**Inputs** — all four are already in the Director's hand at pick time:

| signal | where it comes from | how it is used |
|---|---|---|
| the local hour | the Director's clock | a bucket word (`morning`, `afternoon`, `evening`, `night`, `late night`) joined to the query terms |
| the persona's key | the persona line the Director already holds | its content words joined to the query terms |
| the last three songs' artists | the **last three** of the pick's avoid-list (03-01 §2.3) | an **exclusion**: no entry crediting those artists is chosen |
| the last talk beat | the transcript the pack already carries | its content words, tokenised, are the query terms |

**Tokenising**: the **query** is built with `src/memory/recall.ts`'s exported
`queryTokens()` — latin words lowercased and split on non-word characters,
CJK runs shingled into overlapping bigrams. A small stop list drops the
function words and terms are capped at 24, so a long talk beat does not
become a long query.

The **rows** are not tokenised. Tokenising every ledger row on every pick
cost 4.3 ms of the 5 ms budget on a 4000-row ledger (measured 2026-09-20), so
a row is scanned instead: its title, artist and album lowercased once, then
each term tested against it — a latin term at a word boundary, a CJK bigram
as a plain substring, which is the same match shingling both sides produces.
Same answer, no per-row allocation, 2.5 ms.

**Matching and score** — per ledger entry of a musical kind, highest wins:

| rule | score |
|---|---|
| a query term equals the entry's artist or playlist name (trimmed, case-folded) | 3 |
| a query term is a prefix of it, or it is a prefix of a query term | 2 |
| a query term appears among the entry's title / artist / album tokens | 1 |
| the entry came from a music sub-zone (`isMusicCategory`) | `+0.5` |
| **gone-quiet penalty** | `-1` when `lastSeen` is older than the source's most recent read |
| the entry's artist **carries** a last-played name | the entry is dropped |

The exclusion is by **credit, not by string**: `Corin Vanterpool & Static
Meadow` *is* the band the listener just heard, and an equality test offers it
straight back (found on the fixture). The last-played name is matched inside
the credit at a word boundary, so a collaboration and a `feat.` go with it
while a band whose name merely starts the same stays.

The **gone-quiet penalty** is how an unliked song fades. The ledger never
deletes (§2.11), so a song removed from the collection a year ago is still
there — but the next full read of that list does not touch its `lastSeen`,
so it falls behind everything still in the collection. It can still surface
when the moment matches it strongly, which is the intent: un-liking is
usually tidying, not distaste. No `retired` flag, no distinction between a
complete read and a bounded one.

Ties break by `lastSeen` newest first, then by the ledger's own order, so the
selection is deterministic for a given ledger and moment.

**No index.** The scan is a loop over the ledger's entries in memory. The
listener's four mounted sources hold about 790 rows today and a year of
accumulation is a few thousand; a few thousand rows against at most 24 terms
is microseconds, well inside the 5 ms budget. What is reused from
`src/memory/recall.ts` is its **tokenising** — the exported `shingle()` and
`queryTokens()`, which already handle the CJK bigram problem — and nothing
else. No `taste.db`, no second FTS table, no index to keep in step with the
ledger, and no `node:sqlite` load on the pick path.
*The upgrade path, if the timing assertion ever fails*: an FTS5 table in its
own file `data/taste/taste.db`, built the way `recall.ts` builds its index and
sharing none of its tables — a kept song is not a memory, and the
conversation's recall must never start returning song titles.

**Only the last three.** The pick's avoid-list is up to 256 songs over seven
days, and handing all of them over as artists deletes a week of a collection
from the selection -- and costs 10 ms of the 5 ms budget (measured
2026-09-20). The moment takes the last three of it; the song-level
avoid-list keeps its own, wider window.

**Per source.** A source with a usable ledger is chosen from it; a source
whose ledger is missing, unreadable or empty keeps the rows its snapshot
already has. Pooling from the ledgers alone dropped a whole account from the
pick while the `Sources` line went on counting it.

**No match, no reordering.** When no term reaches any row the selection
answers **nothing**, and the render is byte-identical to the one without a
moment. Ordering the pool by `lastSeen` instead would not be that render:
`lastSeen` is a READ time, so every row of one refresh shares it and ties
fall to insertion order. The category bonus and the gone-quiet penalty do
not count as a match -- they rank rows the terms already reached.

**What is selected**: every musical row, ordered by score, cut by §2.3's own
line caps (40 songs, 8 watch rows) and the flexible half's weights. So
**relevance decides the order and the budget still decides the length** — the
ten or fifteen rows the moment actually matched lead, and the rest of the
line fills behind them rather than being left empty. With no terms every row
scores 0, the order falls back to newest first, and the render is what it was
before this section existed: an unmatched pick, a source with no ledger and a
silent moment all degrade by the same path, not by a special case.

### 2.13 Play-source preference — found anywhere, played from the fastest

Where a song is **found** and where it **plays from** are two decisions, and
only the first belongs to the model. NetEase's CDN delivers ~59 KB/s to a
developer machine here while yt-dlp's `bestaudio` picks its FLAC (~1 Mbps),
so a NetEase pick stutters that the same song on YouTube or Bilibili would
not (measured 2026-09-20 on one Chinese track; related: issue #272, NetEase
resolve slowness — this routes around it and does not fix it).

So after `submit_pick` has a ref and before the resolve, code — never the
model — tries to **relocate** the pick to a faster catalogue:

```ts
playOrder: readonly ('youtube' | 'bilibili' | 'qqmusic' | 'netease')[]   // default in that order
```

**When relocation is skipped**, and the original ref goes straight down
today's path:

- the ref is a **segment** ref (`parseSegmentRef` yields a segment) — a
  chapter of one specific upload has no equivalent elsewhere;
- **no title** was submitted — there is nothing to match a hit against;
- the ref's own catalogue is already **top-ranked** among the catalogues open
  in this task. A ref whose host is unknown (or is YouTube) counts as
  `youtube`; a `channels` pick is a YouTube or Bilibili upload and is read by
  its host like any other ref.

**Otherwise**, walk `playOrder` from the top down to (excluding) the ref's own
catalogue, visiting only catalogues that are **mounted and still open** in
this task. For each:

1. `provider.search(`${artist ?? ''} ${title}`.trim(), 5, catalogue)`;
2. take the **first** hit whose folded title contains the submitted folded
   title (or the reverse) **and** whose `durationS` is within **20 s** of the
   length the original candidate stated (no stated length → accept any);
3. `resolve` and probe it exactly as the original path would — including the
   preview trap, which still applies only when the *relocated* target is
   NetEase.

The first success wins and its clip becomes the pick's. Any failure — no hit,
a resolve error, a dead probe, a `SourceAuthError` — falls to the next
catalogue; an auth failure during relocation still goes through `authResult`
so that catalogue closes for the task, but it does **not** end the submit.
All of them failing is not a failure: the submit continues with the original
ref through the unchanged existing path. The finished pick keeps the model's
`title`, `artist` and `announce` — **only the clip changes**.

**ponytail: the match is containment plus a 20 s window, nothing more.** No
fuzzy distance, no pinyin folding, no romanisation table — a wrong relocation
plays a different song, so the ceiling is deliberately a rule that is cheap to
read and easy to fail closed on. Upgrade path, if real use shows misses worth
paying for: fold both sides through the same converter `folded()` names, and
score candidates rather than taking the first.

**The knob.** `playOrder` is a **settings-layer** knob (spec 12), like
`musicEnabled` and `musicEveryN`: it lives in `~/.murmur/settings.json`, it is
set from the /sources card below, and it is read **per submit** through a
getter — never a value captured at boot — so a change lands on the next pick
rather than the next launch. Layering is the settings layering: file < env <
flag. The env override is `MURMUR_PLAY_ORDER`, comma-separated, with the same
warn-and-default posture as the other `MURMUR_*` music knobs: parsed to a
de-duplicated list of `youtube|bilibili|qqmusic|netease`, with any catalogue
the list omits appended in default order (`MURMUR_PLAY_ORDER=bilibili` means
bilibili first, the rest as they were). An unknown token is rejected — the
whole value is ignored with one warning and the default stands. **The stored
list always holds all four**, mounted or not, so an unmounted catalogue keeps
its place and resumes it the day it is connected.


**The card** (spec 10 §3.2-B, single-select, `multi: false`), reached from the
/sources menu's `( play order )` action row and re-rendered **in place** after
every pick:

```
Play from which first? (a pick moves it to the front)
ok play order: Bilibili > YouTube > QQ Music > NetEase     <- the previous pick
>> 1) [x] Bilibili - 1st
>> 2) [ ] YouTube - 2nd
>> 3) ( done ) - keep this order
```

- One option row per catalogue **currently mounted** (YouTube always; the rest
  as `sources.json` says), listed in the current play order and labelled with
  its rank, the current first ticked. Unmounted catalogues are not shown.
- **A pick moves that catalogue to the front**, everything else keeping its
  relative order; it is persisted at once and the same card is drawn again.
- `( done )`, or Enter with the current first still selected, returns to the
  /sources menu, which leads with `ok play order: <A> > <B> > <C> > <D>` — or
  `ok play order unchanged` when nothing moved.
- **Esc abandons the visit**: the order that stood when the card opened is
  restored, however many picks were made inside it, and the menu comes back
  with `ok play order unchanged`.
- Plain host: numbers or names, the same one-word-fails-the-line rule as the
  menu itself. **A list answers with its ticked row and, on a button press,
  that button's key** (spec 10 §3.2-D) — `youtube done`, not `done` — so the
  answer is read as the words it is, and the row's own key is an answer
  everywhere a label or a number is (*codex review, 2026-09-20: the TUI sends
  `playOrder`, which no label or name could match*).
- **The stored order is completed at the settings boundary**: a hand-edited
  `settings.json` holding a short or repeating list is filled out in default
  order rather than refused, because the card can only promote what it shows
  and a short list would hide a catalogue with no way back.

Matching a relocation candidate carries one more rule than containment and the
window: a hit may carry **no recording marker the submitted title did not**
(karaoke, instrumental, cover, remix, and their Chinese spellings), and the
artist must appear in the hit's title or uploader when one was submitted. A
stated length of `0` is yt-dlp's "unknown", not a length to hold a hit
against. All three fail closed to the original ref.

ponytail: promotion is the whole vocabulary — no drag, no move-up/move-down,
no rank typing. Three picks put four catalogues in any order, and one key per
visit is the smallest thing that can. Upgrade path, if four ever become
twelve: a second key for demotion.

**The dev log** (§3.6 applies: lengths, never words). One line per submit that
attempted a relocation, through the same sink as `music.search` /
`music.resolve` / `music.probe`:

```
music.relocate from=netease to=youtube ok
music.relocate from=netease none reason=no-hit        # also: dead | resolve-failed | auth
```

**What the prompt says** (§3.3, revised): search wherever the song is likeliest
to be **found** — NetEase and QQ Music for Chinese-catalogue depth, Bilibili
and YouTube as well — because where a pick plays from is decided after
`submit_pick`. Choose the best song, not the best source.

---

## 3. Design

### 3.1 `/sources` — the only entry

A typed command in `COMMANDS` (10 §3.2-C) whose one blurb is the
invitation's *why* (§3.8) — there is no second "hint" wording. It runs on the same floor-parking the `/setup` recall uses (03-03,
amended 2026-08-19): the Director parks its loop, music plays on, the
conversation runs through `Host.ask` / `info`, and the loop resumes.

The conversation is **deterministic** — a small state machine, unit-tested
with a scripted host. *Revised 2026-09-14*: the menu is a **list to tick**,
not a line to type. One `ask` (10 §2.3) carries the rows as `options`
(`multi: true`) and the same rows numbered in its text, so a front-end
without a list surface reads the same card:

```
which accounts should I read? Enter with nothing changed leaves
ok connected NetEase — signed in as Chen X · 312 liked   ← last submit's results
>> 1) [ ] YouTube - not connected
>> 2) [ ] Bilibili - not connected
>> 3) [x] NetEase - 312 liked · read just now
>> 4) [x] Spotify - expired — untick to forget it, tick refresh to sign in again
>> 5) [ ] Soda Music - not connected
>> 6) [ ] QQ Music - not connected
>> 7) ( refresh now ) - re-read every connected account now   ← only once something is mounted
>> 8) ( play order ) - which catalogue a found song plays from first
```

- **Ticked = mounted**, an expired login included: unticking it is how it
  is *forgotten* — entry and snapshot gone — without a sign-in the listener
  may not be able to give (codex review). Nothing connected → no refresh
  row.
- **The answer is a `line`**: the ticked keys in row order, space-joined
  (`netease refresh`), `''` for nothing ticked. The TUI's list produces it
  (10 §3.3); the plain host's listener types numbers or names
  (`3`, `netease`, `NetEase`, `soda`), and its bare Enter keeps things as
  they are — it has no ticks to submit, so `''` cannot mean "none". One
  word the flow cannot place fails the whole line ("I didn't catch
  "<word>" — numbers or names from the list") and nothing is applied.
- **The refresh row is an ACTION, not a state** (*2026-09-16, user report*).
  It carried `action: true` on the wire (10 §2.3) and is drawn as a button —
  `( refresh now )`, no tick box — because "re-read them now" is not a thing
  you can be connected to, and a listener reading `[ ] refresh` cannot tell
  whether unticking it turns something off. Space or Enter on that row
  submits at once: the current ticks and `refresh` together, which is the
  same `line` the flow always parsed. The plain host's numbered row drops the
  box for the same reason; typing `refresh` still names it, and so does
  `refresh now`, the way it is drawn — a listener types the row they can see,
  and one word the flow cannot place fails the whole line (codex review).
- **`( play order )` is the second ACTION row** (§2.13), placed after the
  refresh row and **always present** — YouTube is always there to order
  against, so there is always something to answer. Pressing it opens the
  play-order card (§2.13), and pressing it is *all* that line does: an action
  row is a button, not part of the selection, so nothing else typed alongside
  it is read as a tick and nothing is mounted or unmounted by that visit.
  Typing `play order` names it on the plain host, the way the row reads. When
  the card closes the menu comes back with its result leading, under the same
  results-land-in-the-next-card rule every other row follows.
- **The TUI's multi card closes on an `( apply )` row it synthesizes itself**
  (10 §3.2-D) — not on the wire, not this flow's business: the card offered
  nothing that looked like a submit. Its note says what applying would do
  (`2 changes`, or `nothing changed — Enter leaves`). Enter anywhere still
  submits, exactly as before.
- **Submit = a diff against what stands.** Unticked-and-mounted →
  unmount; ticked-and-not → the mount flow below, in row order; `refresh`
  → re-read now, and an expired login ticked alongside it goes through the
  mount flow first (a re-read cannot renew it). Order: unmounts, renewals,
  refresh, then new mounts, since a sign-in may wait on the listener and an
  Esc there ends the submit — rows already done stay done, the rest are not
  started (the cancel is checked before each step, not after). **Nothing
  changed + Enter = done.**
  Esc on the menu leaves without touching anything; so does a front-end
  going away (the reader's EOF `''`) — neither is an empty selection.
- **Every result lands IN the next card** — the menu when the submit is over,
  and the **sign-in card of the next source when it is not** (*added
  2026-09-16*; see "How do I sign in?" below) — as a ready/gap row that leads
  with what happened — `connected` / `could not connect` / `disconnected` /
  `refreshed` / `could not refresh` — then the mount flow's own words:
  `ok connected NetEase — signed in as Chen X · 312 liked`, `-- could not
  connect NetEase — <the obstacle line>`, `-- could not connect Spotify —
  stopped — nothing was written`, `ok disconnected Spotify — its tokens are
  dropped here …`, `ok refreshed NetEase — 312 items` — as well as in the log
  through `info`. The verb is what tells a reopened card apart from the same
  menu again (user report, 2026-09-14). Rows that end the same way share one
  (`-- could not connect Bilibili, NetEase — the code timed out — …`): three
  failures behind one cause must still fit an 80x24 card. **The card fitting
  the screen is the client's invariant, not a row budget this copy has to
  guess at** — *revised 2026-09-17, issue #264*. `mergeRows` bounds the row
  COUNT, not the row HEIGHT: at 80 columns the card's inner width is 38, so
  the Full Disk Access obstacle alone wraps to six rows and two merged gap
  rows put this card on 25 rows against a 24-row screen — it drew past the top
  edge and lost its own border. The old note here ("verified: 22 rows") held
  only for short obstacle tails. What guarantees the fit now is spec 10 §3.2-B:
  the client folds the notes, then the results, then windows the option rows
  until the card fits, whatever the copy says. Keeping an obstacle line short
  is still worth doing — a folded result is a result the listener has to go to
  the log for — but it is no longer what stands between the card and the
  screen edge. The TUI floats the card
  over the log (10 §3.3), so a result printed *under* it was the failure
  mode this replaces: the card closed and reopened and the listener saw
  nothing happen (#231).
- The mount flows below keep their own asks (the YouTube sign-in Enter, the
  Spotify wait, the three scans) — they pop as before.

**How do I sign in?** — *added 2026-09-15*. Before **every** mount in the
submit but Soda Music's, one single-select card comes first (`ask` with
`options`, `multi: false` — 10 §3.2-B), and its answer picks the road:

```
ok connected YouTube — signed in as Zach G · 312 liked, 4 playlists
How should I sign in to NetEase?
signed in to the wrong account there? sign out on the site in that Chrome window, then pick it again.
>> 1) [x] scan with the NetEase Cloud Music app
>> 2) [ ] Chrome — Work (zach.guo@opus.pro)
>> 3) [ ] Chrome — Personal (fawinell@gmail.com)
```

- **What this submit has already done leads the card** — *added 2026-09-16*.
  The rows accumulated so far (unmounts, refreshes, the mounts already run)
  ride above the question, merged by the same rule the menu uses, ready rows
  and gap rows on one road. A submit that connects two sources used to show
  the first one's result only when the menu came back: while the second
  source's card filled the screen, `ok connected YouTube …` sat in the log the
  card floats over, dimmed and covered — the #231 failure mode again, one card
  further in (user report, 2026-09-16). The menu keeps its own behaviour: the
  last source's result still lands there.

- **QQ Music's card says what it can play**, before either road runs, so the
  line frames the result whichever way the listener signs in: *"QQ Music plays
  here - but not its VIP-only tracks, so when a song needs a subscription I'll
  skip it and find another."* A listener who connects it and then never hears
  the one song they went looking for (§2.4 drops the VIP hits) has no other
  way to learn why.
- **The scan row** leads, and only for NetEase, Bilibili and QQ Music — the
  three that can go either way. **YouTube has no scan row**, so its card is
  the profile list alone (issue #221). QQ Music's row names **WeChat**, not
  QQ: the code is issued on the WeChat open platform (§2.10), and a QQ app
  pointed at it will not take. It names the app in the platform's own terms (*the
  NetEase Cloud Music app*, *the Bilibili app*), and picking it is the scan
  mount below, unchanged.
- **One row per Chrome profile**, named as Chrome's own profile menu names
  them: `Chrome — <name> (<email>)`, the email omitted when Chrome holds
  none. The list is `profiles()` (chrome.ts), read from the same `Local
  State` file `last_used` comes from: `profile.info_cache[<dir>].name` and
  `.user_name`, and nothing else. `Default` leads, then Chrome's own order; a
  directory `info_cache` still lists but Chrome no longer has on disk is
  dropped, because choosing it would mount an account that is not there. The
  list is never empty — with nothing readable there is still `Default`.
  Picking one is the browser mount below, with that profile pinned into the
  entry (`auth: 'browser'`, `browser: 'chrome'`, `profile: <dir>`).
- **The card is always shown**, with one profile as with five, and for
  YouTube as for the rest: the listener may want to sign in as someone else
  in that same profile, and a question they can answer with one keypress is
  cheaper than a mount they have to undo. It is what restores the browser
  road for NetEase and Bilibili, which the scan work (#242) had narrowed to
  the scan alone.
- **The note line** is the one failure the card itself cannot prevent: the
  right profile picked, the wrong account signed in to the *site* inside it.
  murmur cannot sign anyone out, so it says where to.
- **Preselection.** A source that **can scan and carries no browser pin**
  opens on its **scan row**: the scan is the road that asks the listener's
  machine for nothing — no cookie store to unlock, no Full Disk Access, no
  browser that has to be installed — and it is the road they reached for.
  Everything else opens on a profile, in order: the profile pinned in that
  source's existing entry (a reconnect opens on the profile that mount
  already chose) → `$MURMUR_CHROME_PROFILE` → the profile this same submit
  already chose (two sources in a row are one person's two accounts, not two
  questions) → Chrome's `last_used` → `Default`. That carry-over is about
  which *profile*, never which *road*: a scannable source still opens on its
  scan row after a Chrome profile was just picked for another. Every arm is a
  guess and every one is one keypress from being overruled, which is the
  point of asking. A profile the knob names that Chrome no longer lists is
  offered anyway, so the deleted-profile road (#240) stays reachable.
- **The answer** is the row's key (`scan`, `chrome:<dir>`), its number, or
  the directory typed bare; an empty line takes the preselected row. A word
  it cannot place is refused and the card re-asked — guessing here mounts the
  wrong account. **Esc** hands the list back, exactly as an Esc on the menu
  does: the submit stops, the row reads `-- could not connect <name> —
  stopped — nothing was written`, and nothing is written.

**Soda Music is never asked**: it has no browser road at all — its entry
(`sessionCookie` / `deviceId` / `installId`) is minted by the scan itself —
so its card would carry one row, which is noise, not a choice.

**Spotify is asked too, and its rows are the profiles alone** — no scan row.
A Chrome row there means *open the OAuth consent page in that profile*, so
the account the page offers is the one the listener meant. murmur never reads
a Spotify cookie; the profile decides nothing else.

**Mount, NetEase / Bilibili**: the card above decides the road. A Chrome row
is the browser mount YouTube takes below, reading that profile's cookie store
for the site. The **scan** involves no browser at all: murmur draws the
platform's own code in the terminal and waits for the phone app to confirm it
(§2.8). The steps are Soda Music's (§6), and the line names the app the
listener must reach for — *the NetEase Cloud Music app*, *the Bilibili app* —
because a code with the wrong app pointed at it is the failure this text
exists to prevent.

1. Ask the platform for a key and draw the code **in a notice card** —
   `Host.notice`, spec 10 §3.2-E — and there only: it is an authorization
   artifact and must not reach the log (§3.6), and it is 21 to 27 rows tall,
   which the program log scrolls out from under a listener who has gone to
   fetch their phone. The card's title names the position and the app
   (`2/3 Bilibili — scan with the Bilibili app`), its footer the wait and the
   way out (`waiting for the scan · esc - cancel`, becoming
   `scanned — confirm on your phone` when the poll says the phone has the
   code); it is closed however the mount ends, so no dead code is left up. A
   host with no such surface says so and mounts nothing.
2. Poll every two seconds for up to three minutes; Esc stops it, and so does
   a typed `/quit` (the TUI's Ctrl-C) — no read is open while a code is on
   screen, so the wait is slept in `QR_CANCEL_POLL_MS` slices and both flags
   are seen within a quarter second, not at the end of the cadence.
3. **Confirmed** → keep the cookie the platform hands back, read who it signs
   in as, first `snapshot()`, write, "done — I'll keep it fresh".
4. **The code expired, or three minutes passed** → "the code timed out —
   /sources to get a fresh one." **Esc** → "cancelled — nothing was written."
   **A cookie that signs in to nobody** → the §3.7 expired line.

This retires, for these two, every failure a browser mount can have: no
browser to install, no cookie store to unlock, no Full Disk Access to grant,
no "you must already be signed in somewhere", and no Arc — whose store
yt-dlp cannot read at all (issue #221). A mount made the old way keeps
working and is read exactly as before; unticking it is how it goes.

**Mount, YouTube (browser)**: only the profile is asked (the card above).
Google has no sign-in murmur can drive without a registered app (issue #221 records why: the Data API
needs one, the device-code flow needs a client id, and yt-dlp's borrowed TV
client id is blocked), so YouTube keeps the browser cookie. murmur reads
**Chrome**, and opens the sign-in page in **Chrome specifically** — one
browser for both halves, so the listener cannot sign in somewhere murmur will
not look.

1. Read Chrome's cookie store for the site.
2. **A login is there** → `verify()` → "signed in as <who>".
3. **No login** → open the site's sign-in page with `chromeOpenerFor`, say
   so, and wait on "press Enter when you have signed in". On Enter, drop the
   cached export — it answers from before they signed in — and read once more.
   Still nothing → "still no <site> login in Chrome — /sources when you have
   signed in". Never a dead end that sends them back through the whole
   conversation. **The page always opens in the same profile this mount
   reads** — the resolved name is passed to the opener by the mount flow, not
   resolved a second time, so the two halves cannot disagree (macOS `open -na
   "Google Chrome" --args --profile-directory=<p>`: without `-n`, `open` drops
   the flags whenever Chrome is already running; there is no unnamed form of
   the opener left). Signing in anywhere else would be invisible to murmur.
   **A profile Chrome has never opened arrives here too**, not as an obstacle:
   to a listener it is the same thing as not being signed in, and Chrome
   creates the profile directory when it opens the page in it.
   A `login-required` the platform's own client RAISES rather than returns
   (NetEase answers an expired cookie with `code: 301`) takes this same road:
   reported as "could not reach", it left the listener with no sign-in page
   and nothing to do (codex review).
4. **The store could not be read at all** is a different answer, and says
   which: Chrome not installed, the terminal not allowed to read its cookie
   store (macOS: Full Disk Access), no yt-dlp, or unreadable for a reason not
   modelled — a locked database, a Windows DPAPI decrypt failure — which is
   quoted rather than guessed at. These used to arrive as an empty jar and be
   reported as "you are not signed in": advice that cannot work, and that
   loops a Safari user forever. yt-dlp names the failure in its stderr;
   `classifyCookieFailure` keeps its words and `BrowserCookieError` carries
   them to the flow. Only a mount is told; **playback degrades to anonymous**
   as it always did, so an unreadable store never stops a public track from
   resolving.
5. First `snapshot()` in the foreground with a progress line (counts, not
   titles); write `sources.json` + the snapshot; "done — I'll keep it fresh".
   The cancel latch is checked once more **before** anything is written: an
   Esc while the cookie export or the account read was in flight has to mean
   "nothing was written", as it already does on the scan road.

**murmur always names the Chrome profile** — it never lets yt-dlp choose.
Unnamed, yt-dlp searches the whole user-data directory and reads whichever
profile's `Cookies` file was written last (`yt_dlp/cookies.py`); with three
profiles open at once those timestamps are a coin toss, so a mount read an
empty profile, reported "not signed in", and opened the sign-in page in a
window the listener had never used — while their everyday profile was signed
in all along (user report, 2026-09-15). Both halves name one profile now.

*Resolving it*: the profile pinned in the entry, else Chrome's own
`profile.last_used` from its `Local State` file, else `Default`.
`$MURMUR_CHROME_PROFILE` is **not** in that order — *revised 2026-09-15*: the
listener picks the profile on the sign-in card, so the knob preselects a row
there and decides nothing. A knob that preselects wrongly costs one keypress;
a knob that decided silently cost a mount.
`Local State` is found under the same root yt-dlp resolves the cookie store
under (`$XDG_CONFIG_HOME` on Linux, `%LOCALAPPDATA%` on Windows), and
`last_used` is read **once per run** and held: the read and the write-back
that pins what that read used have to agree, and they would not if Chrome
changed profiles in between — nor should playback open the file per track.
Only that one key is read, and it is a directory name — `Local State` sits
beside the cookie store murmur already reads, so it grants nothing new, and
when it cannot be read there is no separate complaint: the cookie read that
follows fails with yt-dlp's own words (not installed / not permitted). The
name goes nowhere but `entry.profile` and the `profile=<name>` field on the
`sources.mount` and `sources.cookies` log lines.

*Pinning it*: a mount binds **one account on one site**, and that account
lives in one profile — so the profile is resolved **once, at mount**, written
into `entry.profile`, and every later read hands that pin back. Refresh and
verify never re-guess; re-guessing per read is exactly the failure above,
moving a mount to another account between refreshes. The table:

| when | what happens |
| --- | --- |
| new mount | the profile the sign-in card chose, written into the entry |
| an older mount with no `profile` field | resolved by the same rule for the read; written back once the read works, pinned from then on |
| `$MURMUR_CHROME_PROFILE` set | preselects the card's row for a mount with no pin, and decides nothing on its own. It never moves a pinned one: the entry also holds that account's own identifiers (a Bilibili `mid`, a NetEase `userId`), and reading another profile's cookies against them would fold two accounts into one snapshot |
| the knob names a profile other than the pin | nothing happens — *revised 2026-09-15*. The pin is the listener's own answer on the sign-in card, and the knob only preselects, so a knob that disagrees is a stale preference, not a drifted mount. Expiring the mount here put an explicitly chosen profile in a reconnect loop it could never leave (codex review): every re-mount preselected the knob, and every refresh expired what the listener picked instead |
| the read says `no-profile` (the profile was deleted or renamed) | the mount takes the same road as a lost login: `expired`, and the /sources list says to connect it again. Never a silent move to another profile |
| the listener wants a different account | untick the row and tick it again — an unmount and a fresh mount, whose sign-in card asks the profile again |

Updating a pin is never a background decision: only a failed read or the
listener's own action changes it.

The cost, accepted: a listener who uses only Firefox or Safari cannot take
the browser road (NetEase and Bilibili they can still scan). It buys the removal of every failure the question created — an
uninstalled browser, an unreadable store, a login in the wrong one — and of
the `BrowserName` list, the `chrome:Profile 1` syntax and the paragraph of
per-browser caveats that had to be read before answering. Existing mounts
keep whatever browser they were made with; only new ones are Chrome.

**Mount, Spotify**: open the browser straight away; wait for the callback;
then as above. Nothing is asked for. *Revised 2026-09-08*: the four-step
"register an app" instruction and the Client ID question are gone. murmur
bundles librespot's published keymaster client id, which every Web API scope
here is granted — Spotify reserves that id for *playback* credentials only,
and murmur never plays a Spotify stream. `MURMUR_SPOTIFY_CLIENT_ID` still
takes an app of one's own.

Two consequences of the bundled id, both measured on the real platform:

- **The redirect path follows the id.** A loopback redirect is matched on its
  path, the port being ignored (RFC 8252 §7.3), so the bundled id goes to
  librespot's registered `http://127.0.0.1:<port>/login` and an app of the
  listener's own keeps the `/callback` it was told to add. The listener
  answers both.
- **A pooled id does get pooled 429s** — the reason this spec once refused to
  bundle one, and it was right. It is not a reason to refuse: a 429 whose
  `Retry-After` fits a ten-second budget is waited out and the read retried
  once. What must never happen is what did: `/me` answered 429 seven seconds
  after a *successful* consent, and the mount was discarded — an
  authorization the listener had just given, refresh token and all, thrown
  away over seven seconds.

**Mount, Soda**: print the QR; poll status every 2 s for up to 3 min; the
listener scans with Douyin; then as above. Esc cancels (the host `interrupt`
seam, 10 §3.4) and leaves nothing written.

**Refresh** re-snapshots every mounted source now (foreground, with counts).
**Unmount** deletes the entry and the snapshot; for Spotify it also drops the
tokens (there is no remote revoke without a secret — say so).

**Settings pane** (12 §3.6): the read-only status block gains one line per
mounted source (name, status, refreshed-when). No writable intent is added —
sources are not a knob.

### 3.2 Where the digest is read

- `src/memory/…` pack assembly (05 §3.5): read the snapshots from
  `data/taste/*.json` at pack time (cheap; files are small), render the digest,
  set `pack.taste`. Rendering is memoised on the snapshot files' mtimes.
- The music task builder appends the digest to the situation string.
- **Stub isolation** (05 §3.7): `--brain stub` / `STUB=1` never reads
  `sources.json` or the snapshots — `MURMUR_HOME` is a throwaway there (test
  isolation, #195), and the stub Director gets `taste: ''`.

### 3.3 Search with taste in hand — what the prompt says

One paragraph added to the music prompt (`src/prompts/music.ts`), rendered
only when a digest is present. *Amended 2026-09-21 (§3.10)*: what the block
shows is the shape of what the listener already has — anchors to reach out
from, never a shelf to pull from; the radio's half is the rest of the map.
Then, unchanged: search wherever the song is likeliest to be FOUND,
not where it plays best (§2.13 relocates the pick after submit); say in `announce`
where a pick came from only when it is theirs ("one you've kept").

### 3.4 Boot and refresh

- The curated-channel pool (§2.9) rides this same clock and the same shape —
  stale past 24 h, single-flight, never awaited by the loop.
- Boot: read `sources.json`; **never block the broadcast**. If any list is
  stale on the clock below, schedule a background refresh after the second
  beat airs (the same "after boot settles" point the bed uses, 03-04).
  Failures log and keep the old snapshot; auth failures flip `status` and
  surface once (§2.6).
- No refresh while a `/sources` conversation is open (single writer).

**The clock is per kind** (*amended 2026-09-18*). One 24 h clock for every
list of every source re-read the liked collection — which changes a few times
a month — as often as the watch history, which is the only list that answers
"what are they on right now". The clock is now a map from `TasteKind` to an
age:

| kinds | stale after | why |
|---|---|---|
| `history`, `subscription`, `daily` | **3 h** | what they are listening to and watching *now*; an afternoon's listening should reach the evening's picks |
| `liked`, `playlist`, `favourite`, `top-track`, `top-artist`, `follows`, `frequents` | **24 h** | a collection and a follow list move on the scale of days |

- **Only the due lists are read.** `TasteSource.snapshot` takes an optional
  `kinds: readonly TasteKind[]`; a source that can split its reads reads only
  those (YouTube's history and subscriptions are already two separate yt-dlp
  calls, and Bilibili's four lists are four API calls). A source that cannot
  split ignores the argument and returns everything — correct, just not
  cheaper. This is what makes 3 h affordable: the due list is `history`
  alone, which is one yt-dlp call for YouTube and the cursor pages for
  Bilibili — not the liked collection, the playlists and the follow lists
  beside it.
- **A partial read merges into the stored snapshot**: the returned kinds
  replace their rows, every other kind keeps the rows it had. The snapshot
  still means "the latest read of each list".
- **What is marked read** is the set of kinds that were **requested** (every
  kind, when none was), not the set that came back. A list that is genuinely
  empty must not be re-read every three hours.
- **The mount's own first read is a read.** `/sources` reads the account in
  the foreground as it mounts it (§3.1), and that read lands through the
  same one path a background refresh does — into the ledger, and stamping
  every list's clock with all the kinds it asked for. With a second write
  path it did not, so every list of a just-mounted source looked never-read
  and the next poke re-read the whole account for nothing.
- **`lastRead` lives in the ledger file, not in `sources.json`** (§2.11):
  it is rebuildable bookkeeping and the sources file is the one that holds
  credentials. `lastRefresh` in `sources.json` keeps its meaning — the last
  read of any kind — and is still what `/sources` shows.
- **Unchanged**: `RETRY_MS` (a failed source is not retried for an hour,
  whatever the kind), the single-flight, the `expired` rule — an expired
  login is renewed only by `/sources` and is never re-read on any clock — and
  "never awaited by the loop".

### 3.5 Bounds

Per source per snapshot: liked/collection ≤ 500 newest, history ≤ 200,
playlists ≤ 50 names (contents are not snapshotted except the liked list
itself — NetEase's liked playlist and QQ Music's dir 201, which *are* the
liked list; QQ Music's created and favourited names share the one 50 bound),
top lists ≤ 50, subscriptions ≤ 100, followed accounts ≤ 50 per order
(recently followed, most visited).
Digest ≤ 1500 chars (§2.3), of which the fixed half is ≤ a fifth (300).
A snapshot file over 1 MB is a bug. A ledger file (§2.11) is capped at 4 MB
and sheds its oldest entries rather than growing past it.

### 3.6 Privacy and the dev log

`sources.auth`, `sources.refresh <source> n=<count> <ms>`, `sources.mount
<source>` lines only. **Never** a title from a snapshot in the dev log (the
log is what a listener pastes into a bug report), never a cookie, token, or
session value anywhere outside `sources.json`. The redaction rule is a unit
test over the log writer with a snapshot fixture.

*As built (review round 2)*, two paths the rule reaches that the draft did
not name: the pick's `music.search` line logs the query's **size**, never its
words (a taste-led search quotes a kept title, and yt-dlp echoes the whole
search spec in its errors, so that is trimmed too); and the Soda login QR —
an authorization URL — goes to a host surface that is shown and never
mirrored (`Host.notice`, the notice card of spec 10 §3.2-E; `Host.showPrivate`
until 2026-09-15), since `info` is what the diagnostics keep. A front-end
without that surface is told so rather than handed the code.

### 3.7 Failure modes, listener-facing text (exact)

| situation | on screen (info, once) |
|---|---|
| cookie expired during a pick | `your <site> login has expired — /sources to renew; picking from elsewhere for now.` |
| no browser login found at mount | `no <site> login in <browser> — sign in there, then try /sources again.` |
| Spotify callback never arrives (3 min) | `didn't hear back from Spotify — /sources to try again.` |
| QR not scanned (3 min) | `the code timed out — /sources to get a fresh one.` |
| rate limited | `<site> is asking us to slow down — I'll try again later.` |
| snapshot stale > 30 d and refresh failing | `still going on what I knew about your <site> music as of <date>.` |

### 3.8 Invitations — the one light hint form

What is weak today (spec 10 §3.2-C): the resting placeholder rotates a fixed
carousel derived from `COMMANDS` — every row is a **label** (`/bug · report a
bug on GitHub`), it ignores context (offers `/bug` before anything has aired,
would offer `/sources` forever after mounting), and nothing ever fades. The
*place* is right — the input's rest state, not the transcript — and stays.

The form, for all three:

- **A row is an invitation, not a label**: `command · why`, and *why* is what
  the listener gets, in the host's register, ≤ 48 chars so a narrow field
  keeps the command and most of the reason:
  - `/sources · your NetEase or Spotify likes make better picks`
  - `/bug · something broke? two lines and it's filed`
  - `/feature-request · wish it did something? say so`
  `COMMANDS.blurb` becomes that *why* — one copy of the wording (10 §3.2-C).
- **Context-gated** (`dueInvitations`, §2.7):
  - `/sources` — only while **nothing is mounted**; gone the moment one source
    is. (Mounted-but-expired is not an invitation; it is the §2.6 line.)
  - `/bug` — only after the **first segment aired** (nothing to report before).
  - `/feature-request` — only after **10 minutes** in the session.
  - A used `/bug` or `/feature-request` leaves the set for the session
    (*as built*: used = the command was typed; the report floor does not
    report whether the draft was sent, and reaching for the command is the
    moment the invitation has done its job).
- **Cadence unchanged**: the TUI rotates the *given* set every three minutes,
  the talk-back line first. An empty set = the talk-back line only.
- **No persisted "seen" state**: `/sources` fades by mounting; the others by
  being used. Nothing new in `settings.json`.
- **Plain host**: banner gains the `/sources` row; nothing else changes.

### 3.9 The onboarding card

Spec 06 slice A asks its seed questions, then the slice-B consent (06 §3.4),
then — **right after that consent and before the persona call**, so every
question is asked before the one long wait — exactly one `consent` ask,
once, only on a real first run. `SOURCES_OFFER` in `flow.ts`, the same
shape as `BOOTSTRAP_OFFER` (the question leads, two quiet notes ride as card
lines):

> `Connect the music you already keep? [y/N]`
> `NetEase, QQ Music, Spotify, YouTube, Bilibili or Soda Music - murmur reads your likes there, so what it plays fits you.`
> `Nothing is read until you say yes; /sources any time later.`

- **Yes** → `await` the `/sources` conversation (§3.1) itself, through the
  `sourcesRecall` closure the Director also parks on; it returns to the
  first run, which goes on to the persona call. Nothing about the
  conversation changes for being entered from here.
- **Anything else** (n, Enter, a stray line) → nothing is written, nothing
  more is said; the invitation (§3.8) carries the option from then on.
- **`/quit`** on the card behaves as on the slice-B consent: the run ends
  with no persona marker, so the next boot asks again from the top.
- **Shown only when the seam exists**: a stub run has no taste wiring and
  never sees the card. A returning listener never sees it either —
  `persona.md` stays the only first-run marker.

---

### 3.10 Discovery over recall — the pick is not a shuffle button

*Added 2026-09-21.*

**The measurement.** 68 consecutive airs, read from the listener's own logs
and snapshots (counts only — §3.6: no title left the machine, none is written
here):

| what the aired song was | share |
|---|---|
| in the listener's liked list on a mounted source | 19 / 68 |
| in that artist's top ten on NetEase | 31 / 68 |
| by an artist who appears in the liked list | 63 / 68 |
| "not two in a row", the rule the old §3.3 paragraph asked for | violated — three kept songs ran consecutively |

**The requirement.** This is a *discovery* radio. Artist repeats are welcome —
the listener's artists are the shape of their taste. Songs they already know
must not dominate. A blunt "never play a kept song" is **rejected**: a kept
song at the right moment is the right song.

**FAMILIAR is code-judged, never model-judged.** A candidate is familiar when
any of these holds:

  a. it is a liked/playlist row in **any** mounted source's snapshot — every
     platform, unioned, not NetEase alone;
  b. it is a history row in any snapshot — the YouTube/Bilibili watch rows
     count here even though §2.3's block never shows them;
  c. murmur has aired it — `memory.recentSongsSince`, any window;
  d. it is in the artist's **top ten** on a platform that ranks them. NetEase
     first: anonymous `GET music.163.com/api/search/get?s=<artist>&type=100`
     for the artist id, then `/api/v1/artist/<id>` → `hotSongs`. Cached per
     artist for 24 h. QQ Music and YouTube rankings are a later step.

**Matching** is the folded title with parenthetical suffixes stripped, plus an
artist match through `moment.ts` `carries()` (word-boundary aware) — **not**
`relocate()`'s bare containment, which would call a one-word title familiar
inside any longer one. Simplified/traditional folding is **not** attempted;
the miss rate is logged rather than guessed at.

**Step one (this change).**

1. **`submit_pick` requires `title` and `artist`.** §2.3 of spec 03-01 already
   says a pick carries them; the schema had them optional, and an unnamed
   submission slid past every label-keyed guard — the repeat check, the
   relocate, and the familiarity rule above. Both are required in the schema
   the model reads, and a submission whose title or artist is blank is
   refused with a message that says to resubmit with both. A named submit is
   also a relocatable one (§2.13), so a pick that would have skipped the
   relocation search now makes it: bounded by `RELOCATE_BUDGET_MS`, off the
   critical path by the same deadline that has always guarded it.
2. **The digest stops naming the kept songs.** The `Songs they keep` line of
   §2.3 is gone: 40 titles were the largest thing in the block and the model
   read them as a playlist (19/68 above). `Artists they return to`,
   `Playlists`, the `Sources` counts and `Lately they have been listening to`
   all stay — what they keep still reaches the brain as *shape*. §2.12's
   selection still scores the kept rows; the block no longer renders them,
   and the experiment is reversible on the measurement below.
3. **The taste paragraph (§3.3) is rewritten**, code-owned. It must live in
   `src/prompts/music.ts` and **never** in the listener-editable
   `music-policy.md`: that file is seeded once and existing installs never
   receive a new sentence, so nothing may arm off a sentence in it.

**Step two (candidate pools).** Where the pick goes instead of its own
memory. Both pools are **catalogue values on `search_music`**, never a third
tool (§5 acceptance #7 locks the pick task at exactly two).

4a. **The mood pool — `catalogue: "playlists"`.** The model puts the moment
   into a few words and gets back tracks off playlists other people keep for
   it. When the words ARE one of the platform's own category names
   (`/api/playlist/catalogue`, read once per process and cached; a tree that
   will not load means every mood takes the search route) the pool reads
   `/api/playlist/list?cat=<name>&order=hot`; otherwise it searches playlists,
   `/api/search/get?type=1000`. At most **two** playlists per call, each read
   once through the existing `v6/playlist/detail` (30 tracks), interleaved and
   deduped by ref. All of it **anonymous**, so the pool is offered to a
   listener who has mounted nothing at all — the only catalogue of which that
   is true besides `youtube`.
   *Measured live 2026-09-21*: a bare mood word ("quiet") fills the pool with
   piano and classical sets, which policy rule 7 forbids. The catalogue's own
   description says so; the judgment stays the model's.
   `ponytail:` the head of a hot playlist is what comes back, so the same mood
   word twice in an evening can offer the same first tracks twice — the
   avoid-list catches the exact repeat. Upgrade path: page the detail read at
   a rotating offset.

4b. **The daily lane.** NetEase's `/api/v1/discovery/recommend/songs` (the
   account cookie; 30 songs, each with the platform's own one-line reason —
   measured 0/32 already in the liked list) and QQ's
   `music.recommend.TrackRelationServer.GetRadarSong`, merged into **one block
   of the pick situation** under its own heading, at most 12 songs. It is
   **not** a `daily` `TasteKind`: that kind counts into `Artists they return
   to` (§2.3), polls on §3.4's 3 h clock and costs §2.12's 5 ms scan, and none
   of that is true of a platform's guess about today. It is never written to
   the taste ledger. Its own 24 h clock, single-flight, poked from the pick
   and never awaited; a day whose every feed fails keeps yesterday's lane. It
   rides the pick situation only — the talk pack (05 §2.2) is about who the
   listener is, not about what a platform is pushing today.
   Two rules the lane's failure modes turn on: the feed list is read **per
   refresh and before any clock**, so an account mounted mid-session is read
   and one disconnected through `/sources` empties the lane at the very next
   pick rather than a day later; and the cap is filled by **interleaving** the
   feeds, so a first platform that answers 12 cannot spend the whole block
   while the second platform's request is paid for daily and never shown.

4c. **Neighbours of the song on air — `catalogue: "neighbours"`.** NetEase's
   `/api/v1/discovery/simiSong?songid=` (anonymous, five) for a pick that came
   from NetEase, and the YouTube auto-mix (`yt-dlp --flat-playlist
   --playlist-items 1:15 ".../watch?v=<id>&list=RD<id>"`, ~15 s) for one that
   came from YouTube. QQ's `GetSimilarSongs` answers null on every seed
   measured and Bilibili's related list is re-uploads and reaction videos;
   both are skipped — and a pick from one of them leaves the pool **empty**,
   because the catalogue's promise is the neighbours of the song ON AIR and
   the previous song's are not that. A read that **failed** is not a song
   with no neighbours: the pool keeps what it had, and only a read that
   genuinely answered nothing empties it. Two primes can overlap, so a result
   lands only while its seed is still the newest. The pool is **primed from `submit_pick`**, after the pick
   is committed, with the ref it committed to — so the read happens while that
   song is on the air and the pick that follows reads a **cache**. Nothing
   here is ever on the pick's own path: `search` returns what the last prime
   left, ignores the query, and is empty early in a program. A failed read
   keeps the pool it had.

**Step three (labels and rotation), the last of this section.**

5a. **Every `search_music` hit carries its familiarity label** — `kept`,
   `watched`, `played by murmur`, `artist's #N hit`, or `new` — so the model
   chooses knowing rather than guessing. The labels are judged **in parallel**
   with the search's results in hand; the ranking behind `#N` is read at most
   once per artist per day and is never consulted for a song the cheaper
   checks already settled. A ranking that will not answer makes a song `new`,
   never familiar: a pick may not wait on it, and calling an unknown song
   familiar would close the pools this section exists to open.

5b. **What FAMILIAR means, as built.** The rows come from `TasteReader.rows()`
   — every mounted snapshot and ledger, `liked`, `playlist` and `history`,
   across every platform, **including the watch rows §2.3's block never
   shows**. What murmur itself aired comes from the Director as
   `MusicContext.played`: `memory.recentSongsSince(0, …)` — the whole window,
   not the avoid-list's week — plus `queuedLabels()`, so the two picks the
   queue is holding count before the ledger has heard of them. The ranking is
   NetEase's `search/get?type=100` → `/api/v1/artist/<id>` → `hotSongs`, top
   ten, anonymous, cached per artist for 24 h. Matching is the folded title
   with a trailing parenthetical stripped, plus an artist match through
   `moment.ts` `carries()` — word-boundary aware, **not** `relocate()`'s bare
   containment. Simplified and traditional are **not** folded together; the
   miss that leaves is counted rather than guessed at: a song called `new`
   whose **artist** is one of theirs is flagged `artistKnown` and logged as a
   per-search count (`artist-known=N`), which is where such a miss hides.

5c. **Rotation is a shuffled deck, not independent dice.** Of every 10 pick
   slots exactly **3** allow a familiar song, shuffled — a coin per pick would
   give the listener a run of five familiar songs about once a fortnight,
   which is the exact evening the radio stops sounding like one. The verdict
   is drawn **in code at pick start**, written into the situation as its own
   line (what the slot is, and where to look instead) **and** carried on
   `MusicContext.newOnly`, because a prompt rule is advice. `submit_pick`
   enforces it: a familiar submission on a "new only" slot is refused **at
   most once**, with a message naming the pools to try, and then **fails
   open** — a familiar song beats dead air, and a refusal loop would spend the
   task's 8 turns and return `picked=no`, which costs the listener the whole
   music slot. A **listener request** (the Director's `listener request:`
   hint) reaches the context as `newOnly: false` and no slot line at all: a
   rotation that refused what they just asked for would be a radio arguing
   with its listener. The 3-in-10 is a constant with a `ponytail:` comment,
   not a setting.

**Dropped on purpose** (do not add them back): a 30-day cooldown on kept
songs; a `source`/`outcome` field on the memory ledger (familiarity is a pure
function of the label — recompute it); a pick-time tool; and any kept/new tag
beside a title in the dev log — §3.6 allows counts only.

**Measurement.** Per pick, counts only: the familiar share, the fail-open
count, the refusal count. The acceptance metric is the **familiar share per
100 airs**. The two shares above overlap by an amount nobody counted, so the
baseline is a **range, 45.6 % to 73.5 %** (31/68 to 19/68 + 31/68), and the
first job of the code that scores the metric is to recompute the baseline as
one de-duplicated number over the same 68 airs. A verdict
needs hundreds of airs — roughly two weeks of listening — so step 5 lands
after steps 1–4 have been on the air, and no change in this section is judged
inside the session that wrote it.

## 4. Dependencies

- yt-dlp ≥ 2026.08 (present; `--cookies-from-browser`, `netease:*`,
  `BiliBiliSearch`, `youtube:favorites|history|subscriptions`).
- `qrcode-generator` (npm, MIT, zero dependencies) — new, §2.8. Nothing else new.
- Spec 12's settings store (read-only line), spec 10's `COMMANDS`, spec 03-03's
  floor parking and secret-path guard list, spec 05's pack.

---

## 5. Acceptance criteria

Deterministic → unit (vitest, fakes, no network). Real-boundary → smoke
(`murmur-smoke`, the developer's own accounts; the user's accounts for the
platforms the developer lacks — recorded as one by-ear issue). Stochastic →
eval track (#98), out of this spec.

### 5.1 No account, no change (unit + real run)
With no `sources.json`: the cookie leaser answers `null` for every ref; the pack has
`taste: ''`; the music prompt renders no taste paragraph; `search_music`'s
description lists only `youtube`; a real `--plain` run's pick and play are
byte-identical in their yt-dlp arguments to today's (dev-log diff).

### 5.2 Mount (smoke, each source)

- **NetEase / Bilibili**: `/sources`, tick the row. A code is drawn on the
  unlogged surface only; scanning it with that platform's app and confirming
  mounts the account, names who, and writes the first snapshot. No browser is
  opened and no cookie store is read — assert zero yt-dlp calls on the mount
  path. The code's URL and the cookie appear in no log line.
- **YouTube**: `/sources`, tick the row; signed in to Chrome → mounts and
  names who. Not signed in → the sign-in page opens in the named Chrome
  profile and the wait resumes on Enter (§3.1).
- **QQ Music**: `/sources`, tick the row; its card offers the WeChat scan and
  the Chrome profiles. **Scan** → the code is drawn on the notice surface
  only, WeChat confirms it, and the account mounts with no browser read at
  all (assert zero yt-dlp calls on that path). **Chrome** → signed in to that
  profile mounts and names who; not signed in → `https://y.qq.com/` opens in
  the named profile and the wait resumes on Enter, exactly as YouTube's does.
  Either way the first snapshot holds the liked songs plus the created and
  favourited playlist names. Verified 2026-09-16 against the live service,
  both roads: mount → verify → snapshot, the snapshot carrying no credential,
  and the scan reporting waiting → scanned → confirmed.
- **QQ Music plays** (smoke, §2.5): with the mount in place, `resolve()` on a
  **free** `y.qq.com/n/ryqq/songDetail/<mid>` ref returns a
  `dl.stream.qqmusic.qq.com` M500 mp3 whose `probeStream` is true and whose
  decoded length matches the track's stated one (no preview clip), and
  `submit_pick` on it ends the task. `resolve()` on a **VIP** (`pay_play: 1`)
  ref raises a `TrackRightsError`, `submit_pick` answers a plain
  `{ ok: false, error }` so the model picks another, the auth watch is never
  told, and `sources.json` still reads `qqmusic.status: "ok"`.
- An older browser mount of NetEase or Bilibili keeps reading and refreshing
  untouched; unticking it is how it goes.

### 5.3 Taste reaches the brain (unit + dev log)
Fixture snapshots → `renderTasteDigest` golden output; a fake-brain pick
task's situation contains the heading; `.dev/dev.log` of a real pick shows
`music.pick start situation=<n>ch` grown by the digest's length.

### 5.4 Named search (unit + smoke)
`search_music({catalogue:'bilibili'})` runs `bilisearch5:` with the cookie
flag; `catalogue:'netease'` returns candidates whose `ref` is a `music.163.com`
song URL, and `submit_pick` on one plays it end to end (smoke; a VIP account
yields a `lossless` or better format in the yt-dlp JSON).
`catalogue:'qqmusic'` returns candidates whose `ref` is a
`y.qq.com/n/ryqq/songDetail/<mid>` URL, **none of them VIP**, and `submit_pick`
on one resolves, probes and finishes the task (smoke, verified 2026-09-16:
three queries → 5 playable candidates each in 0.2–1.0 s, `submit_pick` ok in
3.1 s). An unmounted QQ Music is `not-mounted`; a mounted one whose cookie
carries no credential is `reason: 'auth'`, not an empty result page.

### 5.5 Expired says expired (unit + smoke)
Captured yt-dlp stderr fixtures classify to the four `AuthFailure`s; a
`SourceAuthError` from `resolve` makes `submit_pick` return `reason:'auth'`;
the Director prints the §3.7 line **exactly once** across three failing picks
in one session (unit, scripted); `sources.json` reads `status:'expired'`.
Smoke: log out of NetEase in the browser mid-session → the line appears on
the next NetEase pick; the radio keeps playing from YouTube.

### 5.6 Preview trap (unit)
A NetEase resolve whose probed duration is 30 s against a 240 s candidate
returns `login-required`; 235 s against 240 s passes.

### 5.7 Spotify and Soda read-only (smoke, user-run — the developer has neither)
Mount completes; `who` is right; the digest carries the platform's own top
lists / collection; **no** catalogue named `spotify` or `qishui` is ever
offered to `search_music` (unit).

### 5.8 Secrets stay put (unit)
`sources.json` is denied to the guide's tools (the 03-03 guard fixture gains
the path); the dev-log writer redacts a fixture snapshot's titles and a fake
token; `git grep` for a literal cookie/token in `test/` fixtures finds none
(fixtures use `<redacted>` values).

### 5.9 Boot never waits (unit)
With a 24 h-stale snapshot and a source whose `snapshot()` hangs, the first
beat airs at the same segment index as with no sources (scripted Director).

### 5.10 Invitations (unit, table-driven)
`dueInvitations` over the state table: boot → `[]` (or `['/sources']` when
nothing is mounted); after one segment → adds `/bug`; at 10 min → adds
`/feature-request`; after a mount → `/sources` gone; after filing → that one
gone. The TUI receives one `invitations` message per change, never on a
timer (scripted host counts messages). A snapshot test pins the three `why`
strings ≤ 48 chars.

### 5.11 Onboarding card (unit)
A scripted first run with a `sourcesRecall` seam shows the §3.9 card as one
`consent` ask, after the slice-B consent and before `seedPersona`; a yes
calls `sourcesRecall` exactly once, before `seedPersona`; n / Enter / a
stray line call it zero times and write nothing; `/quit` on the card leaves
with no persona marker and no persona call. A run without the seam, and a
closed stdin, never show the card. No info line carries the offer.

### 5.12 By-ear (one issue, user-run)

*As built, 2026-09-07*: §5.1, §5.3, §5.5 (unit), §5.6, §5.8–§5.11 hold in
the unit suite; §5.2 and §5.4's search half passed on the developer's own
YouTube and Bilibili accounts (`scripts/sources-smoke.ts`; the NetEase
search answered anonymously). *Amended 2026-09-09*: §5.2 for NetEase now
holds on the developer's own account through the plaintext transport —
identity, 186 liked tracks all dated, 50 playlist names, search — and the
Spotify mount was driven end to end on the bundled client id. §5.4's NetEase
play, §5.5's smoke, §5.7 and §5.12 remain the one by-ear issue's checklist.
Does the radio pick *better* — more of what they would have chosen, fewer
misses — over one real evening with NetEase and Spotify mounted, versus the
evening before. Recorded as the spec's one by-ear issue; the eval that would
make it repeatable is #98.

### 5.13 Curated channels (unit + smoke) — *added 2026-09-16*

Unit: the manifest parse drops comments, blanks and junk lines; the GitHub
refresh serves a fresh fetch, a cache hit inside the TTL with no network, and
falls back to the bundled copy on a network failure **and** on a malformed
remote body; the pool builds from fake channel listings and keeps the channels
that answered when one fails; the `channels` catalogue matches on title and
uploader and returns refs; an empty pool is not offered and the guidance
sentence is not rendered; a failed refresh waits out the retry window; the
Bilibili request deadline covers the body; the signing keys are re-read once
they age out. The guidance sentence itself is asserted to say
nothing about the listener.

Smoke (real services, `scratch/`): the committed manifest builds a pool with
titled rows from **both** transports, and a Bilibili row carries a real title —
which is the whole reason §2.9 signs the request.

*As built, 2026-09-16*: the pool built 120 titled tracks from 8 channels in
20 s; searching `tiny desk` and `kexp` matched on title and on uploader. Two of
three Bilibili channels answered `412` in that run (the measured ceiling in
§2.9) and were skipped without costing the pool. YouTube refs from the pool
resolve through the unchanged path; a Bilibili resolve was 412 from the same
rate-limited IP, which is the pre-existing §2.5 behaviour and not this change.
---

### 5.14 The digest spends its budget on music (unit) — *added 2026-09-18*
On a fixture that invents every row but keeps the kind counts a real mount of
each platform returns (200 watched, 186 liked, 50 playlists, 100
subscriptions and so on — a handful of rows would not put the budget under
pressure): *amended 2026-09-21 (§3.10)* — **not one of the 186 kept titles
appears anywhere in the block**, while every artist behind them is counted on
`Artists they return to`; no `history`, `follows` or
`frequents` row from a video platform (YouTube, Bilibili) appears anywhere in
the block, nor in the `Sources` counts; `Recently followed` and `Who they
keep going back to` are absent entirely; every remaining row traces to a
songs-only source (§2.3's invariant); the fixed half
(`Sources` + `Artists they return to` + `Playlists`) is at most 300
characters; the whole block is at most 1500. The before/after counts are in the PR body,
measured on both the fixture and, locally, the listener's own snapshots.
**No listener data is committed** (user decision, 2026-09-20): the fixture
carries shape, never content.

### 5.15 The ledger only grows, and the clock is per kind (unit) — *added 2026-09-18*
Two reads of the same source whose second read shares some refs with the
first: the ledger holds the union, every shared entry keeps its `firstSeen`
and takes the new `lastSeen` with `seen = 2`, and nothing the first read saw
is gone. A third read that returns only `history` leaves every `liked` entry
untouched, and the stored snapshot still carries the `liked` rows the second
read wrote. Table-driven over the kind clock: with `history` last read 4 h ago
and `liked` 4 h ago, only `history` is due; at 25 h both are; a source whose
status is `expired` is due on neither. A ledger past `LEDGER_MAX_BYTES` sheds
its oldest `lastSeen` entries and logs a count with no title in it.

### 5.16 The moment picks the rows (unit + timing) — *added 2026-09-18*
*Amended 2026-09-21 (§3.10)*: the only line the selection still renders is
`Lately they have been listening to`, so the row assertions run on a
songs-only source's watch rows; on the §5.14 fixture, whose watch rows are
all on video platforms the block never shows, a moment renders the block
byte-for-byte as no moment does. Given a ledger of watch rows and a moment
whose last song is by one of its artists: the selected rows include other
entries by artists and playlists the moment's terms match, and include
**nothing by the artist just played**. The selection runs in **under 5 ms** on the fixture,
asserted. With the ledger removed, the selection equals the §2.3
render of the same snapshots, byte for byte. The context pack's `taste` is
the no-argument render in every case (§2.12's scope), and two pack reads
across a changed moment render **once** — `TasteReader.renders` proves the
memoisation still holds.

### 5.17 Found on NetEase, played from YouTube (unit) — *added 2026-09-20*
A `submit_pick` on a NetEase ref whose title and duration a YouTube hit
matches finishes with the **YouTube** resolve as its clip, keeps the model's
title/artist/announce, and leaves `music.relocate from=netease to=youtube ok`
in the dev log. A YouTube hit more than 20 s off is not taken — the walk falls
to Bilibili and then to the original ref. A submit with no title, and a
segment ref, run no relocation search at all. A `SourceAuthError` from a
relocation search closes that catalogue for the task and the submit still
succeeds. `MURMUR_PLAY_ORDER=bilibili` tries Bilibili first and YouTube
second; an unknown token in it is refused and the default order stands.

### 5.18 The play order is set from /sources (unit, scripted host) — *added 2026-09-20*
A scripted /sources session: the menu carries `( play order )` as an action
row after `( refresh now )`; pressing it opens the card in the current order
with only the mounted catalogues shown and ranked, the first ticked; picking
Bilibili re-renders the **same** card with Bilibili 1st and
`ok play order: Bilibili > YouTube` leading it; `( done )` returns to the menu
with `ok play order: Bilibili > YouTube > QQ Music > NetEase`; `settings.json`
holds that list; and a `submit_pick` through tools built **before** the card
ran relocates by the new order — no restart. Esc after a pick restores the
order the card opened on. An unmounted catalogue is never shown and keeps its
stored position behind the promotion.

### 5.19 A pick names itself, and the block names no kept song (unit) — *added 2026-09-21*
`submit_pick` declares `title` and `artist` **required** in the schema the
model reads (asserted on the tool's own schema, not only on the handler), and
a call whose title or artist is missing or blank is refused — before the
avoid-list check, before any relocate, before any network round — with a
message naming both fields; nothing is aired and no clip is resolved. On the
§5.14 fixture the block contains **none** of the 186 kept titles while
`Artists they return to` still counts them, and `TASTE_GUIDANCE` describes
what the listener keeps as anchors, with the old "not two in a row" sentence
gone. The per-100-air familiar share is **not** asserted in a unit test: it is
the by-ear metric of §3.10, owed after the change has run.

### 5.20 The pick has somewhere to go besides memory (unit + live probe) — *added 2026-09-21*
`search_music` offers **`playlists`** with nothing mounted at all, and routes
it to the mood pool rather than to yt-dlp; a phrase the category tree does not
know takes the playlist search, a phrase that IS a category takes
`playlist/list?order=hot`, the tree is read once per process, and two
playlists at most are read per call, interleaved and deduped. The daily lane
renders its own block with each platform's reason where it gave one, reads
once per 24 h and once at a time, keeps yesterday's songs when today's read
fails, logs **counts only**, and reaches the pick situation but not the talk
pack. `submit_pick` primes the neighbour pool with the ref it committed to and
only on a pick that was accepted; the pool reads NetEase by song id and
YouTube by video id, answers the cache without a network round, and is empty
for a ref neither platform can seed from — including when a pool it had
filled is followed by a pick from a platform that cannot seed one. A failed
read keeps the pool; an older read that lands after a newer one does not
overwrite it. Disconnecting every account empties the daily lane at the next
pick, inside the 24 h window, and two mounted platforms each reach the block. Every endpoint above was **probed
live** through this code on 2026-09-21 (mood pool 5, category pool 5,
neighbours 5, YouTube mix 15); the unit suite runs on fakes.

### 5.21 The radio knows what they already know (unit) — *added 2026-09-21*
`search_music` hits come back labelled `kept` / `watched` / `played by
murmur` / `artist's #N hit` / `new`, judged in code: a liked or playlist row
on any mounted source, a history row (including a video platform's, which the
block hides), a label murmur aired or has queued, or the artist's own top ten.
A title matches through its trailing parenthetical; an artist matches
word-boundary-aware, so the same title by another artist is **new**. The
ranking is read once per artist, never for a song the cheaper checks settled,
and a ranking that fails leaves the song `new`. A `new only` slot refuses a
familiar submission **once** — naming the pools — then accepts it and counts
the fail-open; a listener request arrives as `newOnly: false` with no slot
line; and over any ten slots exactly three allow the familiar, with the
streak bounded by the deck. Every line logged is a **count** (`hits=`,
`familiar=`, `artist-known=`, `refused=`, `fail-open=`), never a title.

## 6. Resolved decisions

- **The play order is a card, not an env var** (2026-09-20, user). Where a
  song plays from is the listener's preference, not a deployment setting, so
  it is a settings-layer knob set from `( play order )` in /sources and read
  per submit; `MURMUR_PLAY_ORDER` stays as the env override above the file.
  The card's verb is promotion — a pick moves that catalogue to the front —
  because it needs one key per visit and no ordering vocabulary at all.
- **Where a song is found and where it plays from are two decisions**
  (2026-09-20, user). NetEase's CDN measured ~59 KB/s against a ~1 Mbps FLAC
  here, so the model is told to search for the best *song* and code relocates
  the pick to the fastest catalogue that has it (§2.13). The alternative —
  teaching the prompt to prefer fast sources — trades recall for speed at the
  one place the model is actually good, and cannot know today's throughput.
- **Taste over transport** (2026-09-06, user). The requirement is
  recommendation quality; playback stays where it is.
- **Spotify read-only, free account** — Premium gates streaming only; the Web
  API's `/me/top/*` is the strongest taste signal of any platform here.
- **Soda read-only, QR via Douyin, no decryption** — the reference's
  decryption path exists and is deliberately not implemented; master §5's
  `musicdl` ruling stands for the same reason.
- **Deterministic digest, no brain distillation** — testable, bounded, no
  extra call; distillation is an eval question.
- **Cookie sources store the browser name only** — the reference does the
  same; a copied cookie is a liability with no benefit.
- **Deterministic mount dialogue, not a guide-brain task** — every step is a
  fixed question; a model adds cost and non-determinism to nothing.
- **NetEase identity + search through the plaintext API; playback through
  yt-dlp** — the one place where yt-dlp cannot search; keep it to the smallest
  client that fills that gap, and let yt-dlp keep owning resolution and VIP
  tiers. *Revised 2026-09-08*: that client first spoke the signed "eapi"
  transport, which meant shipping a borrowed AES key. The plaintext `/api/`
  endpoints answer all four reads without one, and 20 side-by-side queries
  across Chinese, English and Japanese returned byte-identical rankings, so
  the cipher bought nothing that had to be paid for. The known cost is
  durability: these endpoints are undocumented and being tightened
  (`/api/search/get/web` already answers empty), where eapi is the live path
  the platform's own clients use.
- **Nothing reaches the block because a video platform called it music**
  (2026-09-18, user, on their own rendered digest). Bilibili's sub-zone tag
  mislabels gossip clips as music at the source and YouTube gives no category
  at all, so the digest's rows come from songs-only sources or from an artist
  match, and the video platforms' watch and follow rows are retrieval
  material instead (§2.3, §2.12).
- **The moment-matched half serves the pick only** (2026-09-18) — the context
  pack keeps the static, mtime-memoised render; a talk prompt whose song list
  moves every beat invites recitation and buys nothing.
- **A linear scan, not a second FTS index** (2026-09-18) — a few thousand
  ledger rows do not need sqlite; `recall.ts`'s tokenising is reused, its
  storage is not. §2.12 names the upgrade path if the timing ever fails.
- **The ledger never deletes; `lastSeen` is what fades an unliked song**
  (2026-09-18) — un-liking is usually tidying, so the row loses rank rather
  than the right to exist.
- **One new dependency (`qrcode-generator`)**, named in §2.8 with the rung it clears.
- **Login is never required; the nudge is an invitation** (2026-09-06, user).
  One light form for `/sources`, `/bug`, `/feature-request`; kept in the
  input's rest state per spec 10 §3.2-C, but made context-gated and fading —
  the user judged the fixed carousel weak, not misplaced.

## 7. References — read for mechanism, never copied

None of these is a dependency. Licences noted because they decide what may
be *borrowed* at all; murmur is MIT (#206) and stays MIT.

- **yt-dlp** (Unlicense / public domain): `yt_dlp/extractor/neteasemusic.py`
  (tier walk, `-462` → login required, the preview behaviour of issue 14142), `youtube.py` (`:ytfav`, `:ythistory`), `bilibili.py`
  (`BiliBiliSearch`, favourites). The cookie-store reader is used as a
  binary, never reimplemented.
- **`guowenye/qishui-api`** (MIT): the Luna transport, QR issue/poll,
  `me_playlists`, `me_collection_mixed`, `daily_mix`. Its decryptor is not
  read for this spec.
- **NetEase and Bilibili web QR sign-in**: both endpoint pairs are the
  platforms' own, plaintext and unauthenticated; the status codes above were
  read off the live endpoints rather than from any third-party client.
- **`bjarneo/cliamp`** (no licence — mechanism only): the NetEase
  browser-name mount and session validation; the Spotify "register your own
  app" steps and the Development Mode notes; the YouTube Music
  cookie-vs-OAuth split.
- **`XxHuberrr/Mineradio`** (no licence) and its upstream
  `Wx2yZx/Mineradio-Qishui-QR-Login` (**GPL-3.0** — copying any of it would
  relicense murmur): evidence that the Soda QR passport flow works in
  practice; not read line by line.
- Spotify Web API reference: Authorization Code with PKCE; the February 2026
  Development Mode migration guide.
