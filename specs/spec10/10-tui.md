# spec/10 · tui — the terminal front-end with a soul

> **Status**: Slice 1 built (wire + `IpcHost` + client shell). **Gate 1 (§5.1)
> passed by user judgment (2026-07-29)** under the real terminal: Chinese
> types, commits, and round-trips. One thing was NOT separately confirmed and
> is carried as a watch item, not a blocker: whether Enter pressed *during* an
> uncommitted composition commits the candidate or submits the line (§5.1's
> note below). Slices 2 (visualizer feed) and 3 (pet substrate + warmth kit)
> are unbuilt, and are now unblocked.
> **Part**: Front-end refinement — replaces the CLI Host's plain print/stdin
> with a real TUI. The **single richer front-end murmur ever gets**: there is
> no GUI, no menu-bar, no web surface (master [`../DESIGN.md`](../DESIGN.md)
> §3.6, §8).
> **Milestone**: front-end polish — off the L0→L1 critical path. Buildable any
> time; independent of every other open item.
> **Re-decided (2026-07-29, after a four-report deep research):** the
> front-end framework is **OpenTUI (TypeScript, Zig-core) running under Bun**,
> superseding the 2026-07 "Go / Charm (Bubble Tea)" decision (kept as a
> decision record, §3.1). **Unchanged lock**: "two processes over IPC". The
> old lock's premise "the engine is Python, so the boundary is cross-language
> by necessity" is retired — the engine is TypeScript (issue #54) — but the
> wire stays language-neutral by *format* (ndjson), not by obligation.
> **Design bar (user-set, 2026-07-29):** stability first, **visual delight is
> a first-tier requirement, not polish**. The TUI is murmur's face. "Works but
> looks like a dev tool" fails this spec.
> **Conventions**: English; written for a coding agent. Design-level —
> mechanism and contracts, not final code.

---

## 1. Goal & scope

### Delivers

A terminal UI that replaces the plain CLI host with a live, non-clobbering,
**warm** interface, running as a separate front-end process attached to the
headless murmur engine over IPC:

1. A **now-playing / status region**: current segment kind (talk / music),
   track title when playing, persona name, program state (on-air /
   inter-segment gap / awaiting-reply), time-of-day scene, presence state —
   with the DJ's personality leaking into the microcopy (§3.7).
2. A **scrolling program log**: radio segments and the listener's typed lines,
   interleaved chronologically, scrollable back.
3. A **stable input line**: always available, never clobbered by radio output
   landing mid-keystroke (the core defect of plain stdout interleaving), and
   **CJK/IME-safe** — the listener types Chinese (§5 gate 1).
4. A **live audio visualizer**: spectrum bars driven by real FFT data from the
   engine's Web Audio graph, streamed over IPC (§3.6). The radio is *seen*
   playing, not just heard.
5. A **pixel pet**: a small sprite companion with idle animation and
   state-reactive behavior (talking / music / awaiting-reply / away), rendered
   as cell art (§3.7). Concrete art direction is deferred (§6.1) — this spec
   builds the substrate (sprite assets, animation loop, state feed).
6. Clean **stop** from inside the TUI (`/quit` and Ctrl-C), tearing down TUI,
   engine, and voice in order.

### Out of scope (explicit non-goals)

- **No GUI / menu-bar / web surface** — ever (master §8).
- **Detach/reattach UX** in v1. The two-process split *is* the substrate the
  daemon side-spec (master §10.1) wants, and the wire must not preclude
  reattachment (§3.5), but v1 ships "one command, both processes, quit stops
  everything".
- **No new core behavior.** The TUI changes no Director / Brain / Voice /
  Music / Memory contract, and adds no interaction the engine does not
  already have (§3.2 is an inventory, not a wishlist).
- **No config-heavy theming engine.** One deliberate warm look (plus the
  content-derived tinting of §3.7), not sixteen knobs.
- Mouse-driven dashboards, multi-tab layouts, token/usage meters.

---

## 2. Contract / seams

### 2.1 The Host seam (engine side — existing shape, one addition)

The engine-side seam is the existing `Host` interface (`src/host.ts`, spec 01
§3.1 as ported):

