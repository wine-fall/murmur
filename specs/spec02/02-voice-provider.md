# spec/02 · voice-provider — TTS as a warm, hot-swappable sidecar

> **Status**: Implemented (sidecar + client) — real voice pending hands-on acceptance.
>   - **steps 1–2 (done)**: standardized adapter boundary (`SynthesisRequest` §3.5), JSON-lines-over-stdio sidecar (`python -m murmur.voice.sidecar`) with a `TtsBackend` interface + no-model `FakeBackend`, and the supervising `SidecarVoiceProvider` (spawn/wait-for-ready, restart-on-death + retry, synth-timeout kills the proc to avoid pipe desync). `build_voice`: `stub` / `qwen3` / `sidecar-fake`; `--voice` flag. Verified by 63 unit tests + a real two-process end-to-end run on `sidecar-fake`. Acceptance §3 (kill→recover) and §4 (hot-swap) are covered by the `sidecar-fake` path.
>   - **step 3 (code in place, not yet verified)**: a **thin generic `MlxAudioBackend`** over `mlx-audio` (optional `tts-mlx` extra; lazy-imported) + a **profile registry** wiring the backends — `spark` (primary), `qwen3`, `chatterbox`, `dia`, plus the post-L0 `voxcpm2` candidate (§3.3). The deterministic layer (request→`generate` kwarg mapping, profile merge, backend selection) is unit-tested with a fake model; real model load/synth is a parametrized tagged integration test (`pytest -m integration`). Acceptance §5.1 ("sounds clearly human") / §5.2 ("warm") + the blind A/B among the candidates gate on a hands-on Mac run (install the extra, download models, judge by ear) — the agent cannot self-verify a voice.
> **Part**: The `VoiceProvider` implementation + the warm TTS sidecar + the first adapter. See master [`../DESIGN.md`](../DESIGN.md) §3.5 (TTS = soul, pluggable, warm sidecar), §4 (architecture).
> **Milestone**: L0 (01+02 = the first audible version).
> **Conventions**: English; written for a coding agent. Design-level — mechanism and contracts, not final code.

---

## 1. Goal & scope

### Delivers
1. A concrete implementation of the `VoiceProvider` Protocol declared in [`01-core-loop.md`](../spec01/01-core-loop.md) §2.2.
2. A **warm TTS sidecar process** that keeps the model loaded between utterances and is crash-isolated from the core (master §3.5 rationale).
3. The **first adapter: Qwen3-TTS** (MLX on Apple Silicon) — chosen for L0 because it is the only candidate that runs **real-time on Mac** (master §3.5), so the loop feels live.
4. A clean adapter boundary with **standardized I/O** (§3.5 `SynthesisRequest`) so the other candidates (CosyVoice2, Chatterbox, Fish-Audio/OpenAudio S1) drop in by writing one `TtsBackend` — no protocol or core change. The boundary is designed for the whole pool up front, not retrofitted per model.

### Out of scope
- Choosing the *final* primary voice — that is a later blind A/B (master §8 "committed, deferred"). L0 ships Qwen3-TTS as the working default; this spec makes swapping trivial, it does not pick the winner.
- Scenario split (fast vs. warm voice) beyond accepting the `scenario` arg — wiring different models per scenario is deferred (master §3.5); L0 honors one voice.
- Streaming/partial TTS — L0 renders a complete clip per segment (see §3.4). Streaming is a later optimization, related to spec 04.
- Voice cloning — a candidate capability (master §3.5). The boundary **reserves the slot** (`reference_audio`/`reference_text`, §3.5) so a cloning backend drops in without a contract change, but L0 does **not** wire cloning — Qwen3-TTS speaks with preset voices.

