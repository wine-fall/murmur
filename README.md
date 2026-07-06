# murmur

**A fully-local companion radio — "a radio that broadcasts for an audience of one," with Claude as its brain.**

murmur is always on the air. It finds a topic and chats with you on its own, plays a song, comes back and keeps going; at the right times it says good morning / good night. It's *mostly broadcasting*, but occasionally turns to you and asks something — if you don't engage, it gracefully slides back into the program. It has a **persona that grows**: seeded up front, then it learns you as it keeps you company. You talk to it with the **keyboard**; it answers with a **voice that sounds human**.

Existing tools are either "voice-control Claude to write code" or message-driven assistants. Nobody occupies the **local + proactive + emotional companionship + voice radio** combination. That gap is murmur.

> Open-source, non-commercial, and **fully local** — the only two network hops are ① Claude brain inference and ② the music stream. Everything else (logic, I/O, memory) stays on your machine.

## Core experience

Three things together define its character; none is optional:

- **🎙️ A continuous radio stream** — not "you ask, I answer," but a program stream that never goes silent. It *spontaneously* picks topics and talks, alternates talk with music, and hits time anchors (morning / midday / night) on schedule.
- **🔀 Hybrid proactive/passive** — mostly broadcasting (no reply required; it's that voice in the background), occasionally turning to you. Engage and you chat; stay quiet and it flows on.
- **🌱 A persona that grows** — a single evolving living asset, not a fixed constant or preset channels. It seeds from a few questions, then keeps rewriting itself to fit you better.

## Architecture

A single Python `asyncio` process. One coroutine drives "speaking up," another reads the keyboard; both feed the brain.

| Component | Responsibility |
|---|---|
| **CLI Host** | render "now playing" + read keyboard input (proactive + typing share the terminal) |
| **Program Director** | the soul: continuously decide what plays next (talk / music / time-anchor); modulate pacing; manage "turn to you / slide back" |
| **Brain** | Claude session (via `claude-agent-sdk`) — generate talk scripts, respond when you type; persona + memory injected. A *harnessed agent* with murmur-owned tools, isolated from your local Claude Code environment |
| **VoiceProvider** | text → speech; hot-swappable TTS running as a warm sidecar process |
| **MusicProvider** | topic/query → audio stream; hot-swappable (v1 = yt-dlp, covering YouTube + Bilibili) |
| **AudioEngine** | sole audio authority: one output stream mixing music + voice, gain-envelope **ducking** (talk rides over the song; an interjection ducks it, never stops it) |
| **Memory** | who you are, topics discussed, songs played (anti-repeat), conversation log — the persona living asset lives here too |

**No dead air**: while the current segment plays, the Director prepares the next one's audio ahead of time so it joins seamlessly.

### Key decisions (and why)

- **All Python** — the local-TTS ecosystem is entirely Python/PyTorch/MLX; a solo MVP saves a language boundary. (The TTS sidecar talks JSON-lines over stdio, so the boundary is language-neutral either way.)
- **Brain = Claude, subscription auth** — reuses your local Claude Code OAuth credentials; no `ANTHROPIC_API_KEY` needed. Every model sits behind a seam (`Brain`, `VoiceProvider`, `MusicProvider`) so swaps are adapter/config changes.
- **TTS is a warm sidecar** — models load slowly (seconds, several GB); keep them warm, isolate crashes, and get a clean hot-swap seam.
- **Keyboard in, voice out** — no ASR this round; ASR is solved and not the value-add. The hard part is making the AI *sound human*, and that's the focus.
- **Two-phase model strategy** — experiment now with the best local/open models (license-agnostic, private); adopt paid/properly-licensed models at distribution.

See [`DESIGN.md`](specs/DESIGN.md) for the full master spec and rationale.

## Status

Building, in ordered sub-specs under [`specs/`](specs/). Each step runs and adds something audible.

- **✅ Spec 01 — `core-loop`** (implemented & verified): the L0 spine — CLI Host + Director + Brain + static persona + typed talk-back + session history + the basic player (superseded by 03-02's engine).
- **✅ Spec 02 — `voice-provider`** (code-implemented; real-voice acceptance is a hands-on gate): warm TTS sidecar + MLX adapters (Spark primary / Qwen3 / Chatterbox / Dia, plus the post-L0 VoxCPM2 candidate). **L0 is now audible.**
- **✅ Spec 03 — `brain-harness` + `ducking` + `guide-harness`** (code-implemented; by-ear acceptance is the open gate): Claude-driven music discovery, the mixing AudioEngine with ducking, cadence scheduling, startup checks + the yt-dlp repair guide. **L1 is code-complete.**

Later specs: no-dead-air look-ahead (04), persistent memory (05), persona lifecycle (06), proactive + pacing (07), token economy (08), Claude Code ingestion (09), TUI (10).

> **The L0 loop is talk-only.** The irreducible magic is "autonomous voice + you can talk back"; music is the immediate next step (L1).

## Requirements

- Python ≥ 3.10
- A local **Claude Code** subscription login (for the real brain) — or run `--brain stub` fully offline
- For a real voice: **Apple Silicon Mac** (the MLX TTS backends)

## Install & run

```bash
# core (runs model-free: stub voice, stub or real brain)
pip install -e .

# run the loop
murmur

# fully offline / no network (canned brain + silent stub voice)
murmur --brain stub --voice stub

# a real voice (Apple Silicon only)
pip install -e ".[tts-mlx]"
murmur --voice spark
```

Useful flags: `--max-segments N` (produce N segments then stop), `--persona PATH`, `--gap SECONDS`, `--brain {claude,stub}`, `--voice {stub,spark,qwen3,chatterbox,dia,voxcpm2}`. Stop cleanly with `Ctrl-C`.

## Development

```bash
pip install -e ".[dev]"
pre-commit install
pytest                 # fast unit layer (fakes; no network/models)
pytest -m integration  # heavy: real TTS sidecar synth, run deliberately
```

Testing is layered (see [`DESIGN.md` §11](specs/DESIGN.md)): unit tests are test-first against fakes; integration tests are tagged and run on demand; sensory "sounds human / feels like radio" checks are human acceptance. Every seam ships a fake, so the core loop is testable without real audio, LLM, or network.

Conventions: specs are written in English and optimized for a coding agent to consume. No CJK anywhere in source (comments, literals, docstrings) — the radio speaks Chinese only at runtime, produced by the model from the persona prompt; enforced by `scripts/check_source_language.py` via pre-commit.

## License

Open-source, non-commercial. Distributed models are chosen/licensed at distribution time (see the two-phase strategy in `specs/DESIGN.md` §3.7).
