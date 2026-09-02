# spec/10 · tui — the terminal front-end with a soul

> **Status**: Slices 1-3 built. **Gate 1 (§5.1) passed by user judgment
> (2026-07-29)** under the real terminal: Chinese types, commits, and
> round-trips. One thing was NOT separately confirmed and is carried as a watch
> item, not a blocker: whether Enter pressed *during* an uncommitted composition
> commits the candidate or submits the line (§5.1's note below). Slice 2
> (engine FFT tap + `viz` feed, §3.6) and slice 3 (pet substrate + warmth kit,
> §3.7) landed 2026-07-30. The §6.1 art-direction session chose and landed the
> **quiet-constellation** composition (2026-08-07): the sampled palette, the
> centered wide-terminal sky (§3.3 — recomposed 2026-08-12 as a stacked
> scene-over-log frame, starfield retired), the octant sub-pixel rendering of
> the viz feed (§3.6), and the raster whisper-figure (§3.7) — contracts
> untouched. What remains open is sensory: the §5.11 human pass and the
> by-eye tuning of the new skin (issue #79).
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
    durationS?: number             // the track's length; absent = unknown
    startedAt?: number             // epoch ms the track went on air
    scene?: string                 // time-of-day scene (spec 04 §3.4)
    activity?: Activity            // presence (spec 07); absent = unknown
  }
  ```

  **Progress (2026-08-25, user-asked).** `durationS` + `startedAt` are the
  denominator and the origin of the now-playing rail (§3.3): the front-end
  advances it on its own clock, so a playing song costs no per-second traffic.
  The length comes from the same yt-dlp extraction that resolves the stream
  (spec 03-01 §2.2), never from the model. `startedAt` rides the state rather
  than being read off arrival — a re-emit on a typed line, or a fresh attach
  replaying the state mid-song, must land on the same origin instead of
  restarting the bar. `durationS` absent (a live stream, an extractor that
  omits it) = no rail, just the title. What the rail shows is wall clock since
  air time, not the engine's audio position: an underrun re-anchors the stream
  a little later than the wall clock, so the two drift by seconds over a track.
  Exact position would mean `MusicHandle` exposing its first scheduled time and
  a periodic push; deferred until the drift is visible by ear.

  (`awaitingReply` left with the retired spec-07 invite degree, 2026-08-07 —
  a breaking removal, so `protocol` bumped 1 → 2 per §2.3.)

  The Director emits it at segment boundaries and when a typed line refreshes
  presence — no polling, no timers.

  **As built**: `onState?` is optional, mirroring the existing `debug?`/`eof?`
  convention, so a host with no status region implements nothing (`CliHost`
  does not). `banner` moved onto the interface, since the factory below returns
  the seam rather than a concrete host. A re-emit on a typed line reports the
  CURRENT segment, so a reply during a song keeps `nowPlaying` on the strip
  (§5.3).
- **`setBusy?(on: boolean)` (2026-09-01, user report).** Whether the partner
  holding the floor is WORKING right now, as opposed to waiting on the
  keyboard. Optional like `setMode?`, and for the same reason: the plain
  host's transcript is serial, so it has nothing to animate. The engine
  already tracks this distinction for the Esc router (§3.4: Esc cuts the turn
  while the guide works, ends the conversation while it waits) — the seam only
  publishes what `ConversationFlow.waiting` already knows. Flipped at exactly
  three sites: the accepted `y` in `runSetup` (lit — the first model turn
  starts immediately), `cliConversation` (dark when the reply prompt opens,
  lit when the reply is in), and the conversation's end (out with the floor,
  including the crash path). The first run's `seedPersona` call is the fourth,
  and the only one outside the guide.
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
| `hello` | `{ protocol: 2, persona, brain, voice, away?, mode? }` | handshake; replaces `banner`. `away` = seconds since murmur last heard anything, for §3.7.3. `mode` = who holds the floor right now (§3.4), so an attach mid-setup opens on the guide's face; absent = radio |
| `segment` | `{ text }` | `onRadioSegment` |
| `userLine` | `{ text }` | `onUserLine` echo |
| `state` | `ProgramState` + `microcopy?` | `onState`; drives status region + pet. `microcopy` is the DJ's line for the strip, picked engine-side from `prompts.ts` (§3.7.4) — beside the state, not inside it: it is what the program SAYS it is doing |
| `info` | `{ text, tone? }` | host info lines — context, notices, and everything that is not a question (§3.2-B). `tone: 'flow'` marks a state-transition line (a stopped flow, the going-off ack): the client renders it in marked warm ink with a `■` marker so it cannot drown in tool output; the plain host prints it like any other line. Additive |
| `ask` | `{ text, kind: 'question' \| 'consent' }` | a marked question wanting the next typed line (§3.2-B): the client pins it in the spotlight card above the input. Additive (2026-08-11) — no protocol bump. Version skew is not a live concern: the engine spawns the client from its own tree (`TUI_ENTRY`), so the pair is always lockstep; a future detached client (`murmur attach`, the daemon side-spec) owns its own negotiation, and an engine that must speak to unknown clients would need an `info` fallback then |
| `askDrop` | `{}` | every pending ask just died with its flow (§3.4): the client closes its spotlight cards. Additive (2026-08-19), and deliberately NOT in the replay backlog: a live moment must not close a future attach's fresh cards |
| `mode` | `{ who: 'radio' \| 'guide' }` | the floor changed hands mid-run (§3.4): the client repaints the three-point face. Stateful, not replayed — an attach reads the current mode from `hello` |
| `busy` | `{ on: boolean }` | the floor-holder is working rather than waiting on the keyboard (§3.4): the client shows a live sign for as long as it is true. Additive (2026-09-01) — no protocol bump. Stateful and **not replayed**, unlike `mode`, and with no `hello` field either: a sign means "right now", so a backlog handed to a later attach would open it under a sign for a turn that has already ended, with nothing coming to clear it. A turn that began with no client attached simply has no sign |
| `viz` | `{ bins: number[] }` | one FFT frame (§3.6); highest-frequency message |
| `bye` | `{}` | engine is shutting down |

TUI → Engine:

| type | payload | carries |
|---|---|---|
| `attach` | `{ protocol: 2 }` | must be first; version mismatch → engine replies `bye` |
| `line` | `{ text }` | a submitted input line — talk-back, Q&A answers, and commands alike (`/quit` included; the engine owns all parsing, same as stdin today) |
| `vizSub` | `{ on: boolean, fps?: number }` | subscribe/unsubscribe the viz stream |
| `interrupt` | `{}` | Esc with nothing client-local to close (§3.4): the engine's Esc router decides what it means from where the flow stands — never more than cutting a turn or handing the floor back. An engine with no flow registered ignores it — the first-run seeds keep their cards |

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

~~On the wire these are ordinary `info` (the question) + `line` (the answer) —
**no new message type and no engine change**; the consuming-reader semantics
live entirely engine-side. The TUI's obligation is rendering: the latest
`info` prompt must be visually adjacent to the input line (not lost in the
scrolling log) while a Q&A flow is active. A dedicated question-highlight
affordance is an open question (§6); v1 may rely on recency + log order,
which is exactly what the plain host relies on today.~~

**Superseded (2026-08-11): questions are marked, and the TUI docks them.**
Recency-adjacency proved too weak once the log breathes (§6.1 spacing) — a
question is indistinguishable from a notice. The seam grew one optional
method, `Host.ask(text, kind)` with `kind: 'question' | 'consent'`, routed
through the `ask()` helper in `src/host.ts` so a bare host falls back to
`info` (the plain front-end's behavior is unchanged). Every consuming-read
call site sends its question through it: the three first-run seeds and the
CC-bootstrap y/N (`src/first-run.ts`), the setup entry consent, the per-tool
permission prompts (one self-contained ask carrying the command AND the y/N),
the secret paste prompt, and the free-reply prompt (`src/guide.ts`). Context
lines (gap lists, offer framing) stay `info`. On the wire this is the
additive `ask` message (§2.3). Pending asks are their own engine-side queue,
NOT the general replay backlog: an attach is handed only the questions still
awaiting an answer (oldest first), a typed `line` settles the oldest (the
exact order `lineReader` consumes in), and a detach clears the queue — every
reader just declined at EOF — so a reattach never re-docks a settled or dead
question. The client mirrors that queue and pins its HEAD in a bordered
**question dock** directly above the input line — titled by kind, wrapped to
width (`tui/src/dock.ts`), the same text also appended to the log for the
record. Head, not latest: two SDK permission asks can be in flight at once,
and a single-slot dock could show command B while the typed `y` authorizes
command A. Submit answers the head and reveals the next; while any question
is docked, EVERY submitted line is an answer, the empty line included
(before the dock, the client dropped empty lines wholesale, which made spec
06's "Enter to skip" impossible in the TUI — `outbound()` in `dock.ts` now
owns that decision). The consuming-reader semantics still live entirely
engine-side; the dock is presentation, never a second grammar.

**Spotlight form (2026-08-11, user-decided — concept B of the design
exploration).** The dock's presentation is a modal moment: while any ask is
pending, the whole room steps down one notch (`hush()` in `palette.ts` — the
single color point — applied to strip, log, sky accents, and now-playing;
the kitty raster layer steps down WITH the room rather than leaving —
**amended 2026-08-12, user report: a sky going dark under every consent read
as the interface breaking** — the figure repaints faded by the same 0.55
(`HUSH_FADE`), the ripple repaints in the hushed accent with its height
clipped to end above the card (`waveRowsFor`), and either raster is deleted
only when the card's own rows would collide with it (`stagePlan`,
`cardTopRow` in `dock.ts` replaying the renderer's width/chrome math),
because kitty images composite ABOVE text cells) and the head ask renders as
a centered rounded card (refs' ~55% content width) on the `CARD` ground,
**floating over the room** (amended 2026-08-12, with §3.3's overlay
amendment): the card is absolutely positioned a gap row above the bottom
rule and takes no rows from the layout, so nothing behind it moves — the
room dims, it never rearranges — and the answer field moves INTO the card
(user decision, 2026-08-11): the same single input, permanent focus intact,
renders as the card's last row while a question is open, and the bottom row
keeps only its quiet rule. The card is where you read AND where you answer.
Kind picks the frame: warm/ember for a question (with a client-side `#n`
counter in the title), periwinkle for a consent (` · optional` in the title)
— the listener's color, because the decision is theirs; a consent card
closes with a two-option row whose default (`> N - not now (Enter)`) sits on
a raised `CHIP`, while a checklist card titles itself ` pre-broadcast
check ` and swaps the chip for the quiet two-exit row (fix now / start the
radio). The opening line splits at its first `? ` — lead sentence bright,
detail quiet (design ref B1) — and the CC-bootstrap offer ships as one
multi-line consent ask (question first, the why-lines as card notes, ref
B2). Card text carries
its hierarchy in-band (`cardLines()`): first line bright, later lines
quieter, and ASCII role markers — `ok ` (sage) / `-- ` (notice) — mark the
pre-broadcast checklist that the setup offer now ships as ONE ask
(`setupOfferText()` in `src/guide.ts`: summary, ready rows, gap rows, then
the y/N; probe detail demoted to the dev log), with a divider drawn between
the facts and the closing invite. Card copy is ASCII + CJK + box lines ONLY:
East-Asian-Ambiguous glyphs (`✦ ◉ ✓ ○ …`) shift box borders on terminals
that render them double-width, so decorative symbols stay in the log
(border-vs-CJK alignment itself was probed clean on both `widthMethod`s).
Deliberately deferred, additive when wanted: an `ask` hint field for
placeholder examples and per-flow option copy, and step metadata for a real
`n/total` — the counter and the generic option row cost zero wire changes.

