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
> **search a named catalogue** (YouTube, Bilibili, NetEase) with that taste in
> hand. Does not touch the ducking engine (spec 03-02), the director's segment
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

- **Five sources**, all opt-in, each mounted by its own short conversation:

  | source | taste read | search | play | how the listener mounts it |
  |---|---|---|---|---|
  | **YouTube / YouTube Music** | liked (`:ytfav`), history (`:ythistory`), subscriptions | yes (exists) | yes (exists) | signs in to Chrome — the one source with no scan to offer |
  | **Bilibili** | favourite folders, "watch later", space audio | yes (`bilisearch`) | yes | scans a code with the Bilibili app |
  | **NetEase Cloud Music** | liked-songs playlist, own + collected playlists | yes (own client) | yes (yt-dlp with cookie, VIP tiers included) | scans a code with the NetEase Cloud Music app |
  | **Spotify** | top tracks, top artists, liked tracks, playlist names | no | no | OAuth in their browser, free account is enough |
  | **Soda Music (Qishui)** | collection, own playlists, daily mix | no | no | scans a QR with Douyin |

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
  readonly title: string          // track title, artist name, playlist/folder/channel name
  readonly artist?: string
  readonly album?: string
  readonly at?: string            // ISO, when the platform says it was liked/played (if it says)
  readonly ref?: string           // a URL the resolve path could play (cookie sources only)
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
Sources: NetEase (312 liked, 9 playlists), Spotify (top 50), YouTube (history 200)
Artists they return to: Cheer Chen (41), Bon Iver (27), Ryuichi Sakamoto (19), …   ← top 25 by count across sources
Recently kept: "Travel Is Meaningful" Cheer Chen · "Holocene" Bon Iver · …   ← 20 newest by `at`, then by source order
Playlists: late drive, deep focus, Liked from Radio, …                   ← names only, ≤ 12
Spotify says (top, medium term): artists — …; tracks — …                ← Spotify's own ranking, ≤ 10 each
```

(The example above is romanised only because committed sources are
English-only; the real digest keeps every value verbatim in its own script.)

Rules: artist counts merge across sources by exact string after trim;
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
catalogue: z.enum(['youtube', 'bilibili', 'netease']).optional()
  .describe('where to search; default youtube. bilibili and netease are available only when mounted — the tool result says which are')
```

- The tool's description lists the catalogues **currently mounted**, so the
  model never asks for one it cannot have; asking for an unmounted one
  returns `{ ok: false, reason: 'not-mounted', mounted: [...] }` and the
  model continues (non-terminating, like a failed pick).
- `MusicProvider.search(query, limit, catalogue?)` — the third argument is
  additive; existing callers unchanged.
- **YouTube**: `ytsearch{N}:` as today.
- **Bilibili**: `bilisearch{N}:` through yt-dlp (`BiliBiliSearch`), flat,
  cookie passed when mounted (better quality tiers; not required to search).
- **NetEase**: the NetEase client's `search(query, limit)` (§2.7) → candidates
  whose `ref` is `https://music.163.com/#/song?id=<id>`; `resolve` then goes
  through yt-dlp with the cookie (§2.5). The client requires a mount.
- Candidates keep today's shape (`ref, title, uploader, durationS`) plus
  `catalogue`.

### 2.5 Cookie-aware resolve

