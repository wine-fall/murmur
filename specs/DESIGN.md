# murmur · v1 Master Spec (living doc)

> **Status**: Building. Architecture/feature-set aligned; **spec 01 (`core-loop`, the L0 spine) is implemented & verified** and **spec 02 (`voice-provider`) is code-implemented** (real-voice acceptance is a hands-on gate) — so L0 is audible. **spec 03 (all three parts) is code-implemented**: 03-01 `brain-harness` (find + pull), 03-02 `ducking` (the mixing engine, cadence, and music wiring — music now reaches the speakers; the Director consumes 03-01), and 03-03 `guide-harness` (auto-triggered by 03-02's startup checks). **L1 is code-complete; the radio-feel human acceptance (by ear) is the open gate.** See §10 for the build-order map.
> **Role of this document**: This is the **master spec** — a living document that captures *what we are building* and *the rationale/trade-offs behind every decision*. It is the umbrella that sub-specs branch off from. It is **not** a directly-codeable implementation spec.
> **Altitude rule**: This document stays at the architecture / layering / feature-set level. Concrete implementation (library usage, data structures, prompt copy, etc.) is deferred to the individual sub-specs.
> **Conventions**: All specs are written in **English**; design conversations happen in Chinese. **Every spec's primary reader is a coding agent, not a human** — optimize for unambiguous machine consumption.
> **Drafted**: 2026-06, from multiple rounds of brainstorming. (The earlier `companion-radio-notes.md` has been fully folded into this document.)

---

## 0. How this spec is organized

murmur's design is captured as **one master spec + several sub-specs**.

- **Master spec = this file (`DESIGN.md`).** It holds the vision, the locked architectural decisions and their rationale, the cross-cutting concerns, and the scope. It is **stable and high-altitude** — it answers *what* and *why*, never *how-to-code*. It is a living doc: as decisions are made, we update it here rather than forking a new "big spec."
- **Sub-specs (one per part).** Each part of v1 (see §8) gets its own spec that goes one level deeper — into the part's contract, internal design, dependencies, and acceptance criteria. Each sub-spec references this master and then goes through its own design → plan → implementation cycle.

**Sub-spec template** (each sub-spec should contain):
1. **Title / status / part covered / link to master**
2. **Goal & scope** — what this part delivers, and what it explicitly does *not*
3. **Contract / seam** — the interface it exposes to other parts (inputs/outputs), so parts stay decoupled
4. **Design** — the part's internal design at the design level (mechanism, not final code)
5. **Dependencies** — which other parts/specs it relies on
6. **Acceptance criteria** — what "done" means for this part
7. **Open questions**

**Conventions**
- **AI-friendly first**: every spec's primary reader is a **coding agent, not a human**. Write for unambiguous machine consumption — explicit contracts (interfaces, I/O, types, paths, exact symbol/command names), a single canonical source of truth per fact, explicit scope **and non-goals**, and verifiable acceptance criteria. Keep rationale only where it constrains an implementation decision; drop motivational prose.
- English for all spec documents; Chinese for live discussion.
- **All prompt text is centralized** under `src/prompts/` — one module per Brain task (`talk`, `reply`, `music`, `rwt`, `cadence`, `setup`, `profile`, `persona`, `status`, `report`) plus file assets such as the persona seed — and written in **English** (v1). The radio's *output* language is set inside the **persona**, which names it explicitly — so English prompt scaffolding still yields a radio speaking whatever the listener settled on. **No language is hardcoded**: the bundled seed carries a `{{language}}` slot filled at load, defaulting to the machine's locale and to English when that says nothing (spec 06 §3.2). No prompt strings scattered through application modules.
- **No Chinese (CJK) anywhere in source** — comments, string literals, and docstrings alike (v1). Whatever language the radio speaks is produced by the model at runtime from the persona; it is never a hardcoded string. Additionally, **comments are English-only** — ASCII plus a short allowlist of typographic symbols (dashes, ellipsis, curly quotes, `§`, `→`, the `①②③` memory-tier marks). Enforced by `scripts/check-source-language.ts` (wired via pre-commit; dependency-free, run straight off disk by node).
- Master spec stays high-altitude; sub-specs may go deeper but remain design-level, not code.
- This master lives at `specs/DESIGN.md`. Each sub-spec gets its own directory `specs/specNN/` (ordered by build sequence), holding that part's doc(s) — e.g. `specs/spec01/01-core-loop.md`, `specs/spec02/02-voice-provider.md`. A multi-part spec keeps its sub-parts together in one directory (e.g. `specs/spec03/03-01-brain-harness.md` + `specs/spec03/03-02-ducking.md`).
- Cross-reference with relative links; mark status on every doc.

> **Master status**: the v1 **minimal playable loop** (§9) and the **decomposition + sub-spec map + build order** (§10) are now defined. This master is "complete enough" to spawn sub-specs under `specs/` per the build order.

---

## 1. What this is (Vision)

A **local-first companion radio** — "a radio that broadcasts for an audience of one," with Claude as its brain.

> **Product framing**: murmur is an **open-source (MIT) product** distributed to users. "Audience of one" is the *experience* — each user runs their own private radio — **not** a personal one-off; the earlier "personal use" framing is retired. murmur **ships no model** (§3.7): the listener brings their own brain session and voice endpoint, so each model's license is theirs, not something murmur redistributes.

It is **always on the air**: it finds a topic and chats with me on its own, plays a song, comes back and keeps going; at the right times it says good morning / good night. It is **broadcasting, never soliciting** — it keeps going whether or not I say anything, and when I type, we chat for a bit before it eases back into the program. (Amended 2026-08-07, §2.2: the earlier "occasionally turns to me and asks" degree is retired — a radio does not solicit interaction.) It has a **persona seeded by a few questions up front** and it **keeps learning me** as it keeps me company, so it fits me better over time. (Amended 2026-07-29, §2.3: the *host's character* stays stable — what grows is what it knows about me and how we get on.) I talk to it with the **keyboard**; it answers with a **voice that sounds human**.

**Differentiation**: existing tools are either "voice-control Claude Code to write code" or message-driven assistants. **Nobody occupies the "local + proactive + emotional companionship + voice radio" combination.** That gap is murmur.

---

## 2. Core experience (the product's character)

Three things together define its character; none is optional:

### 2.1 A continuous radio stream (the soul)
It is not a "you ask, I answer" assistant — it is a **program stream that never goes silent**. There is always a "what plays next" decision in motion:
- 🎙️ **Autonomous talk segments (most important)**: it **spontaneously** picks a topic and starts talking — not driven by a timer, an event, or a finished script. This is the soul, and what separates murmur from every "trigger-based assistant."
- 🎵 **Music segments**: it talks, drops a song, comes back. Talk and music alternate — that's what makes it feel like radio.
- ⏰ **Time-anchor segments**: good-morning / midday / good-night — "fixed programming" that must hit on schedule, layered on top of the stream.

### 2.2 Hybrid proactive/passive (interaction model = C)

> **Amended 2026-08-07 — the "turn to you" degree is retired** (spec 07 status
> note): murmur is a radio, and a radio does not solicit interaction. It never
> turns to the listener to ask something; there is no invite and no slide-back.
> Broadcasting stays proactive (talk, music, anchors); **interaction is
> listener-initiated** — typing to the radio is the model, and a typed line
> still gets the chat-for-a-bit reply below.

- **Mostly broadcasting**: it talks at you like real radio and **does not require a reply** — if you say nothing, it keeps going. Companionship is "that voice in the background," pressure-free.
- ~~**Occasionally turns to you**: at the right moment it turns and asks you something.~~ *(retired 2026-08-07)*
- **If you engage, you chat for a bit** — you type, it replies in persona and eases back into the program.

### 2.3 A persona that grows
The persona is **not a hard-coded constant — it is an evolving, living asset**:
- **Cold-start seeding**: on first use it asks a few basic questions → generates a first persona (essentially a System Prompt).
- **Continuous evolution**: while keeping you company it keeps observing you → gradually rewrites the persona to fit you better.
- **(Committed, deferred to a later sub-spec) permissioned data bootstrap**: with your consent, feed it how you talk with Claude Code and the things you say → it analyzes and infers "who you are and what persona would best keep you company," so cold-start lands in one step instead of grinding up from zero.
- **A single evolving persona**, not "preset channels you switch between." (Multi-channel / multi-mode is out of v1.)

> **Important layering distinction**: "what personality / tone the host has" is a **detail** — it lives in the System Prompt, maintained in natural language. The **only high-level matter** about persona is the fact that *it is alive and self-customizing* — and that is already decided.

> **Amended (2026-07-29, persona direction) — the persona does NOT auto-evolve; what grows is the *profile*.** This **supersedes** the "continuous evolution → gradually rewrites the persona" bullet and the persona half of the "permissioned data bootstrap" bullet above (both kept for history). Decision:
> - **The persona file is a stable, user-editable asset.** It is seeded once (first run, spec 06 slice A) and afterwards written only by the user, in an editor. Nothing in murmur machine-rewrites it; spec 01's static persona load is unchanged, and spec 05 §3.2 keeps `persona.md` as its writable home (a home for the *user's* edits, not for a rewrite loop).
> - **"It grows with you" is delivered by the profile tier** (memory tier ①, §6). Spec 05's periodic compaction *already* implements the observe→rewrite loop over the **listener picture**; spec 06 slice C extends that same prompt with a "relationship & style" section. No second evolution machine is built.
> - *Rationale*: LLM rewrite loops mean-revert. Dozens of compactions would blur a distinctive host into a generic assistant voice, and there is **no user-visible checkpoint** in an automatic loop that would catch the drift before it is the character. A radio host's charm is a **stable character**; what adapts is the *content* it talks about and the *relationship* it has with the listener.
> - **Optional future path (not v1)**: a **user-invoked** persona edit — the brain proposes a diff, the user approves it (the guide-style consent posture of spec 03-03) — never silent drift.
> - **Consequence**: the permissioned Claude-Code bootstrap produces a **profile**, not a persona (spec 06 slice B); persona *inference* from CC history is cut, and spec 09 is retired (§10).

---

## 3. Locked foundations (decisions + rationale)

Each item records the **why**, to avoid re-litigating later.

### 3.1 Positioning & privacy boundary
- **Local-first, open-source (MIT)** — distributed to users; every instance runs on the user's own machine (not a hosted service, not a personal one-off).
- **The network hops, and only these**: ① Claude brain inference; ② the voice endpoint; ③ the music stream — plus, only where a feature asks for it, a listening catalogue, a package registry on a packaged first boot, a voice preset's clip, and the `/update` version check (README's *Third-party services* is the full list). All other logic, I/O, and memory stay on-device — a core product value, not merely a personal constraint.
- *Rationale*: local-first + open-source is the product's identity. Model **licensing** is not murmur's to carry (§3.7): murmur redistributes no model, so a model's terms bind the listener who reaches it, not murmur's source. (This retires both the old "personal use unlocks non-commercial models" shortcut and the two-phase deferral that replaced it.)

