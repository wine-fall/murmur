# spec/03-01 · brain-harness — the isolated brain becomes a tool-using agent

> **Status**: **Implemented** (merged to main; unit suite green — integration tests are tagged, run on demand). Built and tested: the harness (`Harness.run_task` + `BrainTool`, isolation invariants asserted), the yt-dlp `MusicProvider` (search/resolve), the music tools (`search_music`/`submit_pick`), the context-insertion mechanism (`MusicContext` + `render_context`), and `MusicProgrammer.next_track`. **Not yet consumed by the Director** — scheduling/playback wiring (incl. the music-model config knob) lands in [`03-02`](03-02-ducking.md) by design, so no track is audible yet. The optional `musicdl` adapter is **not implemented** (the seam supports it; user-installed, never required — master §5). Human acceptance ("tracks feel well-chosen") is pending 03-02 playback.
> **Part**: The general **brain-harness** seam (master [`../DESIGN.md`](../DESIGN.md) §3.2 — "the brain is a *harnessed agent*, not a one-shot LLM call") + its **first capability**: habit-based music search & recommendation (the `MusicProvider` implementation) + the Director's talk↔music scheduling. See master §4 (architecture), §5 (music sources), §7 (token economy), §10 (build order).
> **Milestone**: L1 (radio feel) — with [`03-02-ducking.md`](03-02-ducking.md). This spec alone makes the radio **find and play real songs** between talk segments (sequentially, via the existing player). 03-02 then makes talk-over-music and interjection **duck** instead of hard-stop.
> **Conventions**: English; written for a coding agent. Prompt text centralized under `src/murmur/prompts/`; no CJK in source (master §0).

---

## 1. Goal & scope

### Delivers
1. **A general brain-harness.** Extend the spec-01 `Brain` (a stateless, tool-less `query`) into a **tool/skill-using agent**: murmur registers **its own** in-process tools; the brain can call them during an *agentic task* (a bounded tool-use loop) and return a structured result. Full isolation from the **user's local Claude Code environment** is preserved (spec 01 §3.2). The seam is **general** — music is only its first consumer; specs 05/06/07 hang more capabilities on it.
2. **First capability — Claude-driven music discovery (find + pull only).** Given user context (see §2.5 for the *insertion mechanism*; the concrete context *content* is deferred to a later discussion), the harnessed brain **searches, judges, and recommends** a track, which is then **pulled** to a playable `AudioClip(kind="music")`. The deliverable is one call — `MusicProgrammer.next_track(...) -> AudioClip | None` — that **finds and pulls** a track. It does **not** play, schedule, or announce it.
3. **`MusicProvider` implementation** (the spec-01 seam, widened): a low-level source with `search` + `resolve`. Default **yt-dlp** (YouTube + Bilibili); **musicdl optional** (user-installed, per master §5) behind the same seam.
4. **A fast, content-agnostic context-insertion mechanism** (§2.5): push the needed context into the task up front, with the stable prefix (persona) cached and the volatile part rendered into the first turn — via a `render_context` seam whose *content* is deferred.

### Out of scope (explicit non-goals)
- **Playback, Director talk↔music scheduling, cadence, DJ "up next" announce, and ducking** → all [`03-02`](03-02-ducking.md). 03-01 **finds and pulls** a track (returns an `AudioClip`); it never plays, schedules, or announces it. Music playback and its scheduling begin in 03-02, where the mixing engine lives.
- **The concrete context *content*** (which fields describe the user/moment) → a later discussion; 03-01 builds only the insertion *mechanism* (§2.5).
- **Persistent profile / cross-session taste + anti-repeat ledger** → spec 05.
- **Persona onboarding/evolution** → spec 06. **Time anchors / activity pacing / proactive "turn to you"** → spec 07.
- **Capabilities beyond music** (e.g. "analyze my NetEase playlist to learn my taste"). The harness is *designed* to carry them (§3.1), but this spec ships **only** the music capability + the general seam; other capabilities land in 05/06/09.
- **No-dead-air look-ahead / pre-generation** → spec 04. Here, accept a small gap while a track resolves (master §9.2 "accept small gaps").
- ASR, GUI.

---

## 2. Contracts / seams

