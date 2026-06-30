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
4. A clean adapter boundary with **standardized I/O** (§3.5 `SynthesisRequest`) so the other candidates (CosyVoice2, Chatterbox, Fish-Audio/OpenAudio S1) drop in by writing one `TtsBackend` — no protocol or core change. The boundary is designed for the whole pool up front, not retrofitted per model.

### Out of scope
- Choosing the *final* primary voice — that is a later blind A/B (master §8 "committed, deferred"). L0 ships Qwen3-TTS as the working default; this spec makes swapping trivial, it does not pick the winner.
- Scenario split (fast vs. warm voice) beyond accepting the `scenario` arg — wiring different models per scenario is deferred (master §3.5); L0 honors one voice.
- Streaming/partial TTS — L0 renders a complete clip per segment (see §3.4). Streaming is a later optimization, related to spec 04.
- Voice cloning — a candidate capability (master §3.5). The boundary **reserves the slot** (`reference_audio`/`reference_text`, §3.5) so a cloning backend drops in without a contract change, but L0 does **not** wire cloning — Qwen3-TTS speaks with preset voices.

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
A minimal local request/response. **Resolved: JSON-lines over stdio** (one JSON
object per line; core writes a request line to the sidecar's stdin, reads a
response line from its stdout). Chosen over localhost HTTP because it needs no
port and no extra dependency, is the fastest to stand up, and reuses the
supervised-subprocess pattern the core already has for `AudioPlayer`. Logical
contract:
- request `{"op": "synthesize", "request": <SynthesisRequest>}` → response `{"audio_path": str}` (sidecar writes the file, returns its path). The `request` object is the standardized `SynthesisRequest` (§3.5) — `text` plus optional cross-model fields and a `params` escape hatch.
- request `{"op": "health"}` → response `{"ready": bool}`.
- on failure the sidecar returns `{"error": str}` on the same line (the client raises, never hangs).

**stdout is the protocol channel and must stay clean**: the model/library
(MLX, mlx-audio) and all sidecar logging go to **stderr**, never stdout. Keep
the payload tiny (text in, file path out) — do not stream audio bytes over the
IPC in L0.

### 3.3 First adapter — Qwen3-TTS (MLX)
- Run Qwen3-TTS on Apple Silicon via the MLX path (the `mlx-audio` ecosystem is the Mac hub for these models, master §3.5 research). Apache-2.0; ~6 GB peak; sub-100ms-class streaming-capable, but L0 uses whole-clip render (§3.4).
- The sidecar loads this model at `start()` and warms it with one throwaway synthesis so the first real `synthesize` is fast.
- Output: a mono wav at the model's native sample rate, written to a temp path; that path becomes `AudioClip.source`.

### 3.4 Whole-clip render (L0)
A talk segment is a few seconds of speech. L0 renders the **complete** clip, then the core plays it. No streaming TTS, no partial playback. (This is why small inter-segment gaps are acceptable in L0 — master §9.2; look-ahead pre-generation to hide synth latency is spec 04.)

### 3.5 Adapter boundary (hot-swap) — standardized I/O so backends drop in without churn
The boundary is designed **once** to fit the whole candidate pool, so wiring
Qwen3-TTS now and adding CosyVoice2 / Chatterbox / Fish-Audio(OpenAudio S1)
later is "write one `TtsBackend`," never a protocol/core change.

**Standardized input — `SynthesisRequest`** (a frozen dataclass; the single
input to both the IPC `synthesize` op and `TtsBackend.synthesize`). Cross-model
common axes are first-class fields; model-idiosyncratic knobs go in `params`:
```python
@dataclass(frozen=True)
class SynthesisRequest:
    text: str                          # required — what to speak
    voice: str | None = None           # preset timbre / speaker id (Qwen3 voices, CosyVoice SFT speakers)
    language: str | None = None        # language tag (Chatterbox language_id, CosyVoice cross-lingual)
    reference_audio: str | None = None # path to a reference clip for zero-shot voice cloning
    reference_text: str | None = None  # transcript of the reference clip (CosyVoice2 / Fish need it)
    style: str | None = None           # natural-language emotion/instruction (CosyVoice2 instruct, OpenAudio markers)
    params: dict = field(default_factory=dict)  # model-specific escape hatch: speed, exaggeration, cfg_weight, temperature, top_p, repetition_penalty, ...
```
**Standardized output**: a path to a complete mono wav on local disk (→
`AudioClip.source`). Uniform across all backends.

**`TtsBackend` interface** (inside the sidecar): `load()`, `warm()`,
`synthesize(req: SynthesisRequest) -> audio_path: str`. Each candidate is one
`TtsBackend` that reads the fields it supports and ignores the rest.

- The candidate pool (master §3.5): **Qwen3-TTS** (wired in L0); **CosyVoice2**, **Chatterbox Multilingual V3**, **Fish-Audio local = OpenAudio S1 / fish-speech** drop in later. Per master §8, personal use means non-commercial-licensed backends are fine.
- **Zero-shot voice cloning** (CosyVoice2 / Chatterbox / Fish) is a *designed-for axis* of the boundary (`reference_audio` / `reference_text`), **not wired in L0** — Qwen3-TTS uses preset voices. The slot exists so adding a cloning backend needs no contract change.
- `config` (01 §3.1) selects the backend by name and supplies the per-backend defaults (which `voice`, `language`, `reference_audio`, default `params`) used to build the `SynthesisRequest` from the core's `synthesize(text, scenario=...)` call. The core contract and the IPC protocol are unchanged when swapping backends.

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
- ~~IPC transport: localhost HTTP vs JSON-lines-over-stdio~~ **Resolved (§3.2): JSON-lines over stdio** — no port, no extra dependency, fastest to stand up, reuses the supervised-subprocess pattern. Revisit only if latency forces shared-memory/streamed PCM (tied to spec 04).
- Audio handoff: file-path (chosen for L0) vs shared-memory/streamed PCM (lower latency, needed if/when streaming TTS lands in spec 04).
- Exact Qwen3-TTS voice/preset selection and any Chinese/English voice mapping — deferred to first hands-on run.
