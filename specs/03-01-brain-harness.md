# spec/03-01 · brain-harness — the isolated brain becomes a tool-using agent

> **Status**: Not started. Design-level (mechanism + contracts, not final code).
> **Part**: The general **brain-harness** seam (master [`../DESIGN.md`](../DESIGN.md) §3.2 — "the brain is a *harnessed agent*, not a one-shot LLM call") + its **first capability**: habit-based music search & recommendation (the `MusicProvider` implementation) + the Director's talk↔music scheduling. See master §4 (architecture), §5 (music sources), §7 (token economy), §10 (build order).
> **Milestone**: L1 (radio feel) — with [`03-02-ducking.md`](03-02-ducking.md). This spec alone makes the radio **find and play real songs** between talk segments (sequentially, via the existing player). 03-02 then makes talk-over-music and interjection **duck** instead of hard-stop.
> **Conventions**: English; written for a coding agent. Prompt text centralized under `src/murmur/prompts/`; no CJK in source (master §0).

---

## 1. Goal & scope

### Delivers
1. **A general brain-harness.** Extend the spec-01 `Brain` (a stateless, tool-less `query`) into a **tool/skill-using agent**: murmur registers **its own** in-process tools; the brain can call them during an *agentic task* (a bounded tool-use loop) and return a structured result. Full isolation from the **user's local Claude Code environment** is preserved (spec 01 §3.2). The seam is **general** — music is only its first consumer; specs 05/06/07 hang more capabilities on it.
2. **First capability — habit-based music discovery.** Given the user's habits/taste (persona + session memory) and current program context, the harnessed brain **searches, judges, and recommends** a track, then it is **pulled** to a playable `AudioClip(kind="music")`. Driven by **(c) situational + taste together**: the brain sees both the recent conversation (situational DJ) and the persona/taste (habit).
3. **`MusicProvider` implementation** (the spec-01 seam, widened): a low-level source with `search` + `resolve`. Default **yt-dlp** (YouTube + Bilibili); **musicdl optional** (user-installed, per master §5) behind the same seam.
4. **Director talk↔music scheduling.** Local policy (0 tokens, master §7 pillar 1) that decides *when* a music segment plays; on music time the Director asks the harness for a track and plays it.

### Out of scope (explicit non-goals)
- **Ducking / simultaneous mixing** → [`03-02`](03-02-ducking.md). Here music plays **sequentially** through the existing spec-01 player; a typed interjection **hard-stops** the song (L0 behavior) until 03-02 lands.
- **Persistent profile / cross-session taste + anti-repeat ledger** → spec 05. Here: session-only memory (spec 01) + an **in-session** played-set.
- **Persona onboarding/evolution** → spec 06. **Time anchors / activity pacing / proactive "turn to you"** → spec 07.
- **Capabilities beyond music** (e.g. "analyze my NetEase playlist to learn my taste"). The harness is *designed* to carry them (§3.1), but this spec ships **only** the music capability + the general seam; other capabilities land in 05/06/09.
- **No-dead-air look-ahead / pre-generation** → spec 04. Here, accept a small gap while a track resolves (master §9.2 "accept small gaps").
- ASR, GUI.

---

## 2. Contracts / seams

### 2.1 The harness: murmur-owned tools + agentic invocation
A **tool** is murmur-owned, in-process, and pure to the harness (no dependency on the user's machine beyond what the tool itself does):

```python
class BrainTool(Protocol):
    name: str                 # stable tool id (e.g. "search_music")
    description: str          # what it does / when to call it (for the model)
    input_schema: dict[str, Any]   # JSON Schema for the arguments

    async def run(self, args: dict[str, Any]) -> dict[str, Any]: ...
    """Execute the tool. Args validated against input_schema by the harness
    before this is called. Returns a JSON-serializable result handed back to
    the model as the tool result."""
```

The `Brain` grows a **general agentic entry point** alongside the tool-less spec-01 methods (`next_talk`, `respond` stay unchanged and tool-less by choice):

```python
async def run_task(
    self,
    instruction: str,
    ctx: ContextPack,
    *,
    tools: list[BrainTool],
    schema: dict[str, Any],       # JSON Schema the final result MUST satisfy
    model: str,                   # tier per task (music search -> Haiku)
    max_turns: int,               # hard bound on the tool-use loop
) -> dict[str, Any]: ...
"""Run a bounded agentic loop: the model may call the supplied `tools`,
observe results, and iterate, until it finalizes via a **terminal tool**
whose `input_schema` is `schema` — this is how structured output is enforced
(the SDK does not natively validate a free-text final message). `tools` is
the ONLY tool surface exposed. Returns the validated structured result."""
```

**Isolation invariants (carried from spec 01 §3.2, must not regress):** `setting_sources=[]` (no user settings/`CLAUDE.md`), `mcp_servers` contains **only murmur's own in-process tool server** (nothing from the user's machine), no user skills/commands, subscription-OAuth preserved. The only tools reachable are the `tools` passed in — never a shell, filesystem, or network tool the harness did not register.