```ts
export interface Host {
  start(): void
  peekLine(): Promise<string>      // race-safe peek (Director races audio vs input)
  takeLine(): string | undefined   // winner consumes explicitly
  eof?(): Promise<void>
  onRadioSegment(text: string): void
  onUserLine(text: string): void
  info(message: string): void
  debug?(message: string): void
  banner(personaFirstLine: string, opts: { brain: string; voice: string }): void
}
```

- **One addition** (this spec, extending — not breaking — the spec-01
  contract): `onState(state: ProgramState): void`, where

  ```ts
  type ProgramState = {
    kind: 'talk' | 'music' | 'gap'
    nowPlaying?: string            // title, when kind === 'music'
    awaitingReply: boolean         // an invite window is open (spec 07 §3.5)
    scene?: string                 // time-of-day scene (spec 04 §3.4)
    activity?: Activity            // presence (spec 07); absent = unknown
  }
  ```

  The Director emits it at segment boundaries and on invite-window
  transitions — no polling, no timers.

  **As built**: `onState?` is optional, mirroring the existing `debug?`/`eof?`
  convention, so a host with no status region implements nothing (`CliHost`
  does not). `banner` moved onto the interface, since the factory below returns
  the seam rather than a concrete host. A re-emit on an invite opening or a
  typed line reports the CURRENT segment, so a reply during a song keeps
  `nowPlaying` on the strip (§5.3).
- Front-end selection is config-driven (`frontEnd: 'plain' | 'tui'`, default
  `'plain'`), mirroring the provider knobs. The core never imports a concrete
  host; a `buildHost(name)` factory returns the seam.
- `IpcHost` (this spec) implements `Host` as a **thin bridge**: `Host` calls
  serialize onto the socket (§2.3); lines received from the TUI feed the same
  `LineQueue` the CLI host uses. The peek/take race semantics — and the
  guide/first-run **consuming reader** built on them (§3.2-B) — are preserved
  engine-side, untouched.

### 2.2 Two processes (locked), runtimes (decided)

- **Engine**: the existing Node ≥24 process. Owns audio
  (`node-web-audio-api`), brain, memory — everything. Runs exactly as today
  under `frontEnd: 'plain'`; the fast test layer never sees a TUI.
- **TUI client**: a separate process in the same repo, **TypeScript on
  OpenTUI, executed by Bun** (§3.1). Spawned by the engine at startup when
  `frontEnd: 'tui'` (v1); the wire allows a later standalone-attach mode
  (§3.5).
- **Why two processes stays locked** (now independent of language): the radio
  must outlive front-end death — a TUI crash or window close must not kill the
  song mid-note; crash isolation for a pre-1.0 UI dependency (§3.1 risk
  table); and it is the daemon/detach substrate. This is the shape of every
  audio daemon that survived (mpd, transmission, spotifyd) and of opencode's
  server↔client split.
- **Bun is a binary dependency, not a stack migration.** The engine, tests,
  toolchain, and CI main path stay Node. Bun is provisioned like
  `ffmpeg`/`yt-dlp` under master §10.1's binary rule: the startup check
  detects it, the setup guide (spec 03-03) installs it with consent, and
  `frontEnd: 'tui'` is simply not offered when Bun is absent (no
  half-installed state). Exit path: OpenTUI's Node FFI support is experimental
  today (Node ≥26.3 + flag); when it stabilizes, switching the TUI process
  back to Node is a launcher change, zero code.
- **`tui/` stays outside the root package manager's workspace** — weighed and
  declined when the root migrated from npm to pnpm. It keeps its own
  `tui/package.json` + `tui/bun.lock`, installed by `bun install`. Reasons, in
  order of weight: (1) a pnpm workspace shares one root lockfile, which pulls
  `@opentui/core`, `@opentui/react`, and `react` into the root lockfile and the
  root install — that directly violates §5.9's zero-cost `frontEnd: 'plain'`
  and turns `test/front-end-isolation.test.ts` red; (2) Bun is the client's
  *executor*, not merely its installer (the engine launches it as
  `bun tui/src/main.tsx`), so making Bun consume pnpm's symlinked layout would
  bet the front end's only dependency path on a risk that buys nothing;
  (3) a separate lockfile keeps the §3.1 risk table's first row — pin 0.4.x,
  upgrades are never drive-by — insulated from routine root-dependency churn.
  The cost is real and is accepted, not explained away: `bun install` also
  writes true copies (measured hardlink count 1), so `tui/node_modules` is
  another 78 MB paid per worktree, and that saving is deliberately forgone. The
  root's 415 MB was the bulk; 78 MB does not justify touching the front end's
  only execution path.