### 2.1 The harness: murmur-owned tools + agentic invocation
A **tool** is murmur-owned, in-process, and pure to the harness (no dependency on the user's machine beyond what the tool itself does). Exactly one tool per task is marked **terminal** — the model calling it (with a successful result) ends the loop:

```python
class BrainTool(Protocol):
    name: str                      # stable tool id (e.g. "search_music")
    description: str               # what it does / when to call it (for the model)
    input_schema: dict[str, Any]   # JSON Schema for the arguments
    terminal: bool                 # a terminal tool can end the task (see run_task)

    async def run(self, args: dict[str, Any]) -> dict[str, Any]: ...
    """Execute the tool (args already validated against input_schema). Returns a
    JSON-serializable dict handed back to the model as the tool result; for the
    terminal tool a result with ``ok == True`` is also what ``run_task`` returns."""
```

The agentic entry point is a **distinct capability** — a `Harness` Protocol with the single method `run_task` — that the real `ClaudeBrain` implements *alongside* the tool-less spec-01 `Brain` methods (`next_talk`/`respond` stay unchanged and tool-less by choice). Keeping it a separate Protocol means talk-only brains (the stub / test fakes) are not forced to fake an agentic loop, and each consumer depends only on the capability it needs:

```python
async def run_task(
    self,
    system_prompt: str,            # cached stable prefix (from render_context)
    prompt: str,                   # first user turn: instruction + volatile context
    *,
    tools: list[BrainTool],        # exactly one has terminal=True
    model: str,                    # tier per task (music search -> Haiku)
    max_turns: int,                # hard bound on the tool-use loop
) -> dict[str, Any] | None: ...
```
**Termination rule:** run up to `max_turns`; each model turn may call tools, each tool's `run()` result is fed back. When the **terminal** tool is called and its result has `ok == True`, the loop ends and `run_task` returns that result (structured output is enforced by the terminal tool's `input_schema`; the SDK does not natively validate a free-text final message). A terminal result with a falsy `ok` is fed back like any tool result, so the model retries with another choice. Returns **None** if `max_turns` is reached with no successful terminal call. `tools` is the ONLY tool surface exposed. **Content-agnostic**: `run_task` takes already-rendered prompt text (the caller uses `render_context`, §2.5), never a typed context — so any capability, not just music, drives the same entry point.
```

**Isolation invariants (carried from spec 01 §3.2, must not regress):** `setting_sources=[]` (no user settings/`CLAUDE.md`), `strict_mcp_config=True` (**only** murmur's own in-process server — ignore any inherited/discovered MCP; *verified live: without it the surrounding environment's MCP servers leak into the subprocess*), `tools=[]` (no built-in Read/Write/Bash/… tools), no user skills/commands, subscription-OAuth preserved. The only tools present or reachable are murmur's own mcp tools (`allowed_tools` is exactly their names) — never a shell, filesystem, or network tool the harness did not register.

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
- **yt-dlp adapter (default):** `search` via `ytsearch{limit}:<query>` (metadata only, no download); `resolve` via `-f bestaudio/best -g` (audio-only preferred; falls back to a combined format where yt-dlp cannot offer bestaudio, e.g. JS-runtime-gated YouTube formats — ffmpeg decodes either) → a **stream URL** (`AudioClip.source` = URL, no disk download — master decision A). Covers YouTube + Bilibili.
- **musicdl adapter (optional, user-installed):** same seam; a downloader → `AudioClip.source` = a local file. Not required for core tests; not in the shipped default (master §5).

### 2.3 Music tools (the harness's first tools, wrapping `MusicProvider`)
Two `BrainTool`s handed to `run_task` for the music task:
- `search_music(query: str, limit: int) -> {candidates: [TrackCandidate...]}` — wraps `MusicProvider.search`.
- `submit_pick(ref: str, why: str, title: str, artist: str, announce: str) -> {ok, source?, kind?, title?, artist?, announce?, error?}` — the **terminal tool** (`terminal=True`). It calls `MusicProvider.resolve(ref)`: on success it returns `{ok: true, source: <url/path>, kind: "music", title, artist, announce}` — enough for `next_track` to rebuild the `AudioClip` directly (no side-channel, no re-resolve) and end the loop; on failure it returns `{ok: false, error}`, a non-terminating result that lets the brain pick another candidate and call `submit_pick` again. Unifies "confirm the pick is *actually playable*" + "structured termination" + "hand the clip back". *(Extension owned by [`03-02`](03-02-ducking.md): `title`/`artist` thread the display metadata through, and `announce` is a one-line in-persona DJ intro the same task writes — zero extra LLM calls, no hardcoded copy in source.)*

Selection heuristics (avoid loops/covers/live unless apt, prefer official audio, match language/taste) live in the **task instruction prompt** for the MVP (a formal SDK *skill* is a later option — see Open Questions), centralized under `src/murmur/prompts/`.

### 2.4 The Director-facing entry — habit-based pick-and-pull
```python
@dataclass(frozen=True)
class TrackPick:            # widened return, owned by 03-02 (no consumer existed before)
    clip: AudioClip         # carries optional title/artist display metadata
    announce: str | None    # one-line in-persona DJ intro, spoken over the ducked head

