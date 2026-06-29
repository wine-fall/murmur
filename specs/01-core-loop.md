# spec/01 · core-loop — the L0 single-process spine

> **Status**: In progress. Built in 3 steps — **steps 1–2 done**; step 3 pending.
>   - **step 1 (done)**: scaffold + all contracts/data types (§2) + in-process `MemoryStore` + stub `VoiceProvider` + `StubBrain` + simulated `AudioPlayer` + autonomous talk loop. Runs end-to-end against the stub voice with no spec-02 code (criterion §5), paced, clean Ctrl-C shutdown. Package under `src/murmur/`, entry `murmur` / `python -m murmur`.
>   - **step 2 (done)**: real `ClaudeBrain` on `claude-agent-sdk` (subscription-OAuth, no API key, `claude-opus-4-8`), swapped in behind the same two-method contract via a `brain_provider` config knob (`"claude"` default / `"stub"` fake); `build_brain` factory; `--brain` flag. Verified by a live smoke test (real subscription call) + the stub loop regression (no network). First third-party dependency. Voice is still the stub — real TTS is spec 02.
>   - **step 3 (pending)**: real `AudioPlayer` (external-player subprocess + `stop()` terminates it) + typed talk-back via `cli_host` stdin + cancel-and-resume interjection (§3.3 `input_task`) + `/quit`. Completes criteria §1–§4 audibly once spec 02's voice is wired.
> **Part**: The orchestrator spine for milestone **L0** (talk-only radio). See master [`../DESIGN.md`](../DESIGN.md) §4 (architecture), §9 (L0 definition), §10 (build order).
> **Milestone**: L0 (with [`02-voice-provider.md`](02-voice-provider.md), 01+02 = the first runnable, audible version).
> **Conventions**: English; written for a coding agent. Design-level — mechanism and contracts, not final code.

---

## 1. Goal & scope

### Delivers
A single long-running Python `asyncio` process that:
1. Loads a **static persona** (a System Prompt seed) at startup.
2. Runs an **autonomous talk loop**: repeatedly asks the Brain for a short talk segment, speaks it via a `VoiceProvider`, and continues — with a natural pause between segments.
3. Accepts **typed input** at any time; on input it interrupts playback, has the Brain respond, speaks the response, then resumes the program.
4. Can be **stopped cleanly**.
5. **Declares the outbound interface contracts** (`VoiceProvider`, `MusicProvider`, `MemoryStore`) that later specs implement — so parts stay decoupled and buildable in order.

### Out of scope (explicit non-goals for this spec)
- TTS model integration — `VoiceProvider` is **declared here, implemented in [`02`](02-voice-provider.md)**. L0 imports the spec-02 adapter; this spec does not contain TTS code.
- Music — `MusicProvider` is declared but **not instantiated or called** in L0 (spec 03).
- Persistent memory — L0 uses an **in-process** `MemoryStore`; persistence is spec 05.
- No-dead-air look-ahead (spec 04), onboarding/persona evolution (06), proactive "turn to you" / time anchors / activity pacing (07), full token economy (08), ASR, GUI.
- Daemon/detach (radio surviving terminal close) — explicitly a later optional side-spec, not here.

---

## 2. Contracts / seams

These Protocols are **owned by this spec** (the core is the consumer). Implementations land in the specs noted. Keep signatures stable; downstream specs may *extend* but must not break them.

### 2.1 Data types
```python
@dataclass(frozen=True)
class AudioClip:
    """An opaque, playable audio handle. L0 representation: a path to a
    complete audio file on local disk (e.g. a wav under the scratchpad/temp dir).
    Producers (VoiceProvider, later MusicProvider) write the file and return this.
    The AudioPlayer consumes it opaquely — it only needs `source` and `kind`."""
    source: str          # local file path (L0); may be a stream URL once spec 03 lands
    kind: str            # "talk" | "music"

@dataclass(frozen=True)
class Turn:
    """One unit of program/conversation history."""
    role: str            # "radio" (it spoke) | "user" (you typed)
    text: str

@dataclass(frozen=True)
class ContextPack:
    """The compact context handed to the Brain per call (master §6).
    L0 fields only; spec 05/07 add profile/ledger/time/activity fields."""
    persona: str
    recent: list[Turn]
```