**C. Commands**: `/quit` (spec 01), `/done` (guide mode), `/setup` (§3.4
mid-broadcast recall), `/bug` and `/feature-request` (the feedback channel
below), `/update` (the npm check below). The engine parses
all of them from the same line stream; the TUI never grows its own command
grammar. Future commands automatically work in both front-ends.

As built: the radio commands live in one exported list (`COMMANDS` in
`src/ipc.ts`, each entry a name + one-line blurb) that the Director's parser
and the TUI both read. The TUI's affordance is presentation only: a typed
line opening with `/` opens a small command menu floating above the input
(name + blurb per row; arrows choose, Enter runs the highlighted command, Tab
completes it into the line without running it, Esc hides it until the line
changes), narrowing with each keystroke; a line that
IS a command closes the menu and warms the input ink from periwinkle to
ember. List order is menu order only, harmless-first (`/settings` leads, so a
stray Enter on a fresh menu never quits) — the parser binds meanings to its
own literals. Adding an entry lands it in the parser and the menu at once;
the guide-mode grammar (`/done`) stays the guide's own.

**The feedback channel (as built)**: `/bug` and `/feature-request` open the
**report floor** — a third value of the floor mode beside `radio` and `guide`
(`FloorMode` in `src/host.ts`, the `mode`/`hello` messages in `src/ipc.ts`, the
client's own copy in `tui/src/app.tsx`). Both commands share it: what they mean
is "the listener is writing something to send", and only the draft's title
differs.

The floor's defining property, and the reason it is not a second guide: **it
does not stop the radio.** The guide suspends the program because it is
reconfiguring it, and there is nothing to broadcast until that settles
(`recallSetup` is awaited inside the loop). A report changes nothing about the
run, so the program keeps writing, playing and speaking underneath it; the only
thing that changes hands is the KEYBOARD, because a typed line has to be either
the bug description or talk-back and nothing can tell which. So `reportRecall`
is started and never awaited, and the Director routes every taken line into the
open session instead of reading it as a steer (`takeSteer` returns `consumed`).
`/quit` is the one line the floor does not eat — a listener must always be able
to leave.

The flow (`src/report.ts`): one opening question, asked through the existing
`GuideCapable` capability so the answer comes back written up for a maintainer
— skipped whole on a run with no brain, which goes straight to the machine's
half; then the draft, rendered by `src/diagnostics.ts` and written to
`$MURMUR_HOME/reports/<kind>-<timestamp>.md`; then four ways out — **send**
(the three roads below), **view**
(`$EDITOR`),
**clean** (re-render with the conversation lines dropped), **drop** (delete it,
back to the program). Esc is drop. Because `view` hands the file to the
listener, **send re-reads it from disk** — the copy the flow rendered is a lie
the moment they edit it. Drafts age out of the reports directory on the same
fortnight clock the daily logs use.

The client paints the floor from one mapping (`tui/src/floor.ts`) rather than a
three-way branch at each site: the report's ink is a cold slate, chosen against
the guide's warm brown (this is paperwork, not a conversation with murmur) and
kept dimmer than the listener's own periwinkle (a side-errand must not
out-shout the program it is a report about). Its copy never claims the radio
stopped, because it has not.