`YtDlpMusicProvider.resolve(ref)` (and `search` for Bilibili) consult the
mounted sources: when `ref`'s host belongs to a mounted source, that mount's
cookie is leased for the call and released after it. How the lease is
obtained follows the mount (§2.1):

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
`bilibili.com`/`b23.tv` → bilibili; `music.163.com`/`163cn.tv` → netease.
No mount → no cookie flag → today's behaviour exactly (a listener with no
account sees no change — acceptance §5.1).

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
  Then `x/web-interface/nav` (who, `mid`) and
  `x/v3/fav/folder/created/list-all` (folders); folder contents, watch-later
  and space audio read from the same web APIs yt-dlp's extractors call
  (*as built*: yt-dlp's flat output for these lists carries ids alone, and a
  taste is titles — so the client reads the JSON directly; a favourite whose
  `attr` bit 1 is set is a taken-down video and is dropped). Playback of a
  favourite still goes through yt-dlp with the cookie (§2.5).
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
>> 6) [ ] refresh - re-read every connected account now   ← only once something is mounted
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
- **Every result lands IN the next card** as a ready/gap row that leads
  with what happened — `connected` / `could not connect` / `disconnected` /
  `refreshed` / `could not refresh` — then the mount flow's own words:
  `ok connected NetEase — signed in as Chen X · 312 liked`, `-- could not
  connect NetEase — <the obstacle line>`, `-- could not connect Spotify —
  stopped — nothing was written`, `ok disconnected Spotify — its tokens are
  dropped here …`, `ok refreshed NetEase — 312 items` — as well as in the log
  through `info`. The verb is what tells a reopened card apart from the same
  menu again (user report, 2026-09-14). Rows that end the same way share one
  (`-- could not connect Bilibili, NetEase — the code timed out — …`): three
  failures behind one cause must still fit an 80x24 card (verified: 22 rows). The TUI floats the card
  over the log (10 §3.3), so a result printed *under* it was the failure
  mode this replaces: the card closed and reopened and the listener saw
  nothing happen (#231).
- The mount flows below keep their own asks (the YouTube sign-in Enter, the
  Spotify wait, the three scans) — they pop as before.

**How do I sign in?** — *added 2026-09-15*. Before **every** mount in the
submit but Soda Music's, one single-select card comes first (`ask` with
`options`, `multi: false` — 10 §3.2-B), and its answer picks the road:

```
How should I sign in to NetEase?
signed in to the wrong account there? sign out on the site in that Chrome window, then pick it again.
>> 1) [ ] scan with the NetEase Cloud Music app
>> 2) [ ] Chrome — Work (zach.guo@opus.pro)
>> 3) [x] Chrome — Personal (fawinell@gmail.com)
```

- **The scan row** leads, and only for NetEase and Bilibili — the two that
  can go either way. It names the app in the platform's own terms (*the
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
- **Preselection**, in order: the profile pinned in that source's existing
  entry → `$MURMUR_CHROME_PROFILE` → the profile this same submit already
  chose (three sources in a row are one person's three accounts, not three
  questions) → Chrome's `last_used` → `Default`. Every arm is a guess and
  every one is one keypress from being overruled, which is the point of
  asking. A profile the knob names that Chrome no longer lists is offered
  anyway, so the deleted-profile road (#240) stays reachable.
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
| the knob names a profile other than the pin | neither is read — the mount takes the same road as a lost login (`expired`, "connect it again"). Ticking the row again is a fresh mount, and that one resolves by the knob |
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
only when a digest is present: the listener's kept music is a strong prior
for *style*; pick for the moment; when a kept track fits, it is fine to play
it, but not two in a row; when the listener's taste points at Chinese
catalogue, prefer NetEase or Bilibili search if mounted; say in `announce`
where a pick came from only when it is theirs ("one you've kept").

### 3.4 Boot and refresh

- Boot: read `sources.json`; **never block the broadcast**. If any snapshot is
  older than **24 h**, schedule a background refresh after the second beat
  airs (the same "after boot settles" point the bed uses, 03-04). Failures log
  and keep the old snapshot; auth failures flip `status` and surface once
  (§2.6).
- No refresh while a `/sources` conversation is open (single writer).

### 3.5 Bounds

Per source per snapshot: liked/collection ≤ 500 newest, history ≤ 200,
playlists ≤ 50 names (contents are not snapshotted except NetEase's liked
playlist, which *is* the liked list), top lists ≤ 50, subscriptions ≤ 100.
Digest ≤ 1500 chars (§2.3). A snapshot file over 1 MB is a bug.

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
> `NetEase, Spotify, YouTube, Bilibili or Soda Music - murmur reads your likes there, so what it plays fits you.`
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

---

## 6. Resolved decisions

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