### 2.2 `VoiceProvider` — implemented in spec 02
```python
class VoiceProvider(Protocol):
    async def start(self) -> None: ...
    """Bring the backend to a warm, ready state (e.g. load + warm the TTS
    sidecar). Idempotent. Called once at core startup."""

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip: ...
    """Render `text` to a complete AudioClip(kind="talk"). `scenario` lets the
    core request a fast vs. warm voice (master §3.5 'split by scenario');
    L0 always passes the default. Must be safe to call repeatedly on the warm backend."""

    async def aclose(self) -> None: ...
    """Release the backend / shut down the sidecar."""
```

### 2.3 `MusicProvider` — declared only; implemented in spec 03
```python
class MusicProvider(Protocol):
    async def start(self) -> None: ...
    async def resolve(self, query: str) -> AudioClip: ...   # AudioClip(kind="music")
    async def aclose(self) -> None: ...
```
L0 ships **no implementation** and never constructs one. Declared so the Director's segment-selection has a typed extension point. Spec 03 owns the real contract detail (it may widen `resolve`).

### 2.4 `MemoryStore` — implemented in-process here; persistent impl in spec 05
```python
class MemoryStore(Protocol):
    def record(self, turn: Turn) -> None: ...
    def recent(self, n: int) -> list[Turn]: ...
```
L0 implementation: an in-memory list bounded to the last N turns. Spec 05 adds the persistent three-tier store behind the same Protocol.

---

## 3. Design

### 3.1 Process & module shape
One `asyncio` process, launched as `murmur` (console entry point / `python -m murmur`). Modules, each single-purpose:

| Module | Responsibility |
|---|---|
| `cli_host` | Render "now playing" + program text to the terminal; read keyboard lines from stdin (async); own the manual-stop signal. |
| `director` | The program loop: decide and produce the next segment (L0: always a talk segment), drive synth→play, pace with an inter-segment gap, and arbitrate user interjections. |
| `brain` | Wrap `claude-agent-sdk` (master §3.2: subscription-OAuth, no API key; model `claude-opus-4-8`). Produce talk-segment text and user responses from a `ContextPack`. |
| `audio_player` | Sole audio authority. Play one `AudioClip` at a time; support stop/cancel. |
| `persona` | Load the static persona System Prompt from a config-specified file at startup. |
| `memory` | L0 in-process `MemoryStore`. |
| `config` | Provider selection, persona file path, cadence gap, model ids, recent-window size. |