### 2.3 The wire protocol

**Transport**: unix domain socket at `$MURMUR_HOME/run/tui.sock` (resolved by
`paths.ts`, the single path authority — spec 05 §2.3). **Format**: ndjson —
one JSON object per line, `{ v: 1, type, ...payload }`. **Schemas**: zod,
defined once in `src/ipc.ts` and imported by both processes — the wire
contract has exactly one source of truth, and both ends validate at the trust
boundary (zod parse on every inbound message; malformed input is dropped with
a dev-log line, never a crash).

Engine → TUI:

| type | payload | carries |
|---|---|---|
| `hello` | `{ protocol: 1, persona, brain, voice }` | handshake; replaces `banner` |
| `segment` | `{ text }` | `onRadioSegment` |
| `userLine` | `{ text }` | `onUserLine` echo |
| `state` | `ProgramState` | `onState`; drives status region + pet |
| `info` | `{ text }` | host info lines — including every guide/first-run prompt (§3.2-B) |
| `viz` | `{ bins: number[] }` | one FFT frame (§3.6); highest-frequency message |
| `bye` | `{}` | engine is shutting down |

TUI → Engine:

| type | payload | carries |
|---|---|---|
| `attach` | `{ protocol: 1 }` | must be first; version mismatch → engine replies `bye` |
| `line` | `{ text }` | a submitted input line — talk-back, Q&A answers, and commands alike (`/quit` included; the engine owns all parsing, same as stdin today) |
| `vizSub` | `{ on: boolean, fps?: number }` | subscribe/unsubscribe the viz stream |

- **Versioned handshake, additive evolution**: unknown message types are
  ignored (forward compatibility); breaking changes bump `protocol`.
- **Liveness**: the engine treats TUI disconnect as "front-end gone", keeps
  broadcasting (the EOF-on-stdin precedent, spec 01 §3.6 — the radio plays
  on), and accepts a new `attach`. This single rule keeps the detach/reattach
  door open at zero extra cost.
- **As built**, two consequences of that rule that the table alone does not
  state: the engine keeps a **bounded replay backlog** (200 messages, no `viz`
  frames) and hands it to whoever attaches, because the first-run and guide
  questions (§3.2-B) are asked while the client is still booting and losing
  them would strand the Q&A; and **disconnect resolves the host's `eof`**, so a
  consuming reader declines instead of wedging — the same contract stdin EOF
  already has.

---

## 3. Design

### 3.1 Decision record — how the framework was chosen (2026-07-29)

Four research passes (two on the stability axis, two on the visual-delight
axis) compared Ink v7 (TS), OpenTUI (TS/Zig), Bubble Tea v2 (Go), and Ratatui
+ tachyonfx + ratatui-image (Rust). Load-bearing findings, recorded so the
choice is not relitigated on vibes:

- **The delight ceiling is not language-neutral.** OpenTUI is the only stack
  where sprite animation, particle generators, keyframe timelines, per-cell
  alpha compositing, 2D physics, and GPU-rendered-to-cells 3D are stock parts
  with runnable in-repo demos (verified locally, 2026-07-29). Rust's tachyonfx
  (the best effects library in any language) + ratatui-image (true
  kitty-protocol bitmaps, proven in rmpc/yazi) is the mature runner-up.
  Bubble Tea v2 is superb plumbing with a "gorgeous dev tool" gravity and no
  effects/image story. Ink v7's ceiling is "the prettiest text app" —
  precisely the look this spec must escape; and a sustained ~20fps visualizer
  sits on its known flicker/full-rerender weak spot.