### 2.2 `MusicProvider` — the low-level source (widens the spec-01 seam)
Spec 01 declared `MusicProvider` (`start` / `resolve(query)->AudioClip` / `aclose`) and reserved the right to widen `resolve`. This spec widens it to a **search + resolve** capability, since selection is now Claude-driven:

```python
@dataclass(frozen=True)
class TrackCandidate:
    """A search hit the brain judges. Enough signal to reject junk
    (hour-long loops, low-quality re-uploads) and prefer official audio."""
    ref: str            # opaque provider handle (URL / id) passed back to resolve()
    title: str
    uploader: str       # channel / artist / uploader
    duration_s: int
    extra: dict[str, Any]   # provider-specific (e.g. view_count, is_official)

class MusicProvider(Protocol):
    async def start(self) -> None: ...
    async def search(self, query: str, *, limit: int = 5) -> list[TrackCandidate]: ...
    async def resolve(self, ref: str) -> AudioClip: ...   # AudioClip(kind="music")
    async def aclose(self) -> None: ...
```
- **yt-dlp adapter (default):** `search` via `ytsearch{limit}:<query>` (metadata only, no download); `resolve` via `-f bestaudio -g` → a **stream URL** (`AudioClip.source` = URL, no disk download — master decision A). Covers YouTube + Bilibili.
- **musicdl adapter (optional, user-installed):** same seam; a downloader → `AudioClip.source` = a local file. Not required for core tests; not in the shipped default (master §5).

### 2.3 Music tools (the harness's first tools, wrapping `MusicProvider`)
Two `BrainTool`s handed to `run_task` for the music task:
- `search_music(query: str, limit: int) -> {candidates: [TrackCandidate...]}` — wraps `MusicProvider.search`.
- `submit_pick(ref: str, why: str) -> {ok: bool, error?: str}` — the **terminal tool** that both ends the loop and yields the result. The harness calls `MusicProvider.resolve(ref)`: on success the resolved `AudioClip` becomes the task's final result and the loop ends; on failure it returns `{ok: false, error}` so the brain picks another candidate and calls `submit_pick` again. This one tool unifies "confirm the pick is *actually playable*" + "enforce structured termination" + "hand the `AudioClip` back" — no implicit shared cache, no separate re-resolve.

Selection heuristics (avoid loops/covers/live unless apt, prefer official audio, match language/taste) live in the **task instruction prompt** for the MVP (a formal SDK *skill* is a later option — see Open Questions), centralized under `src/murmur/prompts/`.

### 2.4 The Director-facing entry — habit-based pick-and-pull
```python
class MusicProgrammer:
    async def next_track(self, ctx: MusicContext) -> AudioClip | None: ...
    """Run the harnessed brain (Haiku, bounded turns) with the music tools
    over `ctx`; the brain searches, judges candidates against habits+context,
    and finalizes with `submit_pick`, which resolves the chosen ref. Returns
    the `AudioClip` captured by that terminal call, or None if nothing suitable
    resolves within `max_turns` (Director falls back to more talk)."""
```

`MusicContext` — the search context (master §6 cousin; L1-available fields only):
```python
@dataclass(frozen=True)
class MusicContext:
    persona: str              # taste / language (spec 01)
    recent: list[Turn]        # what we've been talking about (situational DJ)
    played_refs: list[str]    # in-session anti-repeat set (persistent ledger -> 05)
    time_of_day: str          # "morning" | "afternoon" | "evening" | "late-night"
    intent: str               # Director's ask, e.g. "fit the current topic" | "just a good track for now"
```

---

## 3. Design

### 3.1 The harness is general; music is the first citizen
`run_task` + `BrainTool` are **capability-agnostic**. Music supplies one tool set + one result schema; a future "analyze this playlist to learn taste" capability (spec 06/09) supplies different tools (a sandboxed file reader) + a different schema, over the **same** entry point. This spec must not bake music assumptions into `run_task`/`BrainTool`. The two master §3.2 boundaries are enforced here:
- **Bounded surface:** the harness exposes only the tools passed to `run_task`; music tools touch only the `MusicProvider`, nothing else.
- **Off the live loop:** `next_track` is awaitable and **cancelable**; heavy multi-step tasks (future) run as background jobs so the stream never stalls. (Full pre-generation/look-ahead is spec 04; here, if resolving overruns, the Director accepts a small gap or fills with talk.)

### 3.2 Selection flow (per music segment)
1. Director decides "music time" (§3.4) and builds a `MusicContext` (intent + persona + recent + played_refs + time_of_day).
2. `MusicProgrammer.next_track` calls `brain.run_task(instruction, ctx, tools=[search_music, submit_pick], schema=PICK_SCHEMA, model=haiku, max_turns=N)`.
3. The brain calls `search_music` (maybe refining the query once or twice), judges candidates against habits+context+heuristics, then calls `submit_pick(ref, why)` on its choice; the harness resolves it and, on success, ends the loop with the `AudioClip` as the result (on failure the brain picks again).
4. `next_track` returns that `AudioClip`; the Director records `ref` into the in-session played-set, appends a `Turn("radio", "<DJ intro line>")` if any, and plays it.

