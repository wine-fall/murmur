# spec/02 · voice-provider — TTS as a warm, hot-swappable sidecar

> **Status**: Design. Not yet implemented.
> **Part**: The `VoiceProvider` implementation + the warm TTS sidecar + the first adapter. See master [`../DESIGN.md`](../DESIGN.md) §3.5 (TTS = soul, pluggable, warm sidecar), §4 (architecture).
> **Milestone**: L0 (01+02 = the first audible version).
> **Conventions**: English; written for a coding agent. Design-level — mechanism and contracts, not final code.

---

## 1. Goal & scope

### Delivers
1. A concrete implementation of the `VoiceProvider` Protocol declared in [`01-core-loop.md`](01-core-loop.md) §2.2.
2. A **warm TTS sidecar process** that keeps the model loaded between utterances and is crash-isolated from the core (master §3.5 rationale).
3. The **first adapter: Qwen3-TTS** (MLX on Apple Silicon) — chosen for L0 because it is the only candidate that runs **real-time on Mac** (master §3.5), so the loop feels live.
4. A clean adapter boundary so the other candidates (CosyVoice2, Chatterbox, OpenAudio-S1) drop in by config without touching the core.

### Out of scope
- Choosing the *final* primary voice — that is a later blind A/B (master §8 "committed, deferred"). L0 ships Qwen3-TTS as the working default; this spec makes swapping trivial, it does not pick the winner.
- Scenario split (fast vs. warm voice) beyond accepting the `scenario` arg — wiring different models per scenario is deferred (master §3.5); L0 honors one voice.
- Streaming/partial TTS — L0 renders a complete clip per segment (see §3.4). Streaming is a later optimization, related to spec 04.
- Voice cloning — a candidate capability (master §3.5), not required for L0.

---

## 2. Contract / seam

Implements [`01`](01-core-loop.md) §2.2 `VoiceProvider` exactly:
```python
async def start(self) -> None        # launch + warm the sidecar; idempotent
async def synthesize(self, text, *, scenario="broadcast") -> AudioClip   # kind="talk"
async def aclose(self) -> None       # shut the sidecar down
```
`synthesize` returns an `AudioClip` (01 §2.1) whose `source` is a path to a complete audio file on local disk written by the sidecar (e.g. a wav under the scratchpad/temp dir). The core consumes it opaquely.

---

## 3. Design

### 3.1 Two-process split
- **Core** (spec 01) holds a `VoiceProvider` client object.
- **Sidecar**: a separate Python process that loads the TTS model once and serves synthesis requests. *Why separate* (master §3.5): model load is slow (seconds, several GB); keep it **warm**; a TTS crash must not take down the radio brain; the process boundary is the cleanest place to hot-swap backends.
- The `VoiceProvider` client owns the sidecar's lifecycle: `start()` spawns it and blocks until it reports **ready** (model loaded + warmed with a throwaway synth); `aclose()` terminates it. The client **supervises** the sidecar: if it dies, restart on next `synthesize` (or eagerly) and surface a clear error rather than hanging the core.

### 3.2 Sidecar interface (local IPC)
A minimal local request/response over a localhost transport. Recommended: a small **localhost HTTP** endpoint or a **JSON-lines-over-stdio** protocol — pick one in implementation; HTTP is easier to probe/health-check, stdio avoids a port. Logical contract, transport-agnostic:
- `synthesize(text: str, scenario: str) -> { audio_path: str }` (sidecar writes the file, returns its path).
- `health() -> { ready: bool }`.
Keep the payload tiny (text in, file path out) — do not stream audio bytes over the IPC in L0.

### 3.3 First adapter — Qwen3-TTS (MLX)
- Run Qwen3-TTS on Apple Silicon via the MLX path (the `mlx-audio` ecosystem is the Mac hub for these models, master §3.5 research). Apache-2.0; ~6 GB peak; sub-100ms-class streaming-capable, but L0 uses whole-clip render (§3.4).
- The sidecar loads this model at `start()` and warms it with one throwaway synthesis so the first real `synthesize` is fast.
- Output: a mono wav at the model's native sample rate, written to a temp path; that path becomes `AudioClip.source`.

### 3.4 Whole-clip render (L0)
A talk segment is a few seconds of speech. L0 renders the **complete** clip, then the core plays it. No streaming TTS, no partial playback. (This is why small inter-segment gaps are acceptable in L0 — master §9.2; look-ahead pre-generation to hide synth latency is spec 04.)

### 3.5 Adapter boundary (hot-swap)
- Define an internal `TtsBackend` interface inside the sidecar: `load()`, `warm()`, `synthesize(text, scenario) -> audio_path`.
- Each candidate (Qwen3-TTS now; CosyVoice2 / Chatterbox / OpenAudio-S1 later) is one `TtsBackend`.
- `config` (01 §3.1) selects the backend by name; the core and the sidecar protocol are unchanged when swapping. Per master §8, personal use means non-commercial-licensed backends (CosyVoice2 etc.) are fine to add later.

---

## 4. Dependencies
- [`01-core-loop.md`](01-core-loop.md) — owns the `VoiceProvider`/`AudioClip` contract this implements.
- External (Mac): MLX + `mlx-audio` + the Qwen3-TTS weights. No network at inference time (local model) — consistent with master §3.1 ("only network hops: inference + music"; TTS is local).

---

## 5. Acceptance criteria
1. With the sidecar started, `synthesize("…")` returns an `AudioClip` the core can play, and the speech sounds **clearly human** (not robotic `say`-tier) — the L0 bar for "soul."
2. The model is **warm**: the second and later `synthesize` calls do **not** reload the model; per-call latency is small enough that the talk loop feels live on the target Mac.
3. Killing the sidecar process does **not** crash the core; the core reports the failure and recovers (restart) on the next call.
4. Switching the configured backend name changes the voice **without any change to spec-01 code** (proves the hot-swap seam) — even if only one backend is fully wired in L0.

---

## 6. Open questions
- IPC transport: localhost HTTP vs JSON-lines-over-stdio (see §3.2). Proposal: start with whichever is faster to stand up; revisit if latency matters.
- Audio handoff: file-path (chosen for L0) vs shared-memory/streamed PCM (lower latency, needed if/when streaming TTS lands in spec 04).
- Exact Qwen3-TTS voice/preset selection and any Chinese/English voice mapping — deferred to first hands-on run.