class MusicProgrammer:
    async def next_track(self, ctx: MusicContext) -> TrackPick | None: ...
    """Run the harnessed brain (Haiku, bounded turns) with the music tools
    over `ctx`; the brain searches, judges candidates against habits+context,
    and finalizes with `submit_pick`, which resolves the chosen ref. Returns
    the pick captured by that terminal call, or None if nothing suitable
    resolves within `max_turns` (Director falls back to more talk)."""
```

`MusicContext` — the carrier passed to `next_track`. Its **concrete fields are deferred** (a later discussion). 03-01 pins only the two the *mechanism* (§2.5) needs — a stable cacheable prefix and a volatile block — kept minimal and extensible so content can be added later without touching the insertion mechanism:
```python
@dataclass(frozen=True)
class MusicContext:
    persona: str       # stable, cacheable prefix (taste / language)
    situation: str     # volatile block rendered into the task turn; its concrete
                       # composition (recent turns, time, anti-repeat, intent, ...)
                       # is deferred to a later spec discussion
```

### 2.5 Context insertion (the mechanism — content-agnostic)
How user context reaches the model, tuned for "reasonable + fast" (the concrete *content* is out of scope — a later discussion):
- **Push, not pull.** The needed context is composed into the task up front (one round-trip), rather than exposing a `get_context` tool the brain must call (which would cost extra turns + latency).
- **Cache the stable prefix.** The stable part (`persona`) goes in the **system prompt**, eligible for prompt caching (master §7 pillar 4), so repeated calls are near-free; the volatile `situation` is rendered into the **first user turn** and sent fresh.
- **A content-agnostic seam.** A single `render_context(ctx: MusicContext) -> (system_prefix, task_turn)` is the one place context becomes prompt text. It renders whatever the carrier holds; adding/changing context fields later touches only this seam and the carrier, never `run_task`.
This mechanism is what 03-01 builds and tests; *which* fields ride in `situation` is deferred.

---

## 3. Design

### 3.1 The harness is general; music is the first citizen
`run_task` + `BrainTool` are **capability-agnostic**. Music supplies one tool set + one result schema; a future "analyze this playlist to learn taste" capability (spec 06/09) supplies different tools (a sandboxed file reader) + a different schema, over the **same** entry point. This spec must not bake music assumptions into `run_task`/`BrainTool`. The two master §3.2 boundaries are enforced here:
- **Bounded surface:** the harness exposes only the tools passed to `run_task`; music tools touch only the `MusicProvider`, nothing else.
- **Off the live loop:** `next_track` is awaitable and **cancelable**; heavy multi-step tasks (future) run as background jobs so the stream never stalls. (Full pre-generation/look-ahead is spec 04; here, if resolving overruns, the Director accepts a small gap or fills with talk.)

### 3.2 Find-and-pull flow (one `next_track` call)
1. The caller builds a `MusicContext` and calls `MusicProgrammer.next_track(ctx)`.
2. `next_track` calls `render_context(ctx)` → `(system_prompt, situation_block)`, composes `prompt = instruction + situation_block`, then `brain.run_task(system_prompt, prompt, tools=[search_music, submit_pick], schema=PICK_SCHEMA, model=haiku, max_turns=N)` (§2.5: persona cached in `system_prompt`; volatile part in `prompt`).
3. The brain calls `search_music` (maybe refining the query once or twice), judges candidates against the context + heuristics, then calls `submit_pick(ref, why)` on its choice; the harness resolves it and, on success, ends the loop with the `AudioClip` as the result (on failure the brain picks again).
4. `next_track` returns the resolved `AudioClip` (or None if nothing suitable resolves within `max_turns`). What happens to that clip next — scheduling, announce, playback — is 03-02.

### 3.3 Token economy (master §7)
- **Haiku** for the music-search loop (pillar 3, tiered models); **Opus** stays for `next_talk`/`respond` (the soul). A song is minutes of zero-token airtime, so a few cheap Haiku turns per song amortize well.
- The stable prefix (persona) is cache-friendly (pillar 4) on repeated calls.
- `max_turns` hard-bounds the loop so a pathological search can't burn tokens unbounded.

*(Scheduling, playback, and the DJ "up next" announce moved to [`03-02`](03-02-ducking.md) — see §1 non-goals. 03-01 stops at returning a resolved `AudioClip`.)*

---

## 4. Dependencies
- **spec 01**: `Brain` (extended here with `run_task`), `AudioClip`, `Turn`, and the declared `MusicProvider` seam. **No `Director`/`Player` changes here** — playback and scheduling are 03-02.
- **spec 02**: not required (music is independent of voice), but both feed the same Director/loop.
- **External**: `claude-agent-sdk` (in-process tool / MCP + agentic loop); `yt-dlp` (default source) — an **unbound external binary** per master §10.1's binary/library split (no pip extra; provisioned by the startup checks + setup guide, versioned independently of murmur). **Optional**: `musicdl` (user-installed provider).
- **Model**: `claude-haiku-4-5-20251001` for the search loop (config knob, alongside the spec-01 `claude-opus-4-8`).

---

## 5. Acceptance criteria (feature level)
1. **Isolation holds under tools.** The harnessed brain, running a music task, is verifiably isolated from the user's local Claude env (no inherited `CLAUDE.md`/skills/MCP/hooks) yet can call **only** murmur's registered tools. (Assert on the SDK init payload, as spec 01 step-2 did.)
2. **Find + pull works.** Given a `MusicContext`, `next_track` returns a **resolvable** `AudioClip` for a track that reflects the context; obvious junk (e.g. an hour-long loop) is rejected in favor of a better candidate. (No playback — that is 03-02.)
3. **Context insertion is push + cached.** `persona` lands in the (cacheable) system prompt; the volatile `situation` is rendered into the first turn; both go through the `render_context` seam. Adding a context field touches only `render_context` + the carrier, never `run_task`. (Unit-verifiable.)
4. **Seam proven with a fake.** The whole find+pull flow runs against a **fake `MusicProvider`** (canned candidates, a placeholder clip) with **no network**; the tool-use loop is exercised with a fake/Ollama brain (master §11.4) — no heavy real model in the normal test run.
5. **Default vs optional.** Core tests pass with **yt-dlp absent** (fakes); `musicdl` is never required.

### Testing (master §11)
- **Unit (fast, fakes):** `render_context` (stable-prefix vs volatile split) + the `MusicContext` carrier; tool arg-validation + result handling; the harness isolation-config assertion; `MusicProgrammer.next_track` flow against a fake `MusicProvider` + fake brain (search → submit_pick → resolved clip; and the pick-again-on-resolve-failure path).
- **LLM-in-the-loop (Ollama-preferred, §11.4):** does the brain pick sensibly and reject junk given canned candidates. Not the heavy real model.
- **Integration (tagged, on-demand):** real `yt-dlp` `search`/`resolve` (network) → a real stream URL resolves. `pytest -m integration`.
- **Human acceptance (sensory):** "the tracks it finds feel well-chosen for me and the moment" — the user judges; the agent produces a checklist. (Playback itself is 03-02.)

---

## 6. Open questions
- **Context *content* — owned by [`03-02`](03-02-ducking.md).** 03-01 builds only the insertion *mechanism* (§2.5). *What* rides in `MusicContext.situation`, and the logic that assembles it, is decided and first populated in 03-02 (where the Director builds the context and calls `next_track`); richer fields arrive as their sources land (recent-window / anti-repeat ledger from spec 05, time-of-day / pacing from spec 07).
- **`max_turns` / model:** the bound on the search loop, and confirming the exact Haiku id, when wiring the real brain.
- **Resolve-failure fallback:** how many `submit_pick` retries before `next_track` gives up and returns None. Proposal: bounded by `max_turns`.
- **Deferred together — optional/gray providers (`musicdl` + cliamp auth):** the optional user-installed `musicdl` adapter (downloader → local file, same `MusicProvider` seam) is not built. When it — or any auth-gated source (NetEase, Spotify, …) — is attempted, borrow [`cliamp`](https://github.com/bjarneo/cliamp)'s credential/cookie auth mechanics (auth flow only, not its user-picks interaction model) — see master §5 for the full analysis. Kept as one work item so neither reference is lost.
- **Settled (recorded so they are not re-asked):** selection heuristics live in the task-instruction prompt, not a formal skill; a separate `MusicContext` (not an extension of the tool-less `ContextPack`); resolve latency is accepted as a small gap (real look-ahead is spec 04).