### 3.2 Brain contract (claude-agent-sdk)
```python
class Brain:
    async def next_talk(self, ctx: ContextPack) -> str: ...
    """Generate the next short, self-contained talk-segment script: pick or
    continue a topic and chat, per the persona. Self-initiated — not a reply."""

    async def respond(self, user_text: str, ctx: ContextPack) -> str: ...
    """Respond in-persona to a typed user line, then the program resumes."""
```
- Persona is injected as the **System Prompt**; `ctx.recent` is sent as prior turns. The API is stateless — the core resends the compact context each call (master §6).
- Model `claude-opus-4-8` for L0. Tiered models (cheap filler on `claude-haiku-4-5`) are deferred to spec 08.
- **Resolved (step 2)**: uses the SDK's one-shot `query(prompt=..., options=ClaudeAgentOptions(...))` — explicitly *stateless* per the SDK, so it matches "resend the compact context each call." Per call: `system_prompt = ctx.persona` (a custom string, which replaces the `claude_code` preset); `model = claude-opus-4-8`; `max_turns=1`. **Full isolation from the user's local Claude Code environment** (the radio must not be influenced by their `CLAUDE.md`, plugins/skills, MCP servers, hooks, or subagents): `setting_sources=[]` (no user/project/local settings — verified to strip the user's plugins, MCP, and hooks), `allowed_tools=[]` + `tools=[]` (no tools loaded or invokable), `skills=[]` + `extra_args={"disable-slash-commands": None}` (no skills/commands), `mcp_servers={}`. Subscription OAuth is preserved (`apiKeySource = none`). Verified against the SDK init payload. (Residual: built-in agent *type* definitions still appear in metadata but are inert — with no tools there is no Task tool to launch them.) Reply text is collected from `AssistantMessage` `TextBlock`s. Subscription-OAuth is inherited automatically from the local Claude Code login (no API key) by the SDK shelling out to the `claude` CLI. (The spec fixes only the two-method contract + the auth/model facts from master §3.2; the above is the resolved mechanism, kept here to keep spec and code aligned.)
- **Prompt text is centralized** in `src/murmur/prompts/` (English; DESIGN §0): `persona_seed.md` (the static System Prompt) and `talk.py` (the `next_talk` / `respond` instruction templates + transcript rendering). `brain.py` holds only Brain mechanics and imports the builders. `Config.persona_path` defaults to the bundled seed.

### 3.3 Control flow (the loop + interruption)
Two concurrent tasks over a shared state, single event loop:

- **`director_task`** (the program):
  1. Build `ContextPack` (persona + `memory.recent(n)`).
  2. `text = await brain.next_talk(ctx)`.
  3. `clip = await voice.synthesize(text)`.
  4. `await player.play(clip)` — awaits until the clip finishes **or** is cancelled by an interjection.
  5. `memory.record(Turn("radio", text))`.
  6. Pause for the configured inter-segment gap (cancellable).
  7. Loop.
- **`input_task`**: read keyboard lines from stdin. On a line:
  1. Signal interjection → `await player.stop()` (cancels the current `play`/gap).
  2. `memory.record(Turn("user", line))`.
  3. `reply = await brain.respond(line, ctx)` → `clip = await voice.synthesize(reply)` → `await player.play(clip)` → `memory.record(Turn("radio", reply))`.
  4. Hand control back to `director_task`, which resumes the program from step 1.

**Arbitration invariant**: user turns take priority over the program; only one segment is "on air" at a time; `audio_player` is the only thing that emits sound. A clean abstraction for this (implementation choice): the Director awaits an `asyncio.Event`/queue for input that can cancel the in-flight `play()` task.

### 3.4 Pacing & token restraint (L0 minimum, master §9.2)
- **One Brain call per talk segment** (no batching yet — spec 08).
- A configurable **inter-segment gap** so output is a paced program, not a firehose.
- These two bound the talk rate so testing doesn't drain the subscription. Full economy (batch/cache/tier/gate) is spec 08.

### 3.5 Audio playback (L0)
- `audio_player` plays a complete local audio file (the `AudioClip.source`) by handing it to an external audio player subprocess; `stop()` terminates that subprocess. (Concrete player binary — e.g. `afplay`/`ffplay`/`mpv` — is an implementation choice; macOS-native is fine for L0.)
- No mixing/ducking in L0 (only one talk clip plays at a time). Ducking arrives with music (spec 03).

### 3.6 Stop
- Ctrl-C and/or a typed `/quit` command performs an orderly shutdown: stop playback, `await voice.aclose()`, exit.

---

## 4. Dependencies
- **None** among sub-specs for the orchestration skeleton — but L0 is only *audible* once [`02-voice-provider.md`](02-voice-provider.md) provides a real `VoiceProvider`. Build 01 against a trivial stub `VoiceProvider` (e.g. one that writes a silent/placeholder clip) to exercise the loop, then drop in spec 02.
- External: `claude-agent-sdk`; the user has logged into Claude Code CLI (master §3.2).

---

## 5. Acceptance criteria (feature level — mirrors master §9.3)
1. Launching `murmur` makes it **start speaking on its own** (with the spec-02 voice), without the user typing first.
2. Segments come one after another with a **natural, configurable pace** — neither a firehose nor awkward long dead air.
3. Typing a line **interrupts**, gets an in-persona reply, and then the program **resumes**.
4. The process **stops cleanly** (Ctrl-C or `/quit`), shutting down the voice backend.
5. The loop runs end-to-end against a **stub `VoiceProvider`** with no spec-02 code present (proves the seam).

---

## 6. Open questions
- Persona seed file format & location (Markdown vs plain text; path under the project or a config dir). Default proposal: a single Markdown file path in config.
- Terminal UX richness: plain `print`/stdin for L0, or a TUI (master mentions TUI as the front-end surface). Proposal: plain async stdin for L0; the TUI is a later front-end refinement, now its own sub-spec [`10-tui.md`](10-tui.md), which swaps in behind the same CLI Host seam.
- Exact interjection mechanism (cancel-and-resume vs. queue-after-current). Proposal: cancel-and-resume (model C feel), but confirm during implementation.