- **Industry precedent runs toward, not away from, this choice**: opencode ran
  exactly the architecture the old decision locked (TS engine + Go Bubble Tea
  client) and abandoned it to unify on TS with OpenTUI, now in production at
  1.0 scale. Codex CLI's TS→Rust exit was driven by Node-free distribution
  and sandboxing — reasons that do not apply to a local Node app.
- **The old decision's premises expired**: Bubble Tea v2 (2026-02, first
  breaking change) invalidated the v1 corpus that made Charm "AI-friendly,
  fast to build against" (the original top priority); `ntcharts`'s
  off-the-shelf charts reduce to ~100 lines of cell rendering because the
  engine computes the FFT (§3.6); and the pixel pet was custom work in every
  stack (the old §3.1 said so itself).

**Decision: OpenTUI** — `@opentui/core` + the **React reconciler** — as the
separate TUI client under Bun. React over Solid: the agent-corpus advantage
that drove the original Charm pick now points at React, murmur has no
fine-grained-reactivity performance need, and the reconciler is swappable
pre-build if evidence says otherwise.

Risks accepted, with teeth (each has an owner clause in §5):

| Risk | Fact | Mitigation |
|---|---|---|
| pre-1.0 API churn (v0.4.x) | churn is at the API surface; the runtime is production-proven in opencode | **pin the exact version**; upgrades are their own task, never drive-by |
| CJK/IME regressions (worst track record of the four: the kitty keyboard protocol once bypassed IME composition entirely in opencode) | mostly patched upstream; murmur's input is one line editor, far simpler than opencode's | **week-1 hard gate** (§5 gate 1): Chinese IME typing must work before anything else is built on the choice; failure escalates to the user with the Ratatui / Ink fallback trade-offs |
| no graphics-protocol bitmaps yet (opentui#92 open) | pet/covers are cell art only | cell art is the *chosen* aesthetic anyway (§3.7): half-block sprites read as pixel art (krabby precedent), and kew built the warmest player in the genre on pure ANSI; revisit when #92 lands |
| Bun as a second runtime | one more provisioned binary | scoped to the leaf process (§2.2); the guided install owns it; a Node exit path exists |

**Rejected**: Ink v7 (right answer for a text front-end, wrong ceiling for
this one); Bubble Tea v2 (second language + dev-tool gravity + the opencode
counter-example); Ratatui (the stable-and-fancy runner-up — re-open it first
if OpenTUI fails gate 1 and the bitmap/effects ceiling outweighs language
unity at that point).

### 3.2 Interaction inventory — derived from the shipped feature set

Everything the TUI must support already exists in the engine; this section is
the exhaustive map from shipped behavior to front-end interaction. The TUI
adds **rendering**, never semantics.

**A. One text line, four contextual meanings** (all engine-owned; the TUI
sends `line` and renders the outcome):

| Context | What the engine does today | TUI consequence |
|---|---|---|
| radio is talking | barge-in: interrupt → in-persona reply → program resumes (spec 01 step 3) | reply appears as a segment; no special UI |
| music is playing | **duck**: music dips, reply airs over it, music recovers (spec 03-02) | now-playing stays visible while the reply segment renders |
| any time | **steer**: buffered look-ahead beats are discarded so upcoming talk follows the user's direction (spec 04 §3.3) | invisible mechanically — but this is why typing feels steering-shaped, worth reflecting in §6.1's affordance thinking |
| invite window open (spec 07 §3.5) | the line answers the DJ's turn-to-you; window clears via the ordinary talkback path | `awaitingReply` in `ProgramState` — status region + pet show "it's waiting for you"; clears on the next `state` |

Every typed line is also a **presence signal** (spec 07: the host stamps the
ActivitySensor; typing flips `away` back to `engaged` and un-gates
generation) — free with the same `line` message, since the stamp lives in the
engine-side host bridge.

**B. Serialized Q&A mode** (consuming reads — `lineReader`, `src/guide.ts`):
two shipped flows temporarily repurpose the input line as an answer field:

- **First-run onboarding** (spec 06 slice A): three seed questions, empty
  line = skip; then the CC-bootstrap consent prompt (`[y/N]`, default no).
- **Music setup guide** (spec 03-03): the `y/N` entry consent, per-tool
  permission prompts ("setup assistant wants to run [tool]: … allow?
  [y/N]"), and free natural-language replies with `/done` to finish.

On the wire these are ordinary `info` (the question) + `line` (the answer) —
**no new message type and no engine change**; the consuming-reader semantics
live entirely engine-side. The TUI's obligation is rendering: the latest
`info` prompt must be visually adjacent to the input line (not lost in the
scrolling log) while a Q&A flow is active. A dedicated question-highlight
affordance is an open question (§6); v1 may rely on recency + log order,
which is exactly what the plain host relies on today.

**C. Commands**: `/quit` (spec 01), `/done` (guide mode). The engine parses
all of them from the same line stream; the TUI never grows its own command
grammar. Future commands automatically work in both front-ends.

**D. Display-state inventory** (everything the engine can tell the TUI, and
where it lands):

| Signal | Source | Rendered in |
|---|---|---|
| talk on-air / music + title / gap | Director segment boundaries | status region; pet pose |
| awaiting-reply (invite open) | spec 07 §3.5 window | status badge + pet turns to you |
| time-of-day scene | spec 04 §3.4 | status region; tint fallback (§3.7) |
| presence (engaged / present / away) | spec 07 ActivitySensor | pet pose (away = dozing); away also means sparse talk — the pet explains the quiet |
| anchor moments (good-morning …) | spec 07 §3.4 | ordinary segments; no special UI |
| program text + user echo | `segment` / `userLine` | program log |
| host notices (preflight, memory, guide) | `info` | program log (+ Q&A adjacency, B above) |
| identity (persona / brain / voice) | `hello` | status region, replaces the boxed banner |

### 3.3 Layout (design-level)

```
┌──────────────────────────────────────────────┐
│ status strip: ♪ now-playing · state · scene  │   ← §3.2-D signals + DJ microcopy
│                                              │
│  program log (scrolls)                       │   ← segments + user lines + info
│  ...                                         │
│                                              │
│ ┌────────┐  ▂▄▆█▆▄▂▁▂▄▆▄▂  (visualizer)      │   ← pet + spectrum share
│ │  pet   │                                   │      the "alive" band
│ └────────┘                                   │
│ > input line (always focused, IME-safe)      │
└──────────────────────────────────────────────┘
```

Exact composition, palette, and the pet's look belong to the §6.1 creative
session; this spec fixes only the four functional regions and that the input
line owns focus permanently.

### 3.4 Input & interruption

The TUI owns the keyboard. A submitted line goes over the wire as `line`; the
engine feeds it into the same `LineQueue`, so the Director's
prepare-then-barge-in talkback path and the guide's serialized reader work
unchanged (§3.2). Ctrl-C in the TUI sends `line: "/quit"` rather than killing
only the client — one shutdown path.

### 3.5 Process lifecycle (v1)

- `frontEnd: 'tui'`: the engine binds the socket, spawns the TUI client
  (Bun), and proceeds with startup; the TUI attaches and receives `hello`. If
  the client dies, the engine logs one line and keeps broadcasting (headless
  until reattach or quit) — the radio never dies with its face.
- `frontEnd: 'plain'` (default until §6's default question is settled):
  today's behavior — no socket, no Bun, zero new cost.
- **Deliberately kept, not built**: `murmur attach` (connect a TUI to an
  already-running engine) needs nothing beyond §2.3 — it is the daemon
  side-spec's first feature, not v1's.

### 3.6 The visualizer feed (engine side)

- The engine's Web Audio graph gains one `AnalyserNode` tap on the master
  bus; a `viz` frame carries ~24–32 log-spaced magnitude bins.
- **Attach-aware and free when unwatched**: frames are computed and sent only
  while a TUI is attached *and* subscribed (`vizSub`), at a fixed modest rate
  (default 24fps, TUI-negotiable). Headless runs pay nothing.
- The TUI renders bars from bins — cava's recipe (eighth-block glyphs
  ▁▂▃▄▅▆▇█, per-bin attack/decay smoothing, vertical truecolor gradient, peak
  hold). The DSP lives engine-side; the pretty lives client-side. During talk
  the same strip can render the voice's envelope — the radio visibly
  *speaks*; on the bed it breathes low. (What ships in v1 is a §6.1 styling
  call; the feed contract is the same.)

### 3.7 The warmth kit (techniques adopted from the case research)

Substrate-level commitments (the creative session styles them, the build
provides them):

1. **Sprites as text assets** (krabby / pokemon-colorscripts technique): pet
   frames are pre-generated half-block (▀/▄) truecolor text files committed
   as assets — zero image machinery, renders everywhere, upgradeable to
   octant glyphs on capable terminals. Idle loop at 2–8 fps via OpenTUI's
   timeline; reaction poses keyed off `ProgramState` (§3.2-D).
2. **Content-derived tinting** (kew's signature): when a track starts, derive
   a small accent palette and tint the UI with it — the interface breathes
   with the music. v1 may fall back to scene-based tinting (spec 04's
   time-of-day) if per-track art proves awkward; the mechanism — one accent
   palette, swappable at segment boundaries — is the commitment.
3. **Alive across absence** (tama96's lesson): on startup the pet
   acknowledges elapsed time (spec 05 memory + spec 07 presence provide the
   data free). No decay mechanics — murmur is a companion, not a chore.
4. **The DJ leaks into the chrome** (Claude Code's spinner-verb lesson,
   radio-native): status microcopy is written in persona voice ("finding
   something for this hour…", not "loading"), sourced from a fixed local pool
   in `prompts.ts` — zero tokens (master §7 pillar 6).

### 3.8 Terminal support & degradation

- **Primary targets**: Ghostty, Kitty, iTerm2, WezTerm (macOS focus; all
  support synchronized output; Ghostty/Kitty render legacy-computing glyphs
  procedurally).
- **Everything is cell art** in v1 (§3.1 risk 3), so the only degradation
  axes are truecolor (downsample where absent) and glyph coverage (octant →
  half-block fallback). Terminal.app/Alacritty get the same UI, slightly
  chunkier.
- OpenTUI emits synchronized-output brackets natively — the anti-tear
  substrate for the visualizer band comes free.

### 3.9 Testing posture

- The engine side (IpcHost bridge, socket lifecycle, viz tap gating, schema
  validation) is deterministic → unit tests on fakes, no TUI, no Bun (the
  fast-layer rule, master §11.1).
- The wire is pinned by round-trip zod tests (every message type
  encodes/decodes; unknown types are ignored).
- The TUI client's rendering is *not* unit-asserted frame-by-frame (that way
  lies brittleness); it gets a bounded smoke — launch under Bun against a
  fake engine emitting a scripted broadcast; assert it attaches, renders,
  submits a line, quits clean — plus the human acceptance pass (§5).
- Diagnostics stay out of the TUI: the dev log (`MURMUR_DEV_LOG`,
  `make logs`) is untouched; if a debug pane is ever wanted, the TUI tails
  the same file. The program log renders user content only.

---

## 4. Dependencies

- **spec 01**: the Host seam (extended with `onState`), `LineQueue`
  semantics, the talkback path, orderly shutdown.
- **spec 03-02**: the audio engine (gains the analyser tap); the bed as the
  visualizer's quiet-state source.
- **spec 03-03 / spec 06**: the `lineReader` Q&A flows the TUI must render
  (§3.2-B); master §10.1's guided-install rule provisions Bun.
- **spec 07**: `Activity` + the invite window for pet poses and the
  awaiting-reply badge (soft — absent fields just mean no pose).
- External: `@opentui/core` + `@opentui/react` (version pinned), Bun ≥1.3,
  `node:net` + zod for the wire (no new protocol dependency).

---

## 5. Acceptance criteria

Gate 1 is sequenced first and is a **hard gate**: it runs before any further
TUI work is built on the framework choice.

1. **CJK/IME gate (week-1, user-run, hard)**: in the OpenTUI input widget
   under Ghostty and iTerm2, typing Chinese through the system IME works —
   composition visible, candidates commit correctly, nothing double-renders —
   and the same line round-trips to the engine and back into the program log.
   **Failure = stop: escalate to the user with the Ratatui / Ink fallback
   trade-offs (§3.1) before writing more TUI code.**
   Escape hatch to try first, wired for this gate:
   `MURMUR_TUI_KITTY_KEYBOARD=0` disables the kitty keyboard protocol, which is
   the mechanism behind the recorded regression.
   **Result (2026-07-29): passed.** Chinese composes, commits, and round-trips
   to the engine and back into the program log. Pinned deterministically
   alongside it: CJK reaches the engine byte-identical (including mixed
   scripts, CJK punctuation, and a character delivered one byte at a time),
   and a half-typed CJK line survives eight interrupting segments.
   **Open watch item**: during the pass, two lines lost text that had not been
   committed by the input method when Enter was pressed — the ambiguity of
   Enter (commit the candidate vs submit the line). The engine-side path was
   cleared by the byte tests, so if this recurs it belongs to the input widget
   and `MURMUR_TUI_KITTY_KEYBOARD=0` is the first lever.
2. Launching with `frontEnd: 'tui'` shows the status region, program log,
   visualizer strip, and pet; radio segments appear as they air.
3. Typing while the radio talks never clobbers the input line; submitting a
   line interrupts, gets the in-persona reply, and the program resumes —
   identical semantics to the plain host. During music, the reply ducks the
   track and now-playing stays visible (§3.2-A).
4. **The Q&A flows work in the TUI**: a first-run under `frontEnd: 'tui'`
   asks the three seed questions and the consent prompt usably (prompt
   adjacent to input, answers echo, skip/decline paths intact); the music
   setup guide's `y/N` and `/done` flows likewise. No engine change — this
   criterion pins the §3.2-B rendering obligation.
5. The visualizer moves with real music (engine FFT feed), sits quiet on the
   bed, and costs the engine nothing when the TUI is detached or unsubscribed
   (assert: no analyser reads headless).
6. The invite state is visible: with a spec-07 invite window open,
   `awaitingReply` renders (status badge / pet pose) and clears when answered
   or expired.
7. Kill the TUI process mid-song: the engine keeps playing, logs one line,
   and accepts a fresh attach (the §2.3 liveness rule, pinned on fakes).
8. `/quit` and Ctrl-C from the TUI tear down TUI, engine, and voice in order;
   no orphan processes, no socket file left behind.
9. `frontEnd: 'plain'` is byte-identical to today: no socket, no Bun probe,
   no analyser tap; the fast test suite runs with no TUI-related imports.
10. With Bun absent, the startup check reports it and `tui` is not offered;
    the guided install can provision it (spec 03-03 flow), after which `tui`
    works.
11. **Human acceptance (sensory, user-run — the real gate)**: does it feel
    like a warm little radio with a soul — pet alive, bars breathing,
    microcopy in voice — and not a dev-tool dashboard? The agent produces the
    checklist; the user judges (master §11.2 layer 3).

---

## 6. Open questions

- **Default front-end**: `plain` stays default until the TUI passes §5.11 by
  feel; flipping the default is a one-line config change decided by the user.
- **Reconciler**: React chosen (§3.1); if gate 1 or early build friction
  implicates React specifically, Solid is the drop-in alternative (opencode's
  production path).
- **Q&A affordance** (§3.2-B): is recency-adjacency enough for guide/first-run
  prompts, or does the input line deserve a question-mode hint (placeholder
  text, prompt pinned above input)? Decide during the build, by feel.
- **Per-track palette source** (§3.7.2): thumbnails vs metadata-derived vs
  scene-only for v1 — decide when the tinting mechanism lands.
- **Visualizer during talk** (§3.6): voice envelope vs quiet strip — by ear.
- **opentui#92** (graphics-protocol bitmaps): when it lands, evaluate a crisp
  pet / album-art upgrade behind the same sprite substrate.
- **Bun→Node exit**: revisit when OpenTUI's Node FFI support leaves
  experimental status.

### 6.1 The creative session (deferred, unchanged in spirit)

Art direction remains its own working session with the user: palette and
overall warmth, the pet's identity and personality (what it is, how it
reacts, what it does when you're gone), visualizer styling, whether typing
deserves a steering affordance (§3.2-A), and how the four regions compose
into something that feels alive. That session styles what this spec builds;
it does not reopen the contracts above.
