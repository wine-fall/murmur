# spec/14 · listening-taste — the catalogues the listener already keeps

> **Status**: **Drafted 2026-09-06**, not built. Replaces the "log in to the
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
  | **YouTube / YouTube Music** | liked (`:ytfav`), history (`:ythistory`), subscriptions | yes (exists) | yes (exists) | names the browser they are signed in to |
  | **Bilibili** | favourite folders, "watch later", space audio | yes (`bilisearch`) | yes | names the browser |
  | **NetEase Cloud Music** | liked-songs playlist, own + collected playlists | yes (own client) | yes (yt-dlp with cookie, VIP tiers included) | names the browser |
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
- **One onboarding line** (§3.9) telling a new listener the option exists.

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
  Onboarding gains exactly **one closing line** (§3.9) and nothing else; it
  never asks for a login. Mounting is always the listener's own act, later,
  through `/sources`.
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

type SourcesFile = {
  youtube?:  Mounted<{ browser: BrowserName; profile?: string }>   // `chrome:Profile 1` style
  bilibili?: Mounted<{ browser: BrowserName; profile?: string; mid: string }>
  netease?:  Mounted<{ browser: BrowserName; profile?: string; userId: string; likedPlaylistId: string }>
  spotify?:  Mounted<{ clientId: string; refreshToken: string; accessToken: string; expiresAt: string }>
  qishui?:   Mounted<{ sessionCookie: string; deviceId: string; installId: string }>
}
```

- **Secrets**: `spotify.*Token`, `qishui.sessionCookie`. The file joins the
  secret-bearing path list in the guide's `PreToolUse` guard and `cliPermission`
  (03-03 §3) — the setup guide may never read it. The dev log never prints a
  value from it (§3.6).
- **Cookie sources store the browser name, never the cookie.** The cookie is
  read by yt-dlp at call time (`--cookies-from-browser`). Nothing is copied.
- Single writer: the `/sources` flow. Atomic write (tmp + rename), like
  `settings.json` (12 §2.1).

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
mounted sources: when `ref`'s host belongs to a mounted cookie source, the
runner is invoked with `--cookies-from-browser <browser>[:<profile>]`.
One helper, unit-tested:

```ts
function cookieArgs(ref: string, sources: SourcesFile): string[]   // [] when no mount applies
```

Hosts: `youtube.com`/`youtu.be`/`music.youtube.com` → youtube;
`bilibili.com`/`b23.tv` → bilibili; `music.163.com`/`163cn.tv` → netease.
No mount → no cookie flag → today's behaviour exactly (a listener with no
account sees no change — acceptance §5.1).

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
  the rest of the task, so it does not retry it.
- **The Director** surfaces it **once per session per source** as a host
  `info` line: *"your NetEase login has expired — type /sources to renew it;
  I'll pick from elsewhere meanwhile."* Dev log: `sources.auth <source>
  <reason>`. `sources.json` gets `status: 'expired'` (single writer: the
  Director calls the same store the `/sources` flow uses).
- **Taste refresh** on a failed source keeps the last snapshot and stamps the
  digest with its date; it does not blank the taste.
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

- **`netease.ts`** — the "eapi" transport NetEase's own clients use and
  yt-dlp implements for URL resolution (yt-dlp is public-domain; the cipher
  is: AES-128-ECB over `"<path>-36cd479b6b5-<json>-36cd479b6b5-<md5>"` with a
  fixed key, hex-encoded — reimplemented in Node `crypto`, ~20 lines, pinned
  by a golden vector produced once in a smoke against yt-dlp's Python).
  Endpoints: account (`who`, `userId`), the user's playlists (the first is the
  liked-songs playlist), playlist tracks (paged, cap §3.5), search
  (`cloudsearch`, type song). Cookie: read from the browser store **through
  yt-dlp** — `yt-dlp --cookies-from-browser <b> --cookies <tmpfile> …` writes
  a Netscape jar the client reads and deletes after the call (no second
  cookie-store reader to maintain; the jar never persists).
- **`bilibili.ts`** — `x/web-interface/nav` (who, `mid`) and
  `x/v3/fav/folder/created/list-all` (folders); folder contents, watch-later
  and space audio through yt-dlp's extractors with the cookie.
- **`spotify.ts`** — OAuth 2.0 **PKCE** (no client secret) against the
  listener's own registered app (`clientId`); local redirect
  `http://127.0.0.1:<ephemeral>/callback`; scopes `user-top-read
  user-library-read playlist-read-private`; refresh handled on expiry;
  endpoints `/me`, `/me/top/artists`, `/me/top/tracks` (`medium_term`),
  `/me/tracks` (paged), `/me/playlists` (names). Browser opened through the
  Director's injected `openUrl` — never launched from a test.
- **`qishui.ts`** — the Luna app transport (`User-Agent: Luna/<ver> Android`,
  cookie header, JSON): QR issue + status poll (the QR is scanned with
  **Douyin**, not the Soda app — the upstream flow's own text says so), `me`,
  own playlists, collection, daily mix. The QR is rendered in the terminal
  as UTF-8 half-blocks via the `qrcode` package (**the one new dependency**:
  MIT, no transitive runtime deps; a QR encoder is not a few lines — ponytail
  rung 5). No decryption code exists anywhere in murmur.

Every client: timeouts, one retry on network error, no retry on auth error,
rate-limit → `rate-limited`. Every response parsed with zod at the boundary
(trust boundary — CLAUDE.md types rule).

---

## 3. Design

### 3.1 `/sources` — the only entry

A typed command in `COMMANDS` (10 §3.2-C) with the hint "your music
accounts". It runs on the same floor-parking the `/setup` recall uses (03-03,
amended 2026-08-19): the Director parks its loop, music plays on, the
conversation runs through `Host.ask` / `info`, and the loop resumes.

The conversation is **deterministic** — a small state machine, unit-tested
with a scripted host:

```
/sources
  · mounted: NetEase (Chen X, 312 liked · refreshed 2h ago) · Spotify (expired ← renew)
  · available: YouTube · Bilibili · Soda Music
  what would you like to do? [mount <name> | refresh | unmount <name> | done]