The browser form remains as the fallback for a Director built without a report
floor: the matching prefilled GitHub issue form
(`https://github.com/wine-fall/murmur/issues/new?template=bug.yml`,
`…?template=feature-request.yml`) — `open` on darwin, `xdg-open` on linux,
`start` on win32, passed in as `openUrl`. That opener is **required** on
`DirectorDeps` with no default behind it: while it was optional, a construction
site that forgot it silently launched a real browser and `spawn`'s swallowed
error left no trace. The label rides on the form
(`.github/ISSUE_TEMPLATE/*.yml`), not on a `?labels=` parameter, because GitHub
drops that parameter for a submitter without triage rights. Like `/settings`,
neither command composes a reply or touches what is on air.

**The npm check (as built)**: `/update` answers the one question an installed
murmur cannot otherwise be asked — is there a newer one? It reads the registry's
dist-tag document for `murmur-radio` (`fetch`, no npm process, no auth),
compares it with `packageVersion()` by the dotted numbers, and on a newer
version runs `npm install -g murmur-radio@latest`, narrating through `info`
lines: already-latest, updating-from, updated-restart-to-pick-it-up, or the
one-line command to run by hand. Every degraded path ends by handing that
command over — an unreachable registry, a missing npm, a non-zero exit.

Like the report floor it is **started and never awaited** (npm takes as long as
it takes and the program owes the listener its air throughout), and single-flight
(a second `/update` while one runs means "is it working", not two installs over
each other) — but unlike it nothing changes hands: the keyboard stays with the
radio, because a version check asks the listener nothing. `npm`'s own output is
swallowed (`stdio: 'ignore'`): the TUI owns that terminal and a progress bar
drawn over it would corrupt the frame.

Two things it deliberately does not do. It never checks on its own at startup —
an unasked-for network call before the first word, and a notice nobody typed for.
And it never restarts murmur; the new version is on disk, and the running process
keeps its own code until the listener comes back. A run that is **not** the
global install names the newer version and stops there — the test is npm's own
prefix rule (this code under the global root of the node running it), not a
`node_modules/murmur-radio/` match, because a checkout, an `npx` cache and a
project-local dependency would all fail that weaker test the same way: an
`npm i -g` from any of them installs a murmur that process is not running.
The logic and its boundaries live in `src/update.ts`; the Director only routes.

**The attachable report (as built, renderer only)**: `src/diagnostics.ts`
builds the text a listener pastes into that form — a header (version,
platform, the brain/voice/front-end a run actually wired up beside what it was
asked for, the startup probes, and a small data-driven table of known failure
signatures), then the log tail **verbatim**, then the footer naming the files
and line ranges it came from. The tail is a fixed 500 lines (a module
constant, not a knob) read backwards across the dated daily logs by
`readLogTail`. Conversation lines (the `radio`/`user` names `devLogMirror`
writes) are kept and marked by default, with an option to drop them whole —
continuations of a multi-line message included (this is what the floor's
**clean** option turns off). `render` is pure: every fact is injected, so the
report is deterministically testable. The floor above supplies those facts at
report time — version, platform, the three selections, and the probes re-run
right then rather than remembered from boot, because a listener files a report
when something changed under them. The primitives that carry a finished draft
to GitHub are built (the delivery primitives and the headless road below); what
is not yet built is the wiring between them and the floor's **send**, which for
now prints the draft's path.

