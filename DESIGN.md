# murmur · v1 Master Spec (living doc)

> **Status**: Building. Architecture/feature-set aligned; **spec 01 (`core-loop`, the L0 spine) is implemented & verified** (with a `pytest` layer). Next: spec 02 (`voice-provider`) to make L0 audible. See §10 for the build-order map.
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
- **All prompt text is centralized** under `src/murmur/prompts/` and written in **English** (v1). The radio's *output* language is set inside the prompt — e.g. the persona seed instructs Chinese speech — so English prompt scaffolding still yields a Chinese-speaking radio. No prompt strings scattered through application modules.
- **No Chinese (CJK) anywhere in source** — comments, string literals, and docstrings alike (v1). The radio speaks Chinese only at runtime, produced by the model from the persona prompt; it is never a hardcoded string. Additionally, **comments are English-only**. Enforced by `scripts/check_source_language.py` (wired via pre-commit; stdlib-only).
- Master spec stays high-altitude; sub-specs may go deeper but remain design-level, not code.
- Sub-specs live under `specs/` and are ordered by build sequence (e.g. `specs/01-…`, `specs/02-…`).
- Cross-reference with relative links; mark status on every doc.

> **Master status**: the v1 **minimal playable loop** (§9) and the **decomposition + sub-spec map + build order** (§10) are now defined. This master is "complete enough" to spawn sub-specs under `specs/` per the build order.

---

## 1. What this is (Vision)

A **fully-local, personal-use companion radio** — "a radio that broadcasts for an audience of one," with Claude as its brain.