### 3.2 Brain & authentication
- Brain = **Claude Opus**, via `claude-agent-sdk`, **reusing the local Claude Code subscription OAuth credentials** — **no API key needed**.
- *Rationale*: this auth chain is already verified in the `~/.personal/ai-investment` project — with no `ANTHROPIC_API_KEY` in the environment, the SDK falls back to the local `claude /login` subscription credentials and bills the subscription directly. For headless contexts, `claude setup-token` can mint a one-year token.
- **Phase note (§3.7)**: subscription-OAuth is the **current local-experimentation** substitute. A distributed build swaps to a paid API / user-provided key (or another provider); the brain stays behind the same `Brain` seam, so the swap is an adapter/config change, not a rewrite.
- **The brain is a *harnessed agent*, not a one-shot LLM call.** murmur treats the brain as a complete, tool- and skill-using agent that murmur *shapes with its own harness* — it may call murmur-owned tools/skills and take real actions (search music, analyze a file the user hands it, update memory), and the user can steer its behavior by talking to it. Two invariants bound this:
  - **Isolation ≠ crippling.** The brain is fully isolated from the *user's local Claude Code environment* (no inherited `CLAUDE.md`, skills, MCP servers, hooks — see spec 01 §3.2), but it is given **murmur's own** tools/skills. Isolation sandboxes the *environment*; it does not forbid tool use.
  - **Bounded surface + off the live loop.** "Complete" means complete *within the tool/permission surface murmur's harness defines* — never an unrestricted shell on the user's machine. Any heavy, multi-step agentic task runs as a **background job off the live radio loop** (the stream never goes silent while the agent works); its results feed Memory/persona.
  - The tool/skill **harness seam is introduced in spec 03-01** (music search & recommendation is its first capability); later specs (05/06/07) hang more capabilities on the same seam. Fast, latency-critical calls like `next_talk` stay tool-less **by choice** — a harness *configuration*, not a separate "crippled" brain.