**The crash sentinel (as built, detection only)**: most bugs go unreported
because nobody thinks to file one, so murmur notices for the listener. A
broadcast run writes `run/session-<pid>.json` (pid + start time) under the
murmur home when it goes on the air and puts it down on every way out it
CHOSE — `/quit`, one Ctrl-C, a bounded run finishing, and the forced second
Ctrl-C (`escalatingSigint` runs the phase's teardown before it exits).
Disarming is never a `finally`: a run that throws its way out is exactly the
crash the next boot has to notice, so a sentinel left behind is a run that
died. **One file per instance, not one
shared flag**: two radios can be on the air at once, and a single flag has
them lying to each other — one instance's clean exit erasing the other's
crash, or a second boot reading the first's live flag as a crash. So a boot
sweeps `run/` and counts only the sentinels whose **pid the OS no longer
knows** (`src/sentinel.ts`, probing with signal 0; EPERM means another user's
live process, never a crash); a live pid is a neighbour and is left alone.
Reporting and clearing are one act, so a crash is mentioned exactly once.
Only a real broadcast arms one — `--setup`, `--setup-music` and
`--bootstrap-profile` are too short-lived to tell a crash from a neighbour.
**Sending it (as built)**: three roads, tried in order, and the order is the
point.

**① A browser, which is the normal case.** The draft — re-read from disk, so
what travels is whatever `view` left behind — goes on the clipboard, and
`buildIssueUrl` opens the prefilled form. The description, version and platform
always fit; the log rides along when the 8000-byte budget allows and is
otherwise carried by the clipboard paste. **The listener presses Create.** That
is a general rule and not a concession to this piece: murmur fills a form in and
opens it, and never posts on someone's behalf while they can still read what is
about to go out. A clipboard that refused says so and names the tool that
refused — it never reports a success it did not have — and falls back to "the
draft is at `<path>`, copy it in yourself".

**② No browser, so `gh`.** The road for ssh and headless boxes. Whether a
browser exists is decided by `canOpenBrowser` from the ENVIRONMENT — `SSH_TTY`
/ `SSH_CONNECTION`, and on linux the absence of both `DISPLAY` and
`WAYLAND_DISPLAY` — never from whether the opener appeared to work, because
`openUrl` spawns detached and swallows its error. `ghReady` names the account
first and the confirm line shows it: a machine can hold more than one GitHub
identity, and a report filed under the wrong one is only noticed afterwards
(verified against a box logged in as two). The same line says what this road
cannot carry: an issue created through `gh` gets **no `bug` label**, because the
form's labels are applied by the web submission and `--label` needs triage
rights (#171). The title prefix carries the classification instead. The two
roads are not equivalent and the wording does not pretend they are.

**③ Neither.** The draft's path and a form URL, and out of the way. The URL
printed here — and on a declined ② — deliberately omits the log: nothing
reached a clipboard on these roads, so a log-bearing address would be thousands
of characters of percent-encoding burying the one actionable line, and the log
is already in the file the path points at.

Whatever the form could not hold is said out loud, in bytes, with where the
rest of it is — a shortened report that looks whole is worse than a short one
that admits it.

Every executor behind these roads (the clipboard spawn, the `gh` runner, the
opener) is **required with no default**, wired once in `src/app.ts`. The rule
generalizes the `openUrl` lesson: a dependency whose default has a real effect
on the machine — a browser, an editor, a subprocess, someone's clipboard — is
required, and the type collects the call sites. A test cannot file an issue or
write a clipboard by forgetting an injection.

**The delivery primitives (as built, parts only)**: `src/deliver.ts`.
`copyToClipboard` puts the draft where a listener can paste it — `pbcopy` on
darwin, `clip` on win32, and on linux `wl-copy` then `xclip -selection
clipboard`, since either stack may be absent and neither is a dependency we
provision. The platform decision is a pure function shaped like `openerFor`;
a thin executor (with an injectable spawn) runs it and, crucially, **answers
whether the text actually landed**, so the caller can fall back to "the draft
is at <path>, copy it yourself". `buildIssueUrl` prefills the GitHub issue
form by field id — measured against the real forms, all five bug fields
including the `logs` textarea prefill correctly, so the earlier worry about
inconsistent form prefill does not apply here. The one real constraint is
length: the WHOLE URL is budgeted at 8000 bytes, and `logs` is the only field
that may be sacrificed to fit (what happened, what was expected, the version
and the platform are what make a report actionable, and are kept even when
keeping them costs the budget). A trim drops the FRONT of the excerpt — the
lines nearest the failure are what a maintainer reads — on whole characters,
never inside a multi-byte sequence. What was cut, and how much of it
survived, comes back as a return value: the listener is told, never handed a
silently shortened report.

**The headless road (as built, parts only)**: the browser is the main road —
the listener reviews the prefilled form and presses Create themselves. `gh` is
for a box with no browser to press it in (ssh, a headless machine).
`ghReady()` answers in three states, because each has a different next step:
gh is not installed, gh is installed but nobody is logged in, or ready — **and
who as**. The account name is not decoration: a machine can hold more than one
GitHub identity, and filing a report as the wrong one is only noticed
afterwards, so the confirm line says whose name goes on it. A status gh prints
but we cannot parse an ACTIVE account out of is NOT "ready" — filing as an
identity we cannot name is the mistake the probe exists to prevent, and gh can
exit 0 with the active credential broken and a saved one healthy, so a listed
account is never taken for the active one. The probe is scoped to
`--hostname github.com`: a bare status walks every configured host, where a
stale Enterprise credential could fail it outright or hand back an identity
that cannot file this report at all. `createIssueWithGh`
files it, body through `--body-file` (a report carries a log tail, and an
argument list has a length limit).

**Measured, not assumed** — the two roads do not produce identical issues.
Verified against the real API (wine-fall/murmur#171, gh 2.52.0, an issue
created and closed for this purpose): an issue filed through `gh issue create`
does **not** pick up the `labels: ['bug']` declared in `bug.yml`. Those labels
are applied by the web form submission; gh posts through the REST API, where
the template never participates (`--template` seeds body text only). `--label`
cannot close the gap either — it needs triage rights on the repo that an
ordinary reporter does not have, and asking for one would fail the whole
filing. So the gh road sends no label at all, and the **title prefix**
(`[bug] ` / `[feat] `, the same prefixes the forms set) carries the
classification instead.

**The crash's own report (as built)**: noticing is only half of it — a lost
run that nobody writes up is still an unreported bug, so murmur offers to
write it up itself (`want me to write that up as a bug report? [y/N]`).

The crash road asks a DIFFERENT question from `/bug`'s. `/bug` opens with
"what broke?" because the listener came to report something they just saw. A
crash is murmur raising it, a boot later, about a run the listener has no
memory of — so it does not ask them what happened. **murmur writes the
description**, from what the sentinel and the log can actually show, and the
listener edits it in the draft (`startReport` takes an optional third
argument: a description the caller already has, and the log window it belongs
to). The wording claims only what a sentinel proves — the run took none of
its own exits — names when it started and what it last wrote, and says
outright that why it ended is not visible from here. No guessing on the
listener's behalf.

The evidence window is different too. `/bug` takes the last 500 lines, which
for a crash would be this boot's opening lines and nothing about the run that
died. `readCrashWindow` uses the sentinel's start time to take **that run's
own window** out of the day it started in (a run that spans midnight keeps
writing to its start day, so one file holds it), bounded above by this boot's
start, and keeps the END when it is too long. A run that exited cleanly in
between leaves no marker and falls inside the window — bounded and named,
not hidden.

Pre-broadcast on purpose: the radio has not gone on the air yet, so the
report floor's "never stop the program" rule has nothing to stop, and it is
the one stretch where the keyboard is free. The offer reads through the same
`lineReader` the onboarding flows use, so `/quit` still leaves, and the
draft's own keyboard hand-off peeks to wait and takes only what it delivers —
a race lost on a consuming read would swallow the line it was racing for.

A no is answered once and dropped. Either way the run is never raised again:
the sentinel was cleared when it was collected, before this run armed its
own, so the report-once contract holds whichever way the listener answers —
including a listener who leaves before the offer. A `--brain stub` run has no
brain behind the report floor and degrades to the notice alone.

The resting input carries the invitation: its placeholder rotates every three
minutes through the talk-back line and one row per feedback command
(`/bug · report a bug on GitHub`), so a listener who never opens the menu
still meets them. The rows are derived from `COMMANDS` — no second copy of
the wording — and lead with the command, which is the half worth keeping when
a narrow field clips the tail. The plain host says the same thing once, in
its banner. Deliberately NOT an engine-side periodic line: a hint in the
transcript is the program talking about itself.

**D. Display-state inventory** (everything the engine can tell the TUI, and
where it lands):

| Signal | Source | Rendered in |
|---|---|---|
| talk on-air / music + title / gap | Director segment boundaries | status region; pet pose |
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
line owns focus permanently. **One sanctioned exception (2026-08-07, spec 12
§3.6)**: the listener-invoked `/settings` pane routes keys to itself until
Esc. The permanent-focus rule defends against *radio output* stealing focus
mid-keystroke; a mode the listener opened is the listener spending their own
focus, and the broadcast never pauses under it.

**Station ident (2026-08-11, user-asked):** the murmur wordmark
(`tui/src/logo.ts`, half-block letters + tagline) opens every program log —
the first thing a boot shows, scrolled away by the program itself.
~~**Amended (2026-08-19):** in the wide composition the ident is PINNED between
the scene band and the log whenever the log region can spare its rows.~~
~~**Superseded (2026-08-26): the region below the scene band is two columns —
log left, ident right.**~~ **Superseded again (2026-08-26, after seeing it: the
side-by-side split cost the log its width and put the mark where the eye does
not look for a station name.) The composition stays vertical — scene band,
ident, log — and the ident is PINNED between the band and the log at every
height in the wide composition.** What changes with height is how much of the
ident there is, and the ladder has one rule behind it: **the figure never
yields rows; only the title does.**

| the log can spare | the ident is |
| --- | --- |
| >= 12 rows | the full mark: three-row wordmark + tagline |
| >= 8 rows | one small line — `murmur · a companion radio` |
| below that | nothing — the status strip is already carrying the name |

`identSize` (`tui/src/logo.ts`) is that ladder. The old switch traded the whole
ident for log rows and dropped it back into the scrollbox, where the program
scrolled it away — the one thing the pin existed to prevent. The narrow band
keeps the classic in-log ident that the program scrolls away itself.

**As built (2026-08-12, stacked recomposition — supersedes the 2026-08-07
side-panel): composition has one breakpoint, one max width, and one vertical
split.** At ≥ 96 columns the alive band recomposes as a full-width **scene
band over the log**: the sky spans the frame's top — the visualizer's bins as
a radial wave riding an implied circle (§3.6) with the whisper-figure at the
circle's center (§3.7) over an otherwise empty night — with now-playing as a
centered tricolor `♪` line under the band — carrying, when the track's length
is known, an 18-cell eighth-block rail and `elapsed / total` on the SAME row
(the band's row count is fixed: a row that appeared with a song would shift the
sky out from under the raster layers' absolute anchors). The label is cut to
whatever cells the note, the rail, and the clocks leave — measured in terminal
cells over graphemes, since a CJK or emoji-carrying title is twice as wide as
its length and a wrapped row takes a line the sky is standing on — and the log
sits beneath at
scene:log ≈ 2:1 (`sceneSplit`: the log takes a third of the usable rows,
floored at six — the listener is here for the radio, not the transcript).
The log keeps one blank line between entries and the newest broadcast line
carrying a bullet. The strip is one centered line over a full-width rule.
Past 184 columns the whole frame centers with symmetric margins instead of
stretching. Below 96 columns the classic bottom band stands unchanged, and
now-playing stays in the status strip. Same four regions either way; only
the composition moves, which is exactly the §6.1 licence. **Overlays and the
band**: the settings pane reclaims the band's rows outright (a mode the
listener opened is their own full attention); a spotlight card keeps the sky
on stage dimmed per §3.2-B ~~, and the band steps off only when the card's
top row (the renderer's own math, `cardTopRow`) would climb into the scene —
the short-terminal case where both cannot fit~~ — **amended 2026-08-12 (user
report: the card is a mask, not a sibling — a checklist card tall enough to
trip the yield collapsed the whole scene and threw the wordmark to the top
of the frame): the card floats (yoga absolute, above the text layer), takes
no rows from the composition, and the band never steps off while the pane is
closed; only the raster layers yield, per-rectangle, where the card's own
rows reach (`stagePlan` / `waveRowsFor` against `cardTopRow`), because kitty
images composite above text cells and would otherwise cover the card. **The starfield is
retired** (2026-08-12 design session): at character resolution the scatter
read as noise, so the night behind the wave and the figure stays empty and
the scene's texture budget goes to the wave alone.

**A yielding floor (2026-09-01, user report).** The scene:log split above is
written for a listener watching the radio. It is the wrong split for a
listener **reading a walkthrough**: the setup guide's turns are paragraphs of
instructions to act on — open this page, create a key, paste it — and a third
of the frame scrolls them away as fast as they arrive, while two thirds paint
a sky for a radio that has stopped to wait for the conversation. So a floor
declares whether it yields the band (`FloorFace.yieldsBand`), and the guide's
does: under it the band steps off and the log takes the whole frame, exactly
the trade the settings pane already makes — a mode the listener opened is
their own full attention. The **report floor does not**: it only borrowed the
keyboard, the radio is still playing behind it, and the sky still has
something to say. The narrow composition is unaffected (it has no band to
yield), and nothing about the floor's ink, strip, identity, or placeholder
changes — this is one more column in the same one mapping (§3.4), not a
second switch to keep in sync.

**As built (2026-08-06, issue #95): the pet is optional.** `MURMUR_TUI_PET=0`
(also `off` / `false` / `no`) drops the creature from the alive band, and the
gutter that separated it from the bars goes with it — the spectrum spans the
band, and the band keeps the pet's height, so nothing above or below moves and
no dead hole is left where it sat. **Default is ON**: the §5.11 listening pass
judged the pet's current form, not its existence, and §6.1 still owns its
identity. ~~The knob is client-side env, like `MURMUR_TUI_KITTY_KEYBOARD`
(§5.1) — not a `Config` field, because the engine has no business in what the
band contains.~~ **Superseded (2026-08-07, spec 12 §3.7)**: the knob is
`tuiPet` in the settings layer — the engine is the single configuration
holder, and one boolean riding the existing `settings` snapshot is not the
theming engine this section feared. `MURMUR_TUI_PET` survives as the
client-local escape hatch and final override (env beats file, per knob).

### 3.4 Input & interruption

The TUI owns the keyboard. A submitted line goes over the wire as `line`; the
engine feeds it into the same `LineQueue`, so the Director's
prepare-then-barge-in talkback path and the guide's serialized reader work
unchanged (§3.2). Ctrl-C in the TUI sends `line: "/quit"` rather than killing
only the client — one shutdown path. Every way a quit begins prints
`going off the air...` the moment it is heard (`Director.beginQuit`): the
teardown that follows (voice close, engine drain, bed position) is honest
work, but doing it in silence read as a hang (user report, 2026-08-19).

**The conversation-partner boundary (2026-08-19, grilling session — nine
user-pinned decisions).** The input line always has exactly one partner:
the DJ (murmur), or a **foreground agent session** — today the setup guide,
a real third-party code agent. The rules, written here as the extension
contract (no framework until a second agent exists):

- **At most one foreground agent session at a time.** While it holds the
  floor the radio waits (boot) — and the identity line names the agent.
- **Three-point face change** while the agent holds the floor: the status
  strip reads `in the workshop · the setup guide has the floor`, the
  identity line reads `setup guide · <brain>`, and the input line turns to
  the warm ink with the placeholder `talking to the setup guide · esc
  interrupts · /done hands back`. The floor rides `hello.mode` on attach and
  the `mode` message live; `runSetup` flips it via the optional
  `Host.setMode` seam from the accepted `y` to the conversation's end.
- **Esc interrupts, never dismisses.** Esc (with no menu/pane open) goes
  over the wire as `interrupt`; the engine's Esc router (`runSetup` in
  `src/guide.ts`, registered on `Host.onInterrupt` for the flow's whole
  duration, opening probes included) reads it by where the flow stands:
  before the accepted `y` it is "not now" (the offer declines for this boot,
  never a standing decline); while the guide **works** it cuts the TURN —
  `query.interrupt()` via the `GuideRequest.onSession` handle, the turn's
  tool calls denied and an in-turn read (the secret paste) aborted — and the
  guide goes idle listening; while the guide **waits** it ends the
  conversation exactly like a typed `/done` (the Esc-Esc exit), with the
  normal closing re-probe and verdict. Only `/quit` kills the session.
- **The listener's own half is in the log (2026-09-01, user report).** A
  foreground conversation reads as a conversation only if both halves are in
  it. The client never echoes its own keystrokes — the program log is painted
  from what the ENGINE reports (§3.3: segments + user lines + info) — and
  `onUserLine` was wired on the Director's path alone, so every line typed to
  the guide, to the first-run seeds, or to the crash-report offer vanished at
  the moment it was submitted. The echo belongs in `lineReader` (`src/guide.ts`),
  the one keyboard path all three share, not at each caller: a line that was
  actually taken from the queue is echoed, and a read that resolved through
  some other arm of its race (EOF, Esc, the quit fast-forward) echoes nothing,
  because there is no line behind it to put in the listener's mouth.
- **Reading back through the log (2026-09-01, user report).** Until now
  nothing could scroll it: mouse reporting is never armed (master §3.6 rules
  out mouse dashboards, and not arming it is also the cheapest way not to leak
  escape codes into the shell on a bad exit), the client runs on the alternate
  screen so the terminal's own scrollback is not there either, and the
  scrollbox — permanently unfocused, since the input line owns focus — was
  only ever sticky-scrolled to the bottom. Anything that scrolled off was gone
  for good, which is what made a third of the frame (above) so expensive. So
  **PageUp/PageDown** are handed to the log by hand, a screenful minus a
  two-row overlap at a time (`pageStep`), floored at one row so the key always
  moves. They are read before the command menu and the cards, which have no
  use for them; the settings pane is the exception, because it has reclaimed
  the log's rows. `ScrollBoxRenderable` already suspends its own sticky-bottom
  under a manual scroll and re-engages at the end, so nothing yanks the
  listener back mid-read — and **submitting a line returns to the bottom**,
  because speaking is a decision to be where the answer will land.
- **The busy sign (2026-09-01, user report).** A guide turn is a real model
  call — seconds, sometimes a WebFetch — and until it returns the frame does
  not move. That is the same silence the quit teardown was fixed for above,
  and it reads the same way: as a hang. So for as long as the floor-holder is
  working, the log's tail carries a live sign naming the partner being waited
  on (`the setup guide is thinking ···`), breathing on the client's own clock
  and cleared by the next thing the partner says. A breathing ellipsis, not a
  spinner: this is a night-time radio, and a machine-shop spinner would be the
  loudest thing on the screen. The engine already knows which side of the turn
  it is on (the Esc router's `waiting`); `setBusy` (§2.1) is that state on the
  wire, and the sign is the one place the client renders it.
- **The composer (2026-09-02, user report).** The input line was a
  single-line field bounded at 56 columns with the quiet rule carrying the
  rest of the row — concept 04's radio composition, where a typed line is a
  short aside to a DJ. Under a floor that is the wrong shape: a reply to the
  setup guide is a pasted path, a question with its context, a paragraph —
  and OpenTUI's `<input>` cannot wrap at all (it pins its height to one row,
  strips newlines from a paste, and refuses `newLine()`). So while an agent
  holds the floor the bottom row is a **composer**: the same row, the whole
  width, a `<textarea>` that word-wraps and grows with the draft
  (`composerRows` in `tui/src/floor.ts`: one row per wrapped line, capped at
  `COMPOSER_MAX_ROWS` and at a third of the frame, the rest scrolling
  inside). Enter sends; shift+enter, opt+enter and ctrl-J break the line
  (`COMPOSER_KEYS` — OpenTUI's own default is the reverse, an editor's
  bargain rather than a chat composer's; under the kitty keyboard protocol
  ctrl-J arrives as `j`+ctrl, not the raw linefeed the default names, so it
  is bound explicitly). Growth is measured by the widget's own wrap
  (`editorView.getTotalVirtualLineCount()`; `virtualLineCount` is the
  viewport's rows, i.e. the height being decided), re-read after a resize
  since a rewrap is not a content change. The log absorbs the rows — it is
  the column's flex remainder — and the command menu anchors a gap row above
  the composer whatever its height. The radio's field, its
  56-column bound and its rule are untouched: that single row is what the
  band composition's raster anchors are measured from, and a paragraph to a
  DJ is not the interaction §3.2-A describes. The in-card answer field stays
  single-line too — a card asks for a key or a `y`.
- **The listener's own half, at the moment they typed it (2026-09-02, user
  report).** The echo above lives in `lineReader`, which fires when a read
  TAKES the line. A guide turn is seconds long with no read open, so a line
  typed while the guide was thinking was fed to it — and vanished: gone
  from the field, not yet in the log, until the turn ended and the next
  read took it. `IpcHost` now echoes on arrival when the guide holds the
  floor and no reader is parked on the queue (`LineQueue.hasReader`), and
  swallows the take-echo behind it. The swallow travels WITH the line, not
  as a count of echoes owed (codex review): the host records per queued
  line whether it was echoed ahead and carries that flag from `takeLine` to
  the `onUserLine` that follows, so a taker that echoes nothing — the secret
  read consuming a line typed ahead of it — leaves no debt for a later line
  to pay. Two cases stay exactly as they were: a read already open decides
  for itself — the secret paste (spec 03-03 §7.2) opens its `echo: false`
  read BEFORE the user types, so "nobody reading" is never that case — and
  the other floors, whose takers never echo: the radio's Director (commands
  are not turns, and its peek is pending almost always, so its echo was
  never late) and the report's own queue (the line IS the report). The host
  echoes ahead only where the taker would have echoed late.
- **No idle timeout.** A waiting guide waits — the exit affordance is
  written on the reply prompt and the placeholder; nothing switches the
  partner automatically.
- **Cards follow the flow**: an interrupt that reaches a registered flow
  drops the pending asks on both sides (`askDrop`); with no flow registered
  (first-run seeds, the broadcast) the interrupt is noise and the cards
  stand.

**The mid-broadcast recall (as built)**: a typed `/setup` recalls the guide
over the air. The Director treats it as a command, not a turn (the
`/settings` precedent) at every steer site — the segment loop PARKS inside
the app's `setupRecall` callback while whatever is on the air plays out
(the record keeps spinning; the clip's tail finishes on its own; no new
segment opens) and resumes when the conversation ends. The recall runs the
same `runSetup`, explicit like `make setup` (no standing decline; a clean
machine answers `everything checks out — nothing to fix.`), with the
outcome applied live where it can be: the voice provider swaps behind a
delegate when the resolved voice changed (`voiceChanged`), a repaired music
stack says it wires up next boot, and a `/quit` consumed by the guide's
reader is handed to the Director on return. Stub runs (no guide) answer
`/setup` with the shell pointer. An auth-shaped voice failure (401/402/403)
names this path once per run — `type /setup to fix it` — instead of
skipping segments silently forever (issue #97).

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
  hold).
- **As built (2026-07-30)**: 28 bins, 24fps, `fftSize` 1024. The tap is ONE
  `AnalyserNode` on a master bus the engine now owns, opened by the first
  subscription and never before — so an unwatched run has no analyser in its
  graph at all, which is how §5.5 is asserted (a spy on `createAnalyser`). Its
  output is left unconnected: it observes the bus rather than sitting in it.
  Bands take the loudest bin under them (a mean buries transients) and are
  forced strictly increasing, because a naive geometric split hands several
  low-end bands the same bin and those bars never move. `viz` frames deliberately
  bypass the §2.3 replay backlog: stale spectrum would flood out the Q&A the
  backlog exists to preserve, and mean nothing by the time it arrived. Peak hold
  is not built — one row of eighths already carries 8 sub-steps per cell; revisit
  with the §6.1 styling pass. The DSP lives engine-side; the pretty lives client-side. During talk
  the same strip can render the voice's envelope — the radio visibly
  *speaks*; on the bed it breathes low. (What ships in v1 is a §6.1 styling
  call; the feed contract is the same.)
- **As built (2026-08-07, §6.1)**: the bar strip is the narrow composition;
  wide terminals re-render the SAME feed as the constellation wave. The panel
  draws on one canvas of square **sub-pixels** — two per cell width, four per
  cell height — folded to **octant mosaics** (Unicode 16) where the terminal
  synthesizes them (Ghostty/kitty/WezTerm; `penFor`, override
  `MURMUR_TUI_PIXEL=octant|half`) and to half-blocks everywhere else. The
  wave is dashed columns of square blocks whose **bases ride the lower arc of
  one implied circle** (deep at the center, shallow at the arms), three
  temperatures by level (peach-ember peaks / cream mids / warm-grey quiet),
  fraying tips, ghost echoes past the tip — over an otherwise **empty night**
  (the 2026-08-12 stacked recomposition retired the starfield: character-cell
  scatter read as noise, §3.3). A near-covered cell holding exactly two inks
  keeps both (majority ink on the glyph, the other behind it). The sky paints
  on the client's own 12fps clock and viz frames only feed the smoother, so
  the figure animates even when the engine is silent. All of it is
  client-side arithmetic (`tui/src/constellation.ts`); the feed contract is
  untouched.

### 3.7 The warmth kit (techniques adopted from the case research)

Substrate-level commitments (the creative session styles them, the build
provides them):

1. **Sprites as text assets** (krabby / pokemon-colorscripts technique): pet
   frames are pre-generated half-block (▀/▄) truecolor text files committed
   as assets — zero image machinery, renders everywhere, upgradeable to
   octant glyphs on capable terminals. Idle loop at 2–8 fps via OpenTUI's
   timeline; reaction poses keyed off `ProgramState` (§3.2-D).
   **As built (2026-08-07, §6.1)**: the asset stays text (`.pix` grids, keys
   `x` cream fill / `w` warm outline / `s` ember sparkle), but on
   kitty-graphics terminals (Ghostty/kitty; `figurePen`, override
   `MURMUR_TUI_FIGURE=image|sprite`) the wide-panel figure renders as a
   **runtime-encoded PNG** over the kitty graphics protocol
   (`tui/src/figure-image.ts`) — integer nearest-neighbour scale chosen from
   the tty's real cell pixel size, pose frames streamed under one image id,
   doze fading the inks toward the ground. Character terminals and the
   narrow band keep the text-sprite path unchanged.
   **Amended (2026-08-26, user report: an empty sky band):** the pen reads the
   terminal's CLAIM, and tmux, ssh and anything else ignoring the window-pixel
   query keep making it while never reporting a cell pitch. Such a terminal was
   handed a PNG it does not render, with the sprite suppressed behind it — the
   figure vanished entirely, while the wave, which already demanded the pitch
   before arming its own raster, fell back to characters and looked fine. The
   figure now demands the same evidence (`figureRaster`): raster only when the
   terminal both speaks kitty AND reported its cell size, sprite otherwise.
   **The wave joined it (2026-08-10)**: on the same channel the spectrum
   renders as **stardust** (`tui/src/wave-image.ts`) — grains blown outward
   from the figure, each direction around the circle carrying one band (bass
   straight down, treble sweeping up both sides, mirrored left to right) and
   streaming as far and as thick as that band is loud, thinning as it flies.
   A direction hears a centered WINDOW of bins, not one bin, so a coarse feed
   still speaks. Ink and alpha ride the window's lifted level (a flat quiet
   grey at low alpha is invisible on the night ground), but DENSITY rides the
   raw energy — lifting that too flattens the burst into an even donut.
   Image id 2 under the figure's z; silence transmits one transparent frame
   and then stays quiet. **A terminal that will not report its cell pixel
   size keeps the character wave** — a guessed cell size paints the wrong
   area at the wrong scale.

   **Every placement MUST be named** (`p=`, one per image id). The kitty
   protocol creates a NEW placement for each display that omits one, so an
   animation loop leaves the terminal compositing every frame it has ever
   drawn: the shipped 12fps wave leaked ~900 placements a minute and slowed
   the whole machine down the longer it ran. Measured after the fix, at
   8fps on a 83x45 panel: 0 leaked, ~490 KB/s of graphics on the wire,
   ~6% CPU in the client. Density, sector count and fps are by-eye constants
   at the head of the module; fps is the first lever if a terminal struggles.
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

**As built (2026-07-30)**, four decisions this section left open:

- The pool stays in `prompts.ts` and the picked line **travels on the wire**
  (`state.microcopy`), because the client may import nothing from `src/` but
  `ipc.ts` (§5.9, pinned by `test/front-end-isolation.test.ts`). The front-end
  renders the persona's voice; it does not author it.
- **Tinting is scene-derived** for v1 (the fallback this section allows): one
  `Accent` per time-of-day scene, applied to the strip, the bar gradient, the
  pet's body, and aired segments. Per-track palettes stay §6's open question;
  swapping the source touches one function (`accentFor`).
- **Sprite assets are indexed pixel grids**, not baked ANSI: one character per
  pixel keying a palette resolved at render time. That is what lets the pet tint
  with the hour and fade when it dozes without a second set of files. Two pixel
  rows fold into one cell drawn as an upper-half block.
- The idle loop runs on a **plain interval per pose**, not OpenTUI's timeline —
  the rate (2-8fps) is the substance, and the timeline buys nothing at one
  looping sprite. Revisit if the art direction wants keyframed transitions.

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
- **spec 07**: `Activity` for pet poses (soft — an absent field just means no
  pose).
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
6. ~~The invite state is visible~~ — **[retired 2026-08-07]** with the spec-07
   invite degree (`awaitingReply` and the `turn` pose are gone).
7. Kill the TUI process mid-song: the engine keeps playing, logs one line,
   and accepts a fresh attach (the §2.3 liveness rule, pinned on fakes).
8. `/quit` and Ctrl-C from the TUI tear down TUI, engine, and voice in order;
   no orphan processes, no socket file left behind.
9. `frontEnd: 'plain'` is byte-identical to today: no socket, no Bun probe,
   no analyser tap; the fast test suite runs with no TUI-related imports.
10. With Bun absent, the startup check reports it and the front-end falls
    back to `plain` with one notice; the guided install can provision bun
    (spec 03-03 §7), after which `tui` works.
11. **Human acceptance (sensory, user-run — the real gate)**: does it feel
    like a warm little radio with a soul — pet alive, bars breathing,
    microcopy in voice — and not a dev-tool dashboard? The agent produces the
    checklist; the user judges (master §11.2 layer 3).
    **Result — 2026-08-01 user listening pass**: bed and ducking accepted, pet
    flagged; follow-ups #95 (off switch — shipped 2026-08-06, §3.3) and #79
    (identity, still open).

---

## 6. Open questions

- **Default front-end — decided (2026-07-31)**: the default is `tui`. With
  bun absent the startup probe falls the front-end back to `plain` with one
  in-program notice (and the guide can provision bun — spec 03-03 §7).
  `--plain` / `TUI=0` are the explicit escape. The user chose to flip ahead
  of the §5.11 sensory pass; that pass has since run (§5.11, 2026-08-01).
  **As built (2026-07-31)**: the flip is `ConfigSchema.frontEnd`'s default, and
  `--plain` is applied after `--tui` so an explicit opt-out always wins. The
  fallback notice is exactly one line and says nothing about how to install bun
  — that is the setup conversation's job (spec 03-03 §7.1), not a shell lecture
  printed at a user who never asked. `make dev` no longer passes `--tui`; the
  `TUI=0` knob passes `--plain` instead.
- **Reconciler**: React chosen (§3.1); if gate 1 or early build friction
  implicates React specifically, Solid is the drop-in alternative (opencode's
  production path).
- ~~**Q&A affordance** (§3.2-B): is recency-adjacency enough for guide/first-run
  prompts, or does the input line deserve a question-mode hint (placeholder
  text, prompt pinned above input)? Decide during the build, by feel.~~
  **Resolved (2026-08-11)**: both — the question dock pins the marked ask
  above the input and the placeholder flips to answer mode (§3.2-B as built).
- **Per-track palette source** (§3.7.2): thumbnails vs metadata-derived vs
  scene-only for v1 — decide when the tinting mechanism lands.
- **Visualizer during talk** (§3.6): voice envelope vs quiet strip — by ear.
- **opentui#92** (graphics-protocol bitmaps): when it lands, evaluate album
  art behind the same substrate. **Partly superseded (2026-08-07)**: the
  figure already ships as a kitty-graphics raster (§3.7) without waiting for
  OpenTUI support; opentui#92 remains relevant only if album art wants
  renderer-managed images. The escape bytes MUST go through the renderer's
  `writeOut` channel (serialized with the render thread) — OpenTUI intercepts
  `process.stdout.write` in its capture-stdout mode, so writing there feeds
  the payload back into the renderer as text and panics the native layer
  (the 2026-08-10 SIGTRAP crash). Cell pixel size likewise comes from the
  renderer's `resolution` report, not an ioctl of our own.
- **Bun→Node exit**: revisit when OpenTUI's Node FFI support leaves
  experimental status.

### 6.1 The creative session

Art direction is its own working track with the user; it styles what this
spec builds and does not reopen the contracts above.

**Decided (2026-08-07, concept session over `scratch/ui-concepts/logo-pet`):
the skin is `04-quiet-constellation`.** Its terms:

- **Palette discipline**: one shared deep blue-black night ground; each
  scene is a single near-monochrome accent family on it — the hour changes
  the warmth of the light, never the room. **Sampled from the concept
  (2026-08-07)**: everything quiet is a WARM grey (`QUIET`), the bright warm
  accent is peach (`EMBER`), the figure's outline is warm brown (`WARM`),
  the listener's channel — input line and `♪` — is periwinkle, the room's
  one cold ink, and the listener's own words are sage. Values live in
  `tui/src/palette.ts` and stay by-eye knobs.
- **Composition**: the one-breakpoint, max-width sky-panel layout (§3.3) and
  the octant sub-pixel rendering of the viz feed (§3.6).
- **Rejected**: the analog-radio dial chrome (01), the framed scene panel
  (02 — per-scene hand art, cost without a daily payoff), the zine poster
  (03 — display type has no CJK form and no small-terminal degradation).

**The pet's identity is the murmur logo (decided 2026-08-07):** the
whisper-figure in profile, hand raised to the lips. The committed sprite is
**machine-derived, not hand-drawn**: the designer's own figure from the 04
concept, extracted at its true 2px mesh by `proper-pixel-art`
(`scratch/make-pet.py` regenerates), yielding a 42×44 two-tone grid — cream
fill inside a warm outline — with the drifting embers lifted into pose
overlay frames. On kitty-graphics terminals it renders as a raster (§3.7);
elsewhere as octant/half-block cells. Still open: the by-eye tuning of all
of the above in a real terminal (issue #79) — wave depth/density/fray, star
ring density, twinkle, figure size and placement, per-scene accents.