```

**Mount, cookie sources (YouTube / Bilibili / NetEase)**:
1. "Which browser are you signed in to <site> with?" — list of `BrowserName`,
   with the note that yt-dlp reads its cookie store; **macOS**: Chrome-family
   triggers one Keychain password prompt (say so *before* it appears); Safari
   needs Full Disk Access for the terminal; Firefox prompts nothing.
2. `verify()` → "signed in as <who>" or the typed failure in plain words
   ("that browser has no <site> login — sign in there first, then come back").
3. First `snapshot()` in the foreground with a progress line (counts, not
   titles); write `sources.json` + the snapshot; "done — I'll keep it fresh".

**Mount, Spotify**: ask for the client id (with the four-step "register an app"
instruction the reference documents; redirect URI printed verbatim for them
to paste into the dashboard); open the browser; wait for the callback; then
as above. A shared/public client id is deliberately not bundled: Spotify's
Development Mode (since 2026-02) ties quota and user allow-lists to the app,
and a pooled id gets pooled 429s.

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
  - A filed `/bug` or `/feature-request` leaves the set for the session.
- **Cadence unchanged**: the TUI rotates the *given* set every three minutes,
  the talk-back line first. An empty set = the talk-back line only.
- **No persisted "seen" state**: `/sources` fades by mounting; the others by
  being used. Nothing new in `settings.json`.
- **Plain host**: banner gains the `/sources` row; nothing else changes.

### 3.9 The onboarding line

Spec 06 slice A ends with the persona written and the first beat about to
air. Between those, exactly one `info` line, once, only on a real first run:

> `when you like, /sources connects your NetEase, Spotify or YouTube likes so
> I pick better. Nothing is read until you do.`

Not an ask, not a card, not repeated. A returning listener never sees it —
the invitation (§3.8) carries it from then on.

---

## 4. Dependencies

- yt-dlp ≥ 2026.08 (present; `--cookies-from-browser`, `netease:*`,
  `BiliBiliSearch`, `youtube:favorites|history|subscriptions`).
- `qrcode` (npm, MIT) — new, §2.8. Nothing else new.
- Spec 12's settings store (read-only line), spec 10's `COMMANDS`, spec 03-03's
  floor parking and secret-path guard list, spec 05's pack.

---

## 5. Acceptance criteria

Deterministic → unit (vitest, fakes, no network). Real-boundary → smoke
(`murmur-smoke`, the developer's own accounts; the user's accounts for the
platforms the developer lacks — recorded as one by-ear issue). Stochastic →
eval track (#98), out of this spec.

### 5.1 No account, no change (unit + real run)
With no `sources.json`: `cookieArgs` returns `[]` for every ref; the pack has
`taste: ''`; the music prompt renders no taste paragraph; `search_music`'s
description lists only `youtube`; a real `--plain` run's pick and play are
byte-identical in their yt-dlp arguments to today's (dev-log diff).

### 5.2 Mount, cookie source (smoke, each of the three)
`/sources` → mount → browser named → "signed in as <who>" matches the real
account → snapshot written with `items.length > 0` → the digest names an
artist the developer recognises as theirs.

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

### 5.11 Onboarding line (unit)
A scripted first run prints the §3.9 line exactly once, after `persona.md`
is written and before the first segment; a run with a pre-seeded persona
prints it zero times.

### 5.12 By-ear (one issue, user-run)
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
- **NetEase identity + search through eapi; playback through yt-dlp** — the
  one place where yt-dlp cannot search; keep it to the smallest client that
  fills that gap, and let yt-dlp keep owning resolution and VIP tiers.
- **One new dependency (`qrcode`)**, named in §2.8 with the rung it clears.
- **Login is never required; the nudge is an invitation** (2026-09-06, user).
  One light form for `/sources`, `/bug`, `/feature-request`; kept in the
  input's rest state per spec 10 §3.2-C, but made context-gated and fading —
  the user judged the fixed carousel weak, not misplaced.

## 7. References — read for mechanism, never copied

None of these is a dependency. Licences noted because they decide what may
be *borrowed* at all; murmur is MIT (#206) and stays MIT.

- **yt-dlp** (Unlicense / public domain): `yt_dlp/extractor/neteasemusic.py`
  (eapi cipher, tier walk, `-462` → login required, the preview behaviour of
  issue 14142), `youtube.py` (`:ytfav`, `:ythistory`), `bilibili.py`
  (`BiliBiliSearch`, favourites). The cookie-store reader is used as a
  binary, never reimplemented.
- **`guowenye/qishui-api`** (MIT): the Luna transport, QR issue/poll,
  `me_playlists`, `me_collection_mixed`, `daily_mix`. Its decryptor is not
  read for this spec.
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