### 3.3 Language / runtime: TypeScript on Node
- The engine is **TypeScript on Node (≥24, native type-stripping)**, on
  `@anthropic-ai/claude-agent-sdk` (issue #54; the original Python
  implementation served as the rewrite's behavior oracle and is deleted).
- *Rationale (weighed, not a default)*:
  - **The brain harness is the heart of the product**, and the TS Agent SDK is
    its first-class surface; every capability (talk, music discovery, the
    repair guide, compaction) hangs off that seam.
  - **The old hard constraint dissolved**: local neural TTS (all
    Python/PyTorch/MLX) forced Python while it was in scope. Local TTS is
    **deferred** (v1 voice is a hosted endpoint over HTTP — spec 02 §3.6), so
    the orchestrator language is genuinely free.
  - Audio mixing is a Web Audio graph on `node-web-audio-api` (gain-envelope
    automation as the mixer; `OfflineAudioContext` renders as the deterministic
    unit layer) — no numpy needed.
  - If local TTS returns, it runs as a **sidecar process over language-neutral
    IPC** (the boundary spec 02 originally built), so it never re-forces the
    engine language.

### 3.4 Input: keyboard only; no ASR this round
- v1 user input is via **keyboard**.
- *Rationale*: ASR (Whisper et al.) is a mature, solved problem and not this project's value-add; defer it to focus on the genuinely hard part — making the AI *sound human*.

### 3.5 Output / TTS: hot-swappable, human-ness is the soul
- *Status (issue #54)*: **local TTS is deferred** — the running v1 voice is the hosted fish-speech endpoint (spec 02 §3.6). The local-model design below (candidate pool, warm sidecar) is kept as the deferred plan, not current code.
- **`VoiceProvider` abstraction**: TTS is a hot-swappable backend, not hard-coded. Each model is its own adapter, switchable by one config line; you can even **mount different models per scenario** (a fast one for live replies, a warm/rich one for proactive broadcasts).
- **Candidate pool** (decide the primary after a blind A/B): Qwen3-TTS, CosyVoice2, Chatterbox Multilingual V3, OpenAudio S1-mini. *(spec 02 wires the MLX-runnable experiment shortlist — **Spark** [primary], Qwen3-TTS, Chatterbox, Dia, and VoxCPM2 — as local experiment-phase voices per §3.7.)*
- **TTS runs as an always-on warm sidecar process.** *Rationale*: models load slowly (seconds, several GB), so keep them warm rather than loading on every utterance; crash isolation — a TTS crash must not take down the radio brain; cross-process is also the cleanest seam for hot-swapping.
- *Selection notes (from mid-2026 research)*:
  - **Licensing does not filter the pool (§3.7)**: murmur ships no weights, so a non-commercially-licensed model (Spark/CosyVoice2/Fish/IndexTTS2, etc.) is a legitimate default as well as an experiment — what it obliges is disclosure, so the listener knows whose terms they are under (README's *Third-party services*).
  - On Mac the real trade-off is just "can it run in real time": MLX/Metal-accelerated models (e.g. Qwen3-TTS) can; CosyVoice2/GPT-SoVITS et al. are mostly CPU-bound and slow on Mac → better for **pre-generation** than millisecond-latency.
  - Since v1 input is keyboard and proactive broadcasts can be pre-generated in the background, "slow on Mac" matters little for broadcast → the most emotionally rich models remain usable.
  - **The human-ness / warmth of the voice is the soul of this product.** The primary model is ultimately decided by ear, via blind listening.
- *Paid cloud backlog (for a future quality upgrade)*: most emotional — Hume Octave; best Chinese — Doubao/Volcengine, MiniMax; cheapest — OpenAI gpt-4o-mini-tts; lowest latency — Cartesia; ceiling but pricey — ElevenLabs; plus Fish Audio cloud.

### 3.6 Interaction form: an always-on async engine; plain CLI host in-process, TUI out-of-process
- **The core loop (specs 01/02/03, L0→L1)** is one always-on Node process (`murmur`), launched in a terminal; one loop drives "speaking up," a readline reader owns keyboard input, both feed into the brain. With the **plain CLI host**, proactive broadcasts and your typing share the same terminal, **in-process** — no split. The plain host stays in-process (it is also the headless / test path).
- *Rationale*: CLI is the lightest, fastest path to an MVP, with no GUI overhead. **There is no GUI, no menu-bar, and no web surface — not in v1, and not planned.** The only richer front-end murmur ever gets is a **TUI** (terminal UI).
- **Amended (2026-07, TUI direction) — the TUI front-end is a *separate process*, not in-place.** This **supersedes** the earlier "the TUI upgrades the in-terminal host surface *in place*, no new process, no IPC." Decision: the richer front-end is a **standalone TUI process** that attaches to a **headless murmur engine** over a **language-neutral IPC** — the same *class* of boundary a TTS sidecar would use (§3.3). The engine stays in its language; **only the plain host is in-process**. This is still a terminal UI — **never a GUI/menu-bar/web**.
  - **Re-decided (2026-07-29, spec 10 §3.1 — supersedes the Go / Charm pick)**: the TUI front-end is **OpenTUI (TypeScript, Zig-core renderer) running under Bun**, after a four-report research pass with **visual delight promoted to a first-tier requirement** (user-set bar: the TUI is the product's face). Why the reversal: OpenTUI has the highest delight ceiling of the four candidate stacks (sprites/particles/timelines/3D-to-cells as stock parts) while keeping the whole repo TypeScript; opencode ran the exact "TS engine + Go Bubble Tea client" split and abandoned it to unify on TS; and Bubble Tea v2's breaking change (2026-02) expired the "AI-friendly corpus" premise behind the original pick. **Bun is a provisioned binary for the one leaf process** (per §10.1's binary rule, like `ffmpeg`), not a stack migration — the engine stays Node. Risks (pre-1.0 pin, a week-1 CJK/IME hard gate, cell-art-only sprites) and the Ratatui/Ink fallbacks are recorded in spec 10 §3.1. **Resolved with it**: the IPC is a **unix-socket ndjson protocol with zod schemas shared in-repo** (spec 10 §2.3); "two processes over IPC" stays locked — the boundary now earns its keep via crash isolation and detach/reattach, not language necessity.
  - **Consequence to reconcile**: a separate always-on engine + an attach/detach TUI **subsumes much of the deferred daemon/detach model** (§10.1, "the radio keeps broadcasting after the terminal closes; a client re-attaches"). spec 10 must reconcile the two rather than treat them as independent.
  - See the TUI sub-spec (§10, `specs/spec10/10-tui.md`).

### 3.7 Model strategy: murmur ships no model
- **The listener brings the models.** The brain is the listener's own Claude session (§3.2); the voice is an endpoint they point murmur at (§3.5); music is fetched by `yt-dlp` on their machine (§3.6). murmur's tarball carries no weights and no model code — only the client that speaks to them.
- *Consequence for murmur's own license*: the code is **MIT**. What murmur distributes embodies no model materials, so no model's license reaches murmur's source. What that does **not** settle is what binds a listener at the far end of an endpoint — the model's own license, the operator's service terms, or both — and murmur is not the party to that agreement or the one to characterise it. Conflating the two questions is what produced the earlier "non-commercial" framing, and it bought no protection while costing the distribution surface an OSI license buys.
- *Consequence for model selection*: licensing is not a selection filter for murmur. The duty it does create is **disclosure** — every hop the default stack makes is named in README's *Third-party services*, pointing at the terms rather than summarising them, so the listener can read what applies to them. Every model sits behind a seam (`Brain`, `VoiceProvider`) so each swap is an adapter/config change, not a rewrite.

---

## 4. Architecture & layers

```
┌─────────────────────────── murmur (single Node process) ────────────────────────────────┐
│                                                                                          │
│   you type ─► CLI Host ─────────┐                          ┌──► VoiceProvider (TTS)      │
│            (render + read keys) │                          │     warm sidecar · pluggable │
│                                 ▼                          │     Qwen3/CosyVoice2/...     │
│   ActivitySensor ──┐      ┌──────────────┐  text / segment │                              │
│   (your active hrs) ├────►│   Program    │ ───────────────┤                              │
│   Scheduler ───────┘      │   Director   │                │                              │
│   (morning/night)         │              │ ◄── Brain ─────┘   ┌──► MusicProvider          │
│                           └──────────────┘  (Claude SDK,     │     pluggable · v1=yt-dlp   │
│                                  │           topics/replies)  │    (YouTube+Bilibili)      │
│                                  ▼                           │                            │
│                            AudioPlayer ─────────────────────┴──► speakers                 │
│                          (sole audio authority · duck/stop)                               │
│                                  ▲                                                        │
│                              Memory (who you are · what we've discussed · no repeats /     │
│                                      the persona living asset)                            │
└──────────────────────────────────────────────────────────────────────────────────────┘
       Network hops: Claude inference + voice endpoint + music stream (see §3.1)
```

| Component | Responsibility | Notes |
|---|---|---|
| **CLI Host** | Render "now playing" + read keyboard input | proactive + typing share the terminal |
| **Program Director** | The soul: continuously decide "what plays next" (autonomous talk / music / time-anchor), modulate talk density by activity + time-of-day | mostly local policy — not every decision calls Claude |
| **Brain** | Claude SDK session: ① generate talk-segment scripts / pick topics ② respond when you type. Persona + memory injected | see token economy |
| **VoiceProvider** | text → speech, hot-swappable TTS (v1 = hosted endpoint), splittable fast/rich by scenario | candidate pool in 3.5 |
| **MusicProvider** | topic/query → audio stream, hot-swappable | v1 = yt-dlp |
| **AudioPlayer** | sole audio authority: sequence TTS + music, duck/stop on interrupt | only one thing "on air" at a time |
| **Memory** | who you are, topics discussed, segments/songs played (anti-repeat), conversation log; **the persona file also lives here** (its writable home; user-edited, §2.3 amended) | see §6 |
| **ActivitySensor** | observe whether you are around (v1: **keyboard idle time**, plus the clock) → feed the Director's pacing and gate generation | spec 07; local signal only — mining Claude Code logs for activity was considered and cut (§10 row 09) |
| **Scheduler** | time anchors (morning/night) → inject "moment" segments | |

> **Structure vs content**: the architecture layer only cares about "what *structural* kinds of segment exist" (talk vs music vs time-anchor — different machinery). "What topics it talks about, in what tone" is content — maintained via System Prompt / natural language, **not architecture**.

### Concurrency model: single loop + 1-segment look-ahead (no dead air)
A radio's iron law is **no dead air**. TTS generation takes seconds; "decide the next segment only after the current one finishes" would stutter and kill the radio feel.
- **Chosen approach**: a single asyncio process where, **while the current segment plays, the Director has already prepared the next segment's audio** (TTS pre-generated / next track pre-resolved), so it joins seamlessly. On interrupt: cancel the current + buffered segment, the Brain replies immediately, then the program resumes.
- *Why not the alternatives*: "decide after finishing" causes dead air; "multi-process producer/consumer" is over-engineering for a personal MVP. "1-segment look-ahead" is the minimum cost to feel like radio without introducing multi-process complexity.

---

## 5. Music sources

- **Abstraction**: hot-swappable `MusicProvider`; every music source is an adapter under it.
- **v1 primary = yt-dlp**: covers **YouTube + Bilibili** (and 1000+ other sites), **no login, no account, no membership**. Claude can also search for a song by topic on the fly.
- **Backlog adapters and their barriers** (all discussed; recorded so we don't revisit):
  - **Apple Music**: official, the Music app ships with macOS (controllable via AppleScript), most native; but on-demand full playback needs an Apple Music subscription.
  - **NetEase Cloud Music (Wangyiyun)**: best Chinese catalog; but only unofficial APIs (pyncm, etc.), **requires login cookie**, VIP tracks need VIP.
  - **Spotify**: **no clean "no-app-and-no-membership" path** — either bind to the desktop app (AppleScript, with ads / on-demand limits) or run librespot headless (**needs Premium**). **User currently has no Premium** → not in v1.
- *Why yt-dlp for v1*: across "official × free × on-demand full tracks," an "official + free + full track" option basically does not exist; yt-dlp is the **lowest-barrier, most self-contained** starting point, and Bilibili covers Chinese music. The cost is the ToS gray area — if it breaks, swap the adapter without touching the core.
- **Optional, user-installed gray providers (personal-experiment tier, §3.7 phase-1 — never a shipped default).** Behind the same `MusicProvider` seam a user may mount unofficial sources on their own machine, accepting the fragility/ToS risk: e.g. [`musicdl`](https://github.com/CharlesPikachu/musicdl) (a 50+-platform downloader — but it bundles a Node runtime and does **Widevine DRM circumvention**, a legal non-starter to *ship*), unofficial NetEase APIs (login-cookie + VIP), or Spotify via librespot (needs Premium). These are **not** in the shippable stack; they are opt-in providers a user installs and self-provisions. Because the ducking engine (spec 03-02) is **source-agnostic**, any of them works once it yields decodable audio.
  - **Auth reference — [`cliamp`](https://github.com/bjarneo/cliamp)** (Go/Bubble Tea terminal player): already implements the **login/auth flow** for exactly these auth-gated sources (NetEase Cloud Music, YouTube/YouTube Music, SoundCloud, Bilibili, Spotify, plus Navidrome/Plex/Jellyfin) via an interactive credential wizard. When an auth-requiring `MusicProvider` adapter is eventually built, reference **cliamp's auth mechanics** — how it obtains, stores, and refreshes per-service credentials/cookies. **Scope of the borrow**: we take the *auth flow only*, **not** its interaction model — cliamp is user-picks-and-logs-in (a player), whereas murmur is **AI-picks-by-context** (the brain selects the track; the user is a listener, not a selector). The credential/cookie plumbing is reusable; the song-selection UX is not.

---

## 6. Memory layer (three tiers, MVP-trimmed)

| Tier | Stores | How it's used |
|---|---|---|
| **① Profile (long-term)** | who you are, preferences, recent context, favorite topics, **the persona file** (its writable home; §2.3 amended — user-edited, never machine-rewritten) | injected every prompt; the core of "it gets me". **The profile is the tier that evolves** (compaction, spec 05 §3.6; relationship & style section, spec 06 slice C) |
| **② History (mid-term)** | conversation log (your input + what it broadcast), recent window | take the last N for continuity |
| **③ Ledger (anti-repeat)** | topics covered, songs played, broadcast times | checked at segment selection for de-dup and callbacks |

- **Recall and forgetting are v1.5** ([`spec05/05-01-recall-and-forgetting.md`](spec05/05-01-recall-and-forgetting.md)): keyword recall over history (a derived FTS5 index, no embeddings), dated profile facts that fade, a listener-only compaction input, and forget-on-request. The MVP got ~80% of the "it gets me" feel from "profile + recent window + ledger"; v1.5 makes it hold up over weeks.
- Writes: append history and record the ledger after each segment / each input; the profile is updated via **periodic compaction** so it doesn't grow unbounded.
- Each Brain call gets a compact **context pack**: `persona + profile + recent window + recently covered topics + current time/activity`. (Anti-repeat spans sessions/days, not just "today" — a midnight reset would re-surface the same openers on a cold boot; see spec 05 §2.2 and issue #44.)

### 6.1 Local storage layout (one home)

Everything murmur keeps lives under **one home**: `~/.murmur` by default,
relocatable with `$MURMUR_HOME`. Chosen over a strict XDG split (`~/.cache` +
`~/.local/share`) because this is a single-user local companion — "one visible
home, one directory to back up or take with you" beats XDG orthodoxy, and
`$MURMUR_HOME` keeps the relocation escape hatch. Split by **what happens if you
delete it**:

| Under `~/.murmur/` | Holds | If deleted |
|---|---|---|
| `data/` | the Memory tiers (§6), incl. the user's persona file | **irreplaceable** — loses user state; this is the thing to back up |
| `cache/` | the background-music `bed/` | **rebuildable** — costs a re-pull |

- **`paths.py` is the single module allowed to resolve these locations** — no
  other module hardcodes a home-derived path (a pre-commit gate enforces it), so
  the layout has exactly one source of truth. Sub-spec 05 §2.3 owns the detail.
- **Ephemeral TTS clips** are throwaway and live in the **system tmp**, cleaned
  by their creator — not part of this home. Model weights sit in their own
  third-party cache (`~/.cache/huggingface`). Repo-relative `.dev/` / `scratch/`
  are dev-loop tooling, not app storage.

---

## 7. Token economy (the radio talks nonstop; without care it burns the subscription)

Three pillars + helpers:
| # | Strategy | Saves where | v1? | Status / home (2026-07-29) |
|---|---|---|---|---|
| 1 | **Don't call Claude for everything** | "talk vs music," "which anchor" are the Director's local policy, 0 tokens *(default; spec 03-02's opt-in `brain` cadence mode is the one sanctioned exception — the user explicitly trades a cheap one-shot call per segment boundary for feel)* | ✅ | **Landed** — the `CadencePolicy` seam (spec 03-02 §2.3); `every_n` / `random` are pure local policy |
| 2 | **Batch generation (most important)** | one call generates the next N segments' scripts (a monologue split into beats), doled out between songs → one call covers minutes of radio | ✅ | **Landed** — spec 04 §3.2/§3.3 talk look-ahead (batching pulled forward as the latency vehicle) |
| 3 | **Tiered models** | Haiku for idle filler, Opus only when you genuinely engage | ✅ | **A config knob, not a spec** — `musicModel` / `compactModel` already select the cheap tier; widening it is a config change |
| 4 | **Cache the stable prefix** | `persona + profile` goes through prompt caching → near-free on repeated calls; send only history deltas | ✅ | **SDK-level, essentially free** — the pack ordering is already cache-friendly (spec 05 §3.5); remaining work is config/verification, not a build |
| 5 | **Activity-gated generation** | when you're away → go quiet (more music / pause talk generation), don't burn tokens on an empty room | ✅ | **Moved into spec 07** — it is a pacing policy, and it needs 07's ActivitySensor to have a signal at all |
| 6 | **Local templated filler** | time announcements, "up next, from…", fixed greetings → local templates, no LLM | ✅ | **Unowned / partly moot** — the DJ "up next" line is written by the pick task itself at zero extra calls (spec 03-02 §1); time-anchor copy is spec 07's to decide (template vs brain) |
| 7 | **Budget + graceful degradation** | near the cap, fall back to "music + templates" | △ later | **Deferred (backlog)** — no spec owns it; open it only if real usage shows the subscription burning |

Core: pillars 2 (batch) + 5 (activity-gating) + 4 (caching) turn "always on the air" from "always burning" into "generate once, play slowly, rest when nobody's listening."

> **Amended (2026-07-29) — spec 08 `token-economy` is dissolved; §7 stays the rationale home.** The economy never needed a spec of its own: each pillar is either already landed, a config knob, or a policy that belongs to the spec that owns the behavior. Dispositions are the status column above (batch → landed in 04; caching → SDK-level; tiering → config; activity-gating → spec 07; budget/degradation → backlog). See §10 for the build-order row.

---

## 8. Scope

### In v1 (WHAT)
- Claude brain (subscription auth) · always-on CLI (keyboard in / voice out)
- Continuous radio stream (autonomous talk + music + time anchors) · hybrid proactive/passive (model C)
- Hot-swappable TTS (human-ness first) · yt-dlp music (YouTube+Bilibili)
- A persona seeded on first run (stable, user-editable) + a listener profile that grows (§2.3 amended)
- Memory three tiers + token-economy three pillars

### Committed to v1 but split into later sub-specs / steps
- **Permissioned ingestion of Claude Code data** → bootstrap the **profile** (spec 06 slice B; *not* a standalone spec any more — persona inference and CC-derived activity signals are cut, §10 row 09)
- Concrete activity-pacing mechanism · the "degree" of proactive/passive · blind A/B to pick the primary TTS (→ eval track, §10.3) · semantic memory recall

### Explicitly not in v1
- ASR (keyboard instead) · **GUI / menu-bar / web surface** (if any UI is ever added it is a **TUI** — §10, `specs/spec10/10-tui.md` — never a GUI/menu-bar/web) · Spotify / Apple Music / NetEase · multi-channel / multi-mode switching

> **Delivery**: v1 is not one shot — it is **split into multiple sub-specs / steps**. This document is the umbrella for them.

---

## 9. v1 Minimal Playable Loop (L0)

The **minimal playable loop** is the smallest end-to-end slice that delivers the core aha and is genuinely worth turning on — not all of v1. murmur's aha is: **a warm voice that speaks up and keeps you company on its own, which you can reply to by typing and have it flow on.** Music is additive; the irreducible magic is "autonomous voice + you can talk back."

**Decision: the first playable loop is talk-only (L0). Music is the immediate next step (L1), not part of L0.**

### 9.1 The spine (cannot be cut)
1. **Static persona** — a hand-written System Prompt seed, loaded at startup.
2. **Autonomous talk loop** — loop { Brain generates a short talk segment → one TTS voice speaks it }, so it keeps speaking up on its own.
3. **Typed talk-back** — at any time you type a line; it responds, then flows back into the program.

### 9.2 L0 decisions (chosen for fastest path to a working loop)
| Aspect | L0 choice | Rationale |
|---|---|---|
| Persona | hand-written **static** System Prompt seed | first-run onboarding Q&A is its own sub-spec (06); L0 does not touch it |
| Voice | wire **Qwen3-TTS first** (from the candidate pool) | it is the only **real-time-on-Mac** option, so the loop feels live; the `VoiceProvider` seam stays open for hot-swapping the rest |
| Memory | **session-only** in-process history (coherence within one run) | cross-session persistence deferred to sub-spec 05 |
| Dead air | **accept small gaps**, no look-ahead | look-ahead is polish (sub-spec 04); get the loop running first |
| Token economy | minimal: **one segment per call + natural pause between segments + manual stop** | the fuller economy is deferred past L0 (batch landed in 04; the rest per the §7 status column, spec 08 dissolved); but because it talks nonstop, L0 still needs a cadence + an easy stop so testing does not drain the subscription |
| Process | **foreground single process**, closing the terminal stops it | the daemon/detach option is a non-blocking later side-spec (see §10) |

### 9.3 L0 acceptance criteria (feature level — "done")
1. Launching `murmur` makes it **start speaking in a real voice on its own**, without the user speaking first.
2. Segments come one after another with **natural pacing** (neither a firehose nor awkward long dead air).
3. The user types a line → it **catches it, responds, and flows back** into the program.
4. The user can **stop it cleanly**.

### 9.4 Explicitly deferred out of L0
Music (→ L1 / specs 03-01 & 03-02), no-dead-air look-ahead (04), persistent memory (05), first-run onboarding + relationship (06), proactive "turn to you" + time anchors + activity pacing + activity-gated generation (07). *(The former 08 token-economy and 09 CC-ingestion specs are dissolved/retired — §7 and §10.)*

---

## 10. Decomposition, build order & sub-spec map

v1 ships as **a sequence of sub-specs**, ordered so that **every step runs and adds something audible**. L0 = specs 01+02; L1 (radio feel) = +03-01+03-02. (**✅** in the table = implemented & verified; see that sub-spec's own status block for detail.)

| # | sub-spec (`specs/specNN/…`) | Part it delivers | Milestone | Depends on |
|---|---|---|---|---|
| **01 ✅** | `core-loop` | Single-process spine: CLI Host + Program Director (talk-only policy) + Brain (Claude SDK, subscription auth) + static persona load + typed talk-back + session-only history + AudioPlayer (basic, sole audio authority, manual stop) + segment cadence. **Declares the outbound interface contracts** (VoiceProvider / MusicProvider / Memory seams). | **L0** | — |
| **02 ✅** | `voice-provider` | VoiceProvider interface impl + warm TTS sidecar + adapters (Spark primary; Qwen3/Chatterbox/Dia + post-L0 VoxCPM2 candidate). Code implemented; the real-voice "sounds human" / blind-A/B is a hands-on acceptance gate. | **L0** (01+02 = audible) | 01 |
| **03-01 ✅** | `brain-harness` | The general **brain-harness** seam — turn the isolated brain into a tool/skill-using agent (§3.2), preserving local-env isolation, with a fast content-agnostic context-insertion mechanism. **First capability: Claude-driven music discovery** — the harnessed brain searches, judges, and **pulls** a track (`MusicProvider` impl; yt-dlp default, musicdl optional), returning an `AudioClip`. **Find + pull only — no playback/scheduling/announce** (those are 03-02). | **L1** (radio feel) | 01 |
| **03-02 ✅** | `ducking` | Source-agnostic mixing audio **engine** (replaces the afplay `AudioPlayer`): ffmpeg→PCM + numpy mix + gain-envelope **ducking**; a typed interjection **ducks** music instead of hard-stopping it. **Owns music playback + Director talk↔music scheduling + optional DJ "up next" announce** — the tracks 03-01 pulls are scheduled and played here. | **L1** (radio feel) | 01, 03-01 |
| **03-03 ✅** | `guide-harness` | A second capability on the harness (03-01): shape the **native Claude Code agent** (built-in tools, step-by-step `default` confirmation — never `bypassPermissions`) to diagnose and, with user consent, **fix why the music dependency (yt-dlp) isn't working in the user's environment** (e.g. a corporate proxy's untrusted CA). Deterministic preflight triggers it; confirmations flow through the CLI Host (no TUI). Makes 03's music **actually usable** on constrained machines. | **L1** (music works everywhere) | 01, 03-01 |
| **04 🔨** | `no-dead-air` | 1-segment look-ahead / pre-generation buffer to remove inter-segment gaps. **Pulled forward** (ahead of order) for first-cold-start latency: slice 1 = music-pick prefetch; slice 2 = batched talk look-ahead (borrows 08's batch pillar as the vehicle). | polish | 01,02,03-01,03-02 |
| **05** | `memory` | Persistent three tiers (profile/history/ledger) + context-pack assembly + periodic compaction. | cross-session "gets me" | 01 |
| **06** *(rescoped 2026-07-29)* | `first-run & relationship` ([`specs/spec06/06-first-run.md`](spec06/06-first-run.md)) | Three slices, no new machinery loops: **A** first-run onboarding (no persona file → the host asks ~3 seed questions → the brain writes the persona seed to disk); **B** optional, explicitly-consented one-shot Claude-Code-history **profile** bootstrap on the 03-01 harness seam (absorbed from the retired 09); **C** a "relationship & style" section maintained by the existing spec-05 compaction prompt. **Was** `persona-lifecycle` (onboarding + persona evolution loop) — the evolution loop is **cut** per §2.3 (amended): the persona is stable and user-editable; the profile is what grows. | first run + relationship | 05 |
| **07** | `proactive-and-pacing` ([`specs/spec07/07-proactive-pacing.md`](spec07/07-proactive-pacing.md)) | Model-C "turn to you / slide back" degree + time anchors (Scheduler) + activity-aware pacing (ActivitySensor, keyboard-idle) + **activity-gated generation** (absorbed 2026-07-29 from the dissolved 08 pillar 5 — it is a pacing policy, §7). | companion character | 01,05 |
| **~~08~~** | ~~`token-economy`~~ — **dissolved 2026-07-29, no longer a spec** | Per-pillar disposition (§7 status column): batch generation → **landed** (spec 04); prompt caching → **SDK-level**, config/verification only; tiered models → **a config knob** (`musicModel`/`compactModel`); activity-gated generation → **spec 07**; budget + graceful degradation → **deferred backlog**. §7 remains the rationale home. | — | — |
| **~~09~~** | ~~`claude-code-ingestion`~~ — **retired 2026-07-29 as a standalone spec** (row kept: it records why, so it is not re-litigated) | CC → **profile** bootstrap moved into **spec 06 slice B**. CC → **persona** inference **cut** (the persona is user-seeded and stable, §2.3 amended). CC → **activity signals** for 07 **cut**: local keyboard-idle time is cheaper and more accurate than mining CC logs. | — | — |
| **10** | `tui` | Front-end refinement: replace the CLI Host's plain print/stdin with a real **TUI** (live now-playing/status region + scrolling program log + a stable input line). The **single richer front-end murmur ever gets** — there is no GUI/menu-bar/web. | front-end polish (off the L0→L1 critical path) | 01 |
| **11** | `agentic-steer` ([`specs/spec11/11-agentic-steer.md`](spec11/11-agentic-steer.md)) | The reply turn becomes an agent: the steer/talkback call runs the 03-01 harness with `switch_music` / `end_broadcast` / `submit_reply`, so the listener's words can act on the program (skip lands via handover-on-resolve; shutdown is confirm-first). Boundary automation stays local policy (§7 pillar 1 unchanged — this arms the one call the listener already pays for). | companion feel | 01,03-01,03-02,04 |
| **12** | `settings` ([`specs/spec12/12-settings.md`](spec12/12-settings.md)) | The listener's knobs, persisted: `$MURMUR_HOME/settings.json` merged under env/flags per knob, an engine-owned single-writer store with hot application, two additive wire messages, and the TUI `/settings` pane — exactly seven writable intents (anchors, music, mix gear, gap, mute, pet, memory span) plus read-only home/endpoint status. | companion polish | 01,05,10 |

### 10.1 Decomposition principles
- **Interface-first (AI-friendly key)**: spec `01` declares the **VoiceProvider / MusicProvider / Memory contract seams** explicitly; their implementations land in 02 / 03-01 / 05 respectively. Parts stay decoupled and buildable in order, and a coding agent never has to guess an interface.
- **Persistence**: local files (no DB in v1). **No front-end API server in v1** — single process, one consumer (your terminal).
- **One-click install; guided, atomic provisioning — with a binary/library split.** As a distributed product, the base install is **one step** and runs **model-free** (stub / no voice). Enabling a capability is a **single guided action**; the user never hand-installs a missing dependency or hits a runtime import error. A capability is fully provisioned or not offered; **no half-installed state**. The mechanism splits by how murmur consumes the dependency:
  - **Libraries (imported in-process)** — e.g. `mlx-audio`, `numpy`, `claude-agent-sdk` — are declared in `pyproject.toml` (core or an extra); the guided setup wraps the extra install (+ model weight downloads) as one atomic action.
  - **Binaries (invoked as subprocesses)** — e.g. `ffmpeg`, `yt-dlp` (and any future tool like a JS runtime or `musicdl`) — are **deliberately unbound from the package**: not in any extra, versioned independently of murmur (they update on their own fast cadence, e.g. yt-dlp vs YouTube). The **startup checks** (spec 03-02 §2.4) detect a missing/broken one; the **setup guide** (spec 03-03, the harnessed native agent) installs or repairs it with the user's step-by-step consent.
- **Detach/daemon is an optional side branch, NOT on the main path.** The v1 core path is a foreground single process (terminal close = stop). Only if/when we want "the radio keeps playing after the terminal closes + a detachable/re-attachable session" do we add a separate daemon/client spec; its reattachable surface would build on the TUI (spec 10), not redefine it.

### 10.2 What sub-specs add over this master
Each sub-spec goes one level deeper (contract, internal design, dependencies, acceptance criteria, open questions) per the template in §0. Implementation details live in the sub-specs (and their plans), never in this master.

### 10.3 Eval track (parallel — not on the L0→L1 critical path)
A dedicated `specs/specNN/NN-model-voice-eval.md` harness to evaluate **real model/voice capability**:
- TTS **voice-quality blind A/B** to pick the primary voice (the §8 deferred item).
- Any LLM / prompt / persona capability eval (Ollama-preferred per §11.4).

This is where the heavy real models (Qwen3-TTS et al., real LLMs) are actually run for evaluation. It is **parallel**, not a milestone dependency — it can begin once spec 02 gives a real voice. Heavy/real models run **only here**, never inside a normal build's tests (§11.3).

---

## 11. Testing strategy

Tests are **mandatory**. The approach is layered by what is actually testable.

### 11.1 Seams make the core testable
Every seam (`VoiceProvider`, `MusicProvider`, `MemoryStore`, Brain) ships a **fake** implementation. The core loop, the Director's policy, and all pure logic are tested against fakes — no real audio, LLM, or network. (Spec 01's stub `VoiceProvider` doubles as the fake.) This is the payoff of the interface-first design (§10.1).

### 11.2 Three layers
1. **Unit — fast, every change, test-first (TDD).** Pure logic + the loop driven by fakes. New logic is written **test-first**: failing test → implementation → green. Framework: `vitest` (`pnpm test`).
2. **Real-boundary — manual on-demand.** Real TTS synth, real `yt-dlp`, real SDK behavior, audio. Slow/heavy — **not** in the fast loop; run deliberately as throwaway `scratch/` smokes (the `murmur-smoke` flow). Not run on every change.
3. **Human acceptance — sensory, the user runs.** "Sounds human," "feels like radio," "type-and-reply flows" — the milestone §9.3 criteria. The agent produces a **checklist**; the user runs it and confirms. The agent cannot self-verify these (it can't hear the voice or judge warmth).

### 11.3 Real-model eval is its own part
Running the actual heavy models (Qwen3-TTS et al., real LLMs) to **evaluate capability** does **not** belong in normal per-spec build/verification. It lives in the dedicated eval track (§10.3). A normal build's tests use fakes (and Ollama, below) — never the heavy models.

### 11.4 Prefer Ollama for local model testing
When a test or eval needs an **actual LLM** (not a canned fake) — exercising prompt/persona behavior, or an LLM-as-judge — **prefer a local Ollama model** over calling Claude: free, offline, fast. Real Claude (via `claude-agent-sdk`) is reserved for production and a gated, on-demand live smoke test.

---

## Appendix: key-decision quick reference (to avoid re-litigating)
- **Why TypeScript**: the brain harness is the product's heart and the TS Agent SDK is its first-class surface; deferring local TTS (the one hard Python constraint) freed the choice (issue #54).
- **Why a local TTS would be a sidecar**: slow load, keep it warm, crash isolation, clean hot-swap (deferred with local TTS).
- **Why murmur ships no model**: it keeps murmur's own code MIT while leaving the most emotional TTS — non-commercially licensed — a legitimate default, since its terms bind the listener who reaches the endpoint, not murmur's source (§3.7).
- **Why yt-dlp for v1 music**: the only "no login, no membership, no app" start that also covers Chinese (Bilibili); Spotify is gated by Premium, NetEase by unofficial-API + login.
- **Why single loop + look-ahead**: a radio can't have dead air; this is the minimum-cost prevention.
- **Why persona lives in Memory**: it needs a **writable, user-owned home** next to the profile (seeded on first run, then edited by the user) — not because murmur rewrites it. Auto-evolution was considered and rejected (§2.3, amended 2026-07-29): rewrite loops mean-revert, so the *profile* grows and the character stays.
- **Structure vs content**: a segment's *kind* is architecture; what a segment *talks about* is a System Prompt detail.
- **No API server / no DB in v1**: single process, one consumer (your terminal), local-file persistence; add a server/DB only when a second front-end or query-heavy state appears.