### 3.3 Token economy (master §7)
- **Haiku** for the music-search loop (pillar 3, tiered models); **Opus** stays for `next_talk`/`respond` (the soul). A song is minutes of zero-token airtime, so a few cheap Haiku turns per song amortize well.
- The stable prefix (persona) is cache-friendly (pillar 4) on repeated calls.
- `max_turns` hard-bounds the loop so a pathological search can't burn tokens unbounded.

### 3.4 Director talk↔music scheduling (local policy, 0 tokens)
- A simple, local cadence decides music vs talk — **no Brain call to decide** (pillar 1). MVP proposal: play a track roughly **every N talk segments**, with a light bias toward music when a talk segment ends on a strong musical/topical cue. Exact policy is tunable (Open Questions).
- On music time the Director produces a music segment via §3.2; otherwise it produces a talk segment (spec 01 loop, unchanged).

### 3.5 Interim playback (before 03-02)
Music plays through the **existing spec-01 player** (`Player.play(clip)`), which already plays any `AudioClip.source`. A stream URL requires a URL-capable player binary (e.g. `ffplay`/`mpv`) rather than `afplay`; configurable via the existing `config.player_cmd`. A typed interjection during a song **hard-stops** it (spec 01 cancel-and-resume) — this is the accepted interim; 03-02 replaces it with ducking.

---

## 4. Dependencies
- **spec 01**: `Brain`, `Director`, `Player`, `MemoryStore`, `AudioClip`, `Turn`, `ContextPack`, and the declared `MusicProvider` seam.
- **spec 02**: not required (music is independent of voice), but both feed the same Director/loop.
- **External**: `claude-agent-sdk` (in-process tool / MCP + agentic loop), `yt-dlp` (default source). **Optional**: `musicdl` (user-installed provider).
- **Model**: `claude-haiku-4-5-20251001` for the search loop (config knob, alongside the spec-01 `claude-opus-4-8`).

---

## 5. Acceptance criteria (feature level)
1. **Isolation holds under tools.** The harnessed brain, running a music task, is verifiably isolated from the user's local Claude env (no inherited `CLAUDE.md`/skills/MCP/hooks) yet can call **only** murmur's registered tools. (Assert on the SDK init payload, as spec 01 step-2 did.)
2. **Habit + situational selection.** Given a `MusicContext`, the brain returns a recommended, **resolvable** track that reflects taste and current topic; obvious junk (e.g. an hour-long loop, wrong-language when taste says otherwise) is rejected in favor of a better candidate.
3. **The radio plays real songs.** With scheduling on, the program alternates talk → real fetched song → talk, sequentially, at a natural cadence.
4. **Interjection (interim).** Typing during a song hard-stops it and the brain replies, then the program resumes. (Ducking is 03-02.)
5. **Seam proven with a fake.** The whole flow runs against a **fake `MusicProvider`** (canned candidates, a silent/placeholder clip) with **no network**; and the tool-use loop is exercised with a fake/Ollama brain (master §11.4) — no heavy real model in the normal test run.
6. **Default vs optional.** Core tests pass with **yt-dlp absent** (fakes); `musicdl` is never required.

### Testing (master §11)
- **Unit (fast, fakes):** scheduling policy; `MusicContext` assembly + in-session played-set/anti-repeat; tool arg-validation + result handling; the harness isolation-config assertion; `MusicProgrammer` flow against a fake `MusicProvider` + fake brain.
- **LLM-in-the-loop (Ollama-preferred, §11.4):** does the brain pick sensibly and reject junk given canned candidates. Not the heavy real model.
- **Integration (tagged, on-demand):** real `yt-dlp` `search`/`resolve` (network) → a real stream URL plays. `pytest -m integration`.
- **Human acceptance (sensory):** "the songs feel well-chosen for me and the moment" — the user judges; the agent produces a checklist.

---

## 6. Open questions
- **Cadence policy**: fixed "every N segments" vs probabilistic vs topical-cue-triggered. Proposal: start with every-N + a light topical bias; tune by feel.
- **Selection heuristics home**: task-instruction prompt (MVP) vs a formal SDK skill. Proposal: prompt now; promote to a skill if it grows.
- **Resolve concurrency vs the loop**: run `next_track` during the preceding talk segment (hide latency) vs accept a small gap. Proposal: accept the gap in 03-01; real look-ahead is spec 04.
- **`MusicContext` vs extending `ContextPack`**: keep a separate music context (proposed) or add optional fields to `ContextPack`. Proposal: separate, to keep the tool-less talk path lean.
- **DJ intro line**: does the brain also produce a spoken "up next…" line (one extra utterance) or is the transition silent in L1? Proposal: optional short intro, off by default until 03-02 makes talk-over-intro pleasant.