### Amended (2026-07) — remote (off-machine) backend
A **remote TTS backend** is now in scope as a config-selected `VoiceProvider`
adapter (§3.6): the model runs on another machine and murmur calls it over HTTP.
This **deliberately relaxes** master DESIGN's "only two network hops / TTS stays
on-device" invariant — a remote TTS is a third hop. Rationale: heavier / higher-
quality models (fish-speech / OpenAudio S1, …) run better on a dedicated box, and
moving TTS off the Mac sidesteps the local MLX generation-memory spike. **Local
(`spark` sidecar) stays the default; remote is strictly opt-in via config.** This
is a distribution-phase direction (master §3.7 "at distribution, re-evaluate
paid/licensed models"), pulled forward as an option — not the new default.

---

## 2. Contract / seam

Implements [`01`](../spec01/01-core-loop.md) §2.2 `VoiceProvider` exactly:
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

### 3.3 Backends — a thin MLX layer over the candidate models (Spark primary)
L0 wires **four** TTS backends, all on Apple Silicon via **`mlx-audio`** (the Mac
hub for these models, master §3.5); **VoxCPM2** (OpenBMB) was added post-L0 as a
fifth blind-A/B candidate (§5). Because all of them share one runtime and one
`load_model(repo) → model.generate(text, …)` API, they are served by a **single
generic `MlxAudioBackend`** parameterized by a per-model **profile** — not one
class per model. This is the "thin middle layer": the model-specific differences
collapse into a config profile + the `params` escape hatch (§3.5).

| backend name | HF repo (mlx-community) | size | lang | why |
|---|---|---|---|---|
| **`spark`** (primary) | `Spark-TTS-0.5B-bf16` | 0.5B | zh/en | best Chinese by ear so far; small → real-time. Note: 16 kHz output. |
| `qwen3` | `Qwen3-TTS-12Hz-0.6B-Base-bf16` | 0.6B | multi (zh) | 24 kHz; voice presets / voice-design. |
| `chatterbox` | `chatterbox-fp16` | ~0.5B | multi (en-strong) | expressive, emotion-exaggeration control. |
| `dia` | `Dia-1.6B-fp16` | 1.6B | en | ultra-real dialogue/emotion (English wildcard). |
| `voxcpm2` | `VoxCPM2-8bit` | 2B | multi (zh) | tokenizer-free, 48 kHz native (confirmed); strong naturalness + long-form continuation + native streaming (`generate_streaming`). Heaviest — **measured RTF ≈ 1.6 on M3 Pro / 8bit** (whole-clip, warm), i.e. slower than real-time → a **quality-reference / pre-generated** candidate, **not** the real-time default. 8bit for the A/B; drop to `VoxCPM2-4bit` if RTF must improve. |

- Repo ids are the L0 defaults and **confirmed on first hands-on run** (they can shift; §6). All are open-weight and local; licensing is per the **two-phase model strategy** (master §3.7) — any good open model is fair game during local experimentation, and the *distributable* voice is a paid/licensed choice made at distribution time (so e.g. Spark's CC-BY-NC is fine to experiment with now, not a commitment to ship).
- The sidecar loads the selected model at `start()` and warms it with one throwaway synth so the first real `synthesize` is fast.
- Output: a mono wav at the model's native sample rate, written to a temp path; that path becomes `AudioClip.source`.
- The choice of primary voice is still a **blind A/B by ear** (master §8/§10.3), now over these four; Spark leads going in.

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
`synthesize(req: SynthesisRequest) -> audio_path: str`. A backend reads the
fields it supports and ignores the rest.

**The thin middle layer — one generic backend + a profile registry.** Because
the L0 models plus the VoxCPM2 candidate (§3.3) all run on `mlx-audio` through the same
`load_model(repo) → model.generate(text, …)` API, they are **not** four classes
— they are **one `MlxAudioBackend`** whose only per-model state is a **profile**:
```python
@dataclass(frozen=True)
class MlxProfile:            # one row per model; adding a model = adding a row
    repo: str                # HF repo id (mlx-community/…)
    voice: str | None = None
    language: str | None = None
    default_params: dict = field(default_factory=dict)
```
`MlxAudioBackend.synthesize` merges the profile defaults with the incoming
`SynthesisRequest` (request wins), maps them to `generate()` kwargs, renders the
whole clip (§3.4), and writes the wav. The registry (`spark`/`qwen3`/`chatterbox`/`dia`/`voxcpm2`)
lives in one place; `build_backend(name)` looks up the profile and constructs the
one backend. A future non-MLX model (e.g. a PyTorch CosyVoice2/Fish for
pre-generation) would be a *separate* `TtsBackend` in its own process/env, but the
core contract and IPC are still unchanged.

- **Zero-shot voice cloning** (`reference_audio` / `reference_text`) stays a *designed-for axis*, **not wired in L0** — L0 uses preset voices. The slot exists so a cloning backend needs no contract change.
- `config` (01 §3.1) selects the backend by name; the profile supplies the per-model defaults used (with the core's `synthesize(text, scenario=…)` call) to build the `SynthesisRequest`. The core contract and IPC are unchanged when swapping backends — proven by hot-swapping among the candidates.

### 3.6 Remote backend (off-machine TTS) — a `VoiceProvider` adapter, not a sidecar
The remote backend is a **new `VoiceProvider` adapter** (`RemoteVoiceProvider`),
**not** a `TtsBackend` inside the sidecar: there is no local model or subprocess,
so it sits beside `SidecarVoiceProvider` on the **same seam** (`start` /
`synthesize` / `aclose` → `AudioClip`). The core and Director are unchanged; only
`build_voice` gains a branch and `config` gains the endpoint fields.

- **Selection & config (no code edits per swap):** `voice_provider="remote"`
  (or `--voice remote`). Endpoint config comes from env so a URL/key is never
  hardcoded: `MURMUR_TTS_URL`, `MURMUR_TTS_REFERENCE_ID` (the server-side saved
  voice), `MURMUR_TTS_API_KEY` (optional bearer), `MURMUR_TTS_SEED` (optional).
  Switch back to local by setting `voice_provider` to `spark`.
- **Voice pinning:** fish-speech has no preset voice library — with neither a
  `reference_id` nor a fixed `seed`, every `/v1/tts` call samples a fresh timbre
  (the voice changes line to line). `MURMUR_TTS_SEED` pins the sampled voice so a
  run keeps one consistent voice; a registered `reference_id` is the stronger,
  cross-text-stable option once a reference is saved server-side.
- **Wire protocol — fish-speech native `/v1/tts`** (the chosen server): `POST`
  a JSON body (`text`, `reference_id`, `format:"wav"`, `streaming:false`,
  `normalize:true`, and the sampling defaults) with `content-type:
  application/json` (+ `authorization: Bearer` when a key is set); the response
  body is the complete wav, written to a temp file → `AudioClip(kind="talk")`.
  The fish server accepts JSON as well as msgpack, so this needs **no extra
  serialization dependency** — stdlib `json` + `urllib` (the blocking call runs
  in `asyncio.to_thread` to keep the seam async). The request sends a **named
  `User-Agent`**: a Cloudflare-fronted deployment blocks urllib's default
  `Python-urllib/*` UA with a 403 bot rule. When the endpoint sits behind
  Cloudflare Access, auth is the operator's concern (a WARP-enrolled host, or a
  service token) — not baked into the adapter.
- **Protocol is per-adapter, not universal:** this adapter speaks fish-speech's
  API. A different server (OpenAI-compatible `/v1/audio/speech`, etc.) is another
  small adapter on the same seam — the seam does not try to be one universal
  client.
- **`start()`** is a lightweight readiness check (the remote is already warm);
  **`aclose()`** is a no-op (no owned process). `synthesize` reuses the existing
  `synth` timing/log event.

---

## 4. Dependencies
- [`01-core-loop.md`](../spec01/01-core-loop.md) — owns the `VoiceProvider`/`AudioClip` contract this implements.
- External (Mac): MLX + `mlx-audio` (one optional extra `tts-mlx` covers all the MLX backends) + each model's weights (downloaded once from HF/ModelScope). No network **at inference time** (local models) — consistent with master §3.1 ("only network hops: inference + music"; TTS is local). The weight download is one-time setup, not a runtime hop.

---

## 5. Acceptance criteria
1. With the sidecar started, `synthesize("…")` returns an `AudioClip` the core can play, and the speech sounds **clearly human** (not robotic `say`-tier) — the L0 bar for "soul."
2. The model is **warm**: the second and later `synthesize` calls do **not** reload the model; per-call latency is small enough that the talk loop feels live on the target Mac.
3. Killing the sidecar process does **not** crash the core; the core reports the failure and recovers (restart) on the next call.
4. Switching the configured backend name (`spark`/`qwen3`/`chatterbox`/`dia`/`voxcpm2`) changes the voice **without any change to spec-01 code** (proves the hot-swap seam) — the thin `MlxAudioBackend` + profile registry serve them all.
5. **Blind A/B among the candidates** (master §10.3 eval track): render the same Chinese line through each and pick the primary by ear. `spark` leads going in; watch its 16 kHz output against `qwen3`'s 24 kHz and `voxcpm2`'s 48 kHz (VoxCPM2 is the quality contender but ~3× slower — judge whether its naturalness earns the latency, or only for pre-generated segments).

---

## 6. Open questions
- ~~IPC transport: localhost HTTP vs JSON-lines-over-stdio~~ **Resolved (§3.2): JSON-lines over stdio** — no port, no extra dependency, fastest to stand up, reuses the supervised-subprocess pattern. Revisit only if latency forces shared-memory/streamed PCM (tied to spec 04).
- Audio handoff: file-path (chosen for L0) vs shared-memory/streamed PCM (lower latency, needed if/when streaming TTS lands in spec 04).
- Exact mlx-community repo ids + per-model `generate` kwargs (voice presets, Dia's `[S1]/[S2]` speaker tags, Chatterbox `exaggeration`/`cfg`, Spark gender/pitch): the §3.3 repos are best-effort defaults, confirmed/tuned on the first hands-on run. Each maps onto `SynthesisRequest` fields + `params`; the profile registry absorbs the per-model differences.
- Exact Qwen3-TTS voice/preset selection and any Chinese/English voice mapping — deferred to first hands-on run.
- **VoxCPM2 quant**: candidate wired at `mlx-community/VoxCPM2-8bit` (~3.2 GB disk, ~4–5 GB resident on the target 18 GB Mac). 8bit is deliberate — the blind A/B should hear the model near full quality; `VoxCPM2-4bit` (~2.3 GB) is the fallback only if real-time RTF on M3 Pro forces it. Resolved for now; revisit after the hands-on RTF check.
- ~~**VoxCPM2 mlx-audio load risk** ([Blaizzy/mlx-audio#649](https://github.com/Blaizzy/mlx-audio/issues/649))~~ **Resolved by smoke**: the installed `mlx-audio` loads `voxcpm2` fine (only a benign `transformers` model_type warning) and synthesizes a real 48 kHz wav through the standard seam — verified via a throwaway `scratch/` smoke, and covered on-demand by `test_mlx_backend_renders_a_real_nonempty_wav[voxcpm2]` (`pytest -m integration`). Re-check only if the pinned `mlx-audio` version changes.