It is **always on the air**: it finds a topic and chats with me on its own, plays a song, comes back and keeps going; at the right times it says good morning / good night. It is **mostly broadcasting, but occasionally turns to me and asks something** (if I don't engage, it gracefully slides back into the program). It has a **persona that grows** — seeded by a few questions up front, then it learns me as it keeps me company and fits me better over time. I talk to it with the **keyboard**; it answers with a **voice that sounds human**.

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
- **Mostly broadcasting**: it talks at you like real radio and **does not require a reply** — if you say nothing, it keeps going. Companionship is "that voice in the background," pressure-free.
- **Occasionally turns to you**: at the right moment it turns and asks you something.
- **If you engage, you chat for a bit; if you don't, it gracefully slides back into the program.**
- The exact **degree** of "occasionally" (how often it turns to you, what triggers it, how long before it slides back) is a detail for a later sub-spec.

### 2.3 A persona that grows
The persona is **not a hard-coded constant — it is an evolving, living asset**:
- **Cold-start seeding**: on first use it asks a few basic questions → generates a first persona (essentially a System Prompt).
- **Continuous evolution**: while keeping you company it keeps observing you → gradually rewrites the persona to fit you better.
- **(Committed, deferred to a later sub-spec) permissioned data bootstrap**: with your consent, feed it how you talk with Claude Code and the things you say → it analyzes and infers "who you are and what persona would best keep you company," so cold-start lands in one step instead of grinding up from zero.
- **A single evolving persona**, not "preset channels you switch between." (Multi-channel / multi-mode is out of v1.)

> **Important layering distinction**: "what personality / tone the host has" is a **detail** — it lives in the System Prompt, maintained in natural language. The **only high-level matter** about persona is the fact that *it is alive and self-customizing* — and that is already decided.

---

## 3. Locked foundations (decisions + rationale)

Each item records the **why**, to avoid re-litigating later.

### 3.1 Positioning & privacy boundary
- **Fully local, personal use**, not distributed to others.
- **The only two network hops**: ① Claude brain inference; ② the music stream. All other logic, I/O, and memory stay on-device.
- *Rationale*: this is the project's founding constraint; it also directly unlocks the TTS licensing call below (see 3.5).

### 3.2 Brain & authentication
- Brain = **Claude Opus**, via `claude-agent-sdk`, **reusing the local Claude Code subscription OAuth credentials** — **no API key needed**.
- *Rationale*: this auth chain is already verified in the `~/.personal/ai-investment` project — with no `ANTHROPIC_API_KEY` in the environment, the SDK falls back to the local `claude /login` subscription credentials and bills the subscription directly. For headless contexts, `claude setup-token` can mint a one-year token.

### 3.3 Language / runtime: all Python
- Orchestrator + TTS sidecar are **both Python**.
- *Rationale (weighed, not a default)*:
  - **The gravity of the TTS ecosystem is the hard constraint** — the candidate TTS models (Qwen3-TTS/MLX, CosyVoice2, Chatterbox, OpenAudio) **all live in the Python/PyTorch/MLX ecosystem**; local neural TTS is essentially absent in TS/Rust/Go.
  - The Claude Agent SDK has **first-class support on both** Python and TS, so it does not force the choice.
  - An async always-on loop + concurrent input reading is well within Python's reach.
  - **Key insight**: regardless of orchestrator language, TTS should run as a separate sidecar (see 3.5); once you accept that process boundary, the orchestrator's language is actually freed up — but for a **solo, local, fast-iterating MVP**, all-Python removes an entire language boundary and IPC layer, so it remains optimal. Polyglot only pays off if you'd rather write the app logic in another language.

### 3.4 Input: keyboard only; no ASR this round
- v1 user input is via **keyboard**.
- *Rationale*: ASR (Whisper et al.) is a mature, solved problem and not this project's value-add; defer it to focus on the genuinely hard part — making the AI *sound human*.

### 3.5 Output / TTS: hot-swappable, human-ness is the soul
- **`VoiceProvider` abstraction**: TTS is a hot-swappable backend, not hard-coded. Each model is its own adapter, switchable by one config line; you can even **mount different models per scenario** (a fast one for live replies, a warm/rich one for proactive broadcasts).
- **Candidate pool** (decide the primary after a blind A/B): Qwen3-TTS, CosyVoice2, Chatterbox Multilingual V3, OpenAudio S1-mini.
- **TTS runs as an always-on warm sidecar process.** *Rationale*: models load slowly (seconds, several GB), so keep them warm rather than loading on every utterance; crash isolation — a TTS crash must not take down the radio brain; cross-process is also the cleanest seam for hot-swapping.
- *Selection notes (from mid-2026 research)*:
  - Because this is **personal use**, the "non-commercial license" landmines the research flagged (CosyVoice2/F5/Fish/IndexTTS2, etc.) **do not apply to us** → this unlocks the most emotionally expressive models.
  - On Mac the real trade-off is just "can it run in real time": MLX/Metal-accelerated models (e.g. Qwen3-TTS) can; CosyVoice2/GPT-SoVITS et al. are mostly CPU-bound and slow on Mac → better for **pre-generation** than millisecond-latency.
  - Since v1 input is keyboard and proactive broadcasts can be pre-generated in the background, "slow on Mac" matters little for broadcast → the most emotionally rich models remain usable.
  - **The human-ness / warmth of the voice is the soul of this product.** The primary model is ultimately decided by ear, via blind listening.
- *Paid cloud backlog (for a future quality upgrade)*: most emotional — Hume Octave; best Chinese — Doubao/Volcengine, MiniMax; cheapest — OpenAI gpt-4o-mini-tts; lowest latency — Cartesia; ceiling but pricey — ElevenLabs; plus Fish Audio cloud.

### 3.6 Interaction form: a single always-on Python async CLI process
- One always-on process (e.g. `murmur`), launched in a terminal; one coroutine drives "speaking up," another reads keyboard input, both feed into the brain. **Proactive broadcasts and your typing share the same terminal** — no daemon/client split.
- *Rationale*: for personal use, CLI is the lightest and fastest path to an MVP, with no GUI overhead. **There is no GUI, no menu-bar, and no web surface — not in v1, and not planned.** The only richer front-end murmur ever gets is a **TUI** (terminal UI), which upgrades the same in-terminal CLI Host surface in place — never a separate window/app/page. See the TUI sub-spec (§10, `specs/10-tui.md`).

---

## 4. Architecture & layers

```
┌─────────────────────────── murmur (single Python asyncio process) ──────────────────────┐
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
       Only network hops: Claude inference (one)  +  music stream (one)
```

| Component | Responsibility | Notes |
|---|---|---|
| **CLI Host** | Render "now playing" + read keyboard input | proactive + typing share the terminal |
| **Program Director** | The soul: continuously decide "what plays next" (autonomous talk / music / time-anchor), modulate talk density by activity + time-of-day; manage "turn to you / slide back" | mostly local policy — not every decision calls Claude |
| **Brain** | Claude SDK session: ① generate talk-segment scripts / pick topics ② respond when you type. Persona + memory injected | see token economy |
| **VoiceProvider** | text → speech, hot-swappable TTS, warm sidecar, splittable fast/rich by scenario | candidate pool in 3.5 |
| **MusicProvider** | topic/query → audio stream, hot-swappable | v1 = yt-dlp |
| **AudioPlayer** | sole audio authority: sequence TTS + music, duck/stop on interrupt | only one thing "on air" at a time |
| **Memory** | who you are, topics discussed, segments/songs played (anti-repeat), conversation log; **the persona living asset also lives here** | see §6 |
| **ActivitySensor** | observe your active hours (keyboard / Claude Code usage / clock…) → feed the Director's pacing | shares the Claude Code data source with persona bootstrap |
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

---

## 6. Memory layer (three tiers, MVP-trimmed)

| Tier | Stores | How it's used |
|---|---|---|
| **① Profile (long-term)** | who you are, preferences, recent context, favorite topics, **the persona (living asset)** | injected every prompt; the core of "it gets me"; persona evolution = updating this tier |
| **② History (mid-term)** | conversation log (your input + what it broadcast), recent window | take the last N for continuity |
| **③ Ledger (anti-repeat)** | topics covered, songs played, broadcast times | checked at segment selection for de-dup and callbacks |

- **Semantic memory (vector recall) is deferred to v1.5**; the MVP gets ~80% of the "it gets me" feel from "profile + recent window + ledger," with structure reserved for it.
- Writes: append history and record the ledger after each segment / each input; the profile is updated via **periodic compaction** so it doesn't grow unbounded.
- Each Brain call gets a compact **context pack**: `persona + profile + recent window + topics already covered today + current time/activity`.

---

## 7. Token economy (the radio talks nonstop; without care it burns the subscription)

Three pillars + helpers:
| # | Strategy | Saves where | v1? |
|---|---|---|---|
| 1 | **Don't call Claude for everything** | "talk vs music," "which anchor" are the Director's local policy, 0 tokens | ✅ |
| 2 | **Batch generation (most important)** | one call generates the next N segments' scripts (a monologue split into beats), doled out between songs → one call covers minutes of radio | ✅ |
| 3 | **Tiered models** | Haiku for idle filler, Opus only when you genuinely engage | ✅ |
| 4 | **Cache the stable prefix** | `persona + profile` goes through prompt caching → near-free on repeated calls; send only history deltas | ✅ |
| 5 | **Activity-gated generation** | when you're away → go quiet (more music / pause talk generation), don't burn tokens on an empty room | ✅ |
| 6 | **Local templated filler** | time announcements, "up next, from…", fixed greetings → local templates, no LLM | ✅ |
| 7 | **Budget + graceful degradation** | near the cap, fall back to "music + templates" | △ later |

Core: pillars 2 (batch) + 5 (activity-gating) + 4 (caching) turn "always on the air" from "always burning" into "generate once, play slowly, rest when nobody's listening."

---

## 8. Scope

### In v1 (WHAT)
- Claude brain (subscription auth) · always-on Python CLI (keyboard in / voice out)
- Continuous radio stream (autonomous talk + music + time anchors) · hybrid proactive/passive (model C)
- Hot-swappable TTS (human-ness first) · yt-dlp music (YouTube+Bilibili)
- A persona that grows (onboarding seed + learn-as-you-go)
- Memory three tiers + token-economy three pillars

### Committed to v1 but split into later sub-specs / steps
- **Permissioned ingestion of Claude Code data** → bootstrap persona & sense activity (its own sub-spec)
- Concrete activity-pacing mechanism · the "degree" of proactive/passive · blind A/B to pick the primary TTS (→ eval track, §10.3) · semantic memory recall

### Explicitly not in v1
- ASR (keyboard instead) · **GUI / menu-bar / web surface** (if any UI is ever added it is a **TUI** — §10, `specs/10-tui.md` — never a GUI/menu-bar/web) · Spotify / Apple Music / NetEase · multi-channel / multi-mode switching

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
| Persona | hand-written **static** System Prompt seed | onboarding Q&A + evolution is its own sub-spec; L0 does not touch it |
| Voice | wire **Qwen3-TTS first** (from the candidate pool) | it is the only **real-time-on-Mac** option, so the loop feels live; the `VoiceProvider` seam stays open for hot-swapping the rest |
| Memory | **session-only** in-process history (coherence within one run) | cross-session persistence deferred to sub-spec 05 |
| Dead air | **accept small gaps**, no look-ahead | look-ahead is polish (sub-spec 04); get the loop running first |
| Token economy | minimal: **one segment per call + natural pause between segments + manual stop** | full economy (batch/cache/tier/gate) deferred to sub-spec 08; but because it talks nonstop, L0 still needs a cadence + an easy stop so testing does not drain the subscription |
| Process | **foreground single process**, closing the terminal stops it | the daemon/detach option is a non-blocking later side-spec (see §10) |

### 9.3 L0 acceptance criteria (feature level — "done")
1. Launching `murmur` makes it **start speaking in a real voice on its own**, without the user speaking first.
2. Segments come one after another with **natural pacing** (neither a firehose nor awkward long dead air).
3. The user types a line → it **catches it, responds, and flows back** into the program.
4. The user can **stop it cleanly**.

### 9.4 Explicitly deferred out of L0
Music (→ L1 / spec 03), no-dead-air look-ahead (04), persistent memory (05), onboarding + persona evolution (06), proactive "turn to you" + time anchors + activity pacing (07), full token economy (08), Claude Code ingestion (09).

---

## 10. Decomposition, build order & sub-spec map

v1 ships as **a sequence of sub-specs**, ordered so that **every step runs and adds something audible**. L0 = specs 01+02; L1 (radio feel) = +03. (**✅** in the table = implemented & verified; see that sub-spec's own status block for detail.)

| # | sub-spec (`specs/NN-…`) | Part it delivers | Milestone | Depends on |
|---|---|---|---|---|
| **01 ✅** | `core-loop` | Single-process spine: CLI Host + Program Director (talk-only policy) + Brain (Claude SDK, subscription auth) + static persona load + typed talk-back + session-only history + AudioPlayer (basic, sole audio authority, manual stop) + segment cadence. **Declares the outbound interface contracts** (VoiceProvider / MusicProvider / Memory seams). | **L0** | — |
| **02** | `voice-provider` | VoiceProvider interface impl + TTS sidecar process + first adapter (Qwen3-TTS). | **L0** (01+02 = audible) | 01 |
| **03** | `music-provider` | MusicProvider interface + yt-dlp adapter (YouTube+Bilibili) + Director talk↔music scheduling + AudioPlayer music playback. | **L1** (radio feel) | 01 |
| **04** | `no-dead-air` | 1-segment look-ahead / pre-generation buffer to remove inter-segment gaps. | polish | 01,02,03 |
| **05** | `memory` | Persistent three tiers (profile/history/ledger) + context-pack assembly + periodic compaction. | cross-session "gets me" | 01 |
| **06** | `persona-lifecycle` | Onboarding seed Q&A + persona evolution loop (observe → rewrite). | living persona | 05 |
| **07** | `proactive-and-pacing` | Model-C "turn to you / slide back" degree + time anchors (Scheduler) + activity-aware pacing (ActivitySensor). | companion character | 01,05 |
| **08** | `token-economy` | Batch generation + prompt caching + tiered models + activity-gating + budget/graceful degradation. | don't burn the quota | 01,05,07 |
| **09** | `claude-code-ingestion` | Permissioned ingestion of Claude Code data → bootstrap persona (feeds 06) + activity signals (feeds 07). | accelerator | 06,07 |
| **10** | `tui` | Front-end refinement: replace the CLI Host's plain print/stdin with a real **TUI** (live now-playing/status region + scrolling program log + a stable input line). The **single richer front-end murmur ever gets** — there is no GUI/menu-bar/web. | front-end polish (off the L0→L1 critical path) | 01 |

### 10.1 Decomposition principles
- **Interface-first (AI-friendly key)**: spec `01` declares the **VoiceProvider / MusicProvider / Memory contract seams** explicitly; their implementations land in 02 / 03 / 05 respectively. Parts stay decoupled and buildable in order, and a coding agent never has to guess an interface.
- **Persistence**: local files (no DB in v1). **No front-end API server in v1** — single process, one consumer (your terminal).
- **Detach/daemon is an optional side branch, NOT on the main path.** The v1 core path is a foreground single process (terminal close = stop). Only if/when we want "the radio keeps playing after the terminal closes + a detachable/re-attachable session" do we add a separate daemon/client spec; its reattachable surface would build on the TUI (spec 10), not redefine it.

### 10.2 What sub-specs add over this master
Each sub-spec goes one level deeper (contract, internal design, dependencies, acceptance criteria, open questions) per the template in §0. Implementation details live in the sub-specs (and their plans), never in this master.

### 10.3 Eval track (parallel — not on the L0→L1 critical path)
A dedicated `specs/NN-model-voice-eval.md` harness to evaluate **real model/voice capability**:
- TTS **voice-quality blind A/B** to pick the primary voice (the §8 deferred item).
- Any LLM / prompt / persona capability eval (Ollama-preferred per §11.4).

This is where the heavy real models (Qwen3-TTS et al., real LLMs) are actually run for evaluation. It is **parallel**, not a milestone dependency — it can begin once spec 02 gives a real voice. Heavy/real models run **only here**, never inside a normal build's tests (§11.3).

---

## 11. Testing strategy

Tests are **mandatory**. The approach is layered by what is actually testable.

### 11.1 Seams make the core testable
Every seam (`VoiceProvider`, `MusicProvider`, `MemoryStore`, Brain) ships a **fake** implementation. The core loop, the Director's policy, and all pure logic are tested against fakes — no real audio, LLM, or network. (Spec 01's stub `VoiceProvider` doubles as the fake.) This is the payoff of the interface-first design (§10.1).

### 11.2 Three layers
1. **Unit — fast, every change, test-first (TDD).** Pure logic + the loop driven by fakes. New logic is written **test-first**: failing test → implementation → green. Framework: `pytest`.
2. **Integration — tagged, manual on-demand.** Real TTS sidecar synth, etc. Slow/heavy — **not** in the fast loop; run deliberately (e.g. `pytest -m integration`). Not run on every change.
3. **Human acceptance — sensory, the user runs.** "Sounds human," "feels like radio," "type-and-reply flows" — the milestone §9.3 criteria. The agent produces a **checklist**; the user runs it and confirms. The agent cannot self-verify these (it can't hear the voice or judge warmth).

### 11.3 Real-model eval is its own part
Running the actual heavy models (Qwen3-TTS et al., real LLMs) to **evaluate capability** does **not** belong in normal per-spec build/verification. It lives in the dedicated eval track (§10.3). A normal build's tests use fakes (and Ollama, below) — never the heavy models.

### 11.4 Prefer Ollama for local model testing
When a test or eval needs an **actual LLM** (not a canned fake) — exercising prompt/persona behavior, or an LLM-as-judge — **prefer a local Ollama model** over calling Claude: free, offline, fast. Real Claude (via `claude-agent-sdk`) is reserved for production and a gated, on-demand live smoke test.

---

## Appendix: key-decision quick reference (to avoid re-litigating)
- **Why Python**: TTS ecosystem is all Python; a solo MVP saves a language boundary.
- **Why TTS is a sidecar**: slow load, keep it warm, crash isolation, clean hot-swap.
- **Why personal use matters**: it unlocks the most emotional, non-commercially-licensed TTS.
- **Why yt-dlp for v1 music**: the only "no login, no membership, no app" start that also covers Chinese (Bilibili); Spotify is gated by Premium, NetEase by unofficial-API + login.
- **Why single loop + look-ahead**: a radio can't have dead air; this is the minimum-cost prevention.
- **Why persona lives in Memory**: the persona is an evolving living asset, not a constant.
- **Structure vs content**: a segment's *kind* is architecture; what a segment *talks about* is a System Prompt detail.
- **No API server / no DB in v1**: single process, one consumer (your terminal), local-file persistence; add a server/DB only when a second front-end or query-heavy state appears.
