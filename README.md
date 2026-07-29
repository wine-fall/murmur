# murmur

**A fully-local companion radio — "a radio that broadcasts for an audience of one," with Claude as its brain.**

murmur is always on the air. It finds a topic and chats with you on its own, plays a song, comes back and keeps going; at the right times it says good morning / good night. It's *mostly broadcasting*, but occasionally turns to you and asks something — if you don't engage, it gracefully slides back into the program. The host is **yours from the first minute** — a few questions when you first run it, and you have a character that stays who it is. What grows is how well it knows you. You talk to it with the **keyboard**; it answers with a **voice that sounds human**.

Existing tools are either "voice-control Claude to write code" or message-driven assistants. Nobody occupies the **local + proactive + emotional companionship + voice radio** combination. That gap is murmur.

> Open-source, non-commercial, and **fully local** — the only two network hops are ① Claude brain inference and ② the music stream. Everything else (logic, I/O, memory) stays on your machine.

## Core experience

Three things together define its character; none is optional:

- **🎙️ A continuous radio stream** — not "you ask, I answer," but a program stream that never goes silent. It *spontaneously* picks topics and talks, alternates talk with music, and hits time anchors (morning / midday / night) on schedule.
- **🔀 Hybrid proactive/passive** — mostly broadcasting (no reply required; it's that voice in the background), occasionally turning to you. Engage and you chat; stay quiet and it flows on.
- **🌱 A host that stays, a rapport that grows** — one host, not a rack of preset channels. Its character comes from a few questions on the first run and then holds still; it's a plain text file you can open and rewrite whenever you like, and nothing changes it behind your back. What does change is the part that should: what it knows about you, and how the two of you get on.

## Architecture

A single Node.js (TypeScript) process. One loop drives "speaking up," a readline reader owns the keyboard; both feed the brain.

| Component | Responsibility |
|---|---|
| **CLI Host** | render "now playing" + read keyboard input (proactive + typing share the terminal) |
| **Program Director** | the soul: continuously decide what plays next (talk / music / time-anchor); modulate pacing; manage "turn to you / slide back" |
| **Brain** | Claude session (via `@anthropic-ai/claude-agent-sdk`) — generate talk scripts, respond when you type; persona + memory injected. A *harnessed agent* with murmur-owned tools, isolated from your local Claude Code environment |
| **VoiceProvider** | text → speech; hot-swappable TTS (v1 = a hosted fish-speech endpoint) |
| **MusicProvider** | topic/query → audio stream; hot-swappable (v1 = yt-dlp, covering YouTube + Bilibili) |
| **AudioEngine** | sole audio authority: one output stream mixing music + voice, gain-envelope **ducking** (talk rides over the song; an interjection ducks it, never stops it) |
| **Memory** | who you are, topics discussed, songs played (anti-repeat), conversation log — and the host's own character file, written once at setup and yours to edit after that |

**No dead air**: while the current segment plays, the Director prepares the next one's audio ahead of time so it joins seamlessly.

### Key decisions (and why)

- **TypeScript on the Claude Agent SDK** — the brain harness is the heart of the product, and `@anthropic-ai/claude-agent-sdk` is the first-class surface for it (the Python implementation served as the behavior oracle for the rewrite — GitHub issue #54). The mixer is a Web Audio graph on `node-web-audio-api`; local TTS models are deferred, so no Python/MLX runtime is needed.
- **Brain = Claude, subscription auth** — reuses your local Claude Code OAuth credentials; no `ANTHROPIC_API_KEY` needed. Every model sits behind a seam (`Brain`, `VoiceProvider`, `MusicProvider`) so swaps are adapter/config changes.
- **Keyboard in, voice out** — no ASR this round; ASR is solved and not the value-add. The hard part is making the AI *sound human*, and that's the focus.
- **Two-phase model strategy** — experiment now with the best available models (private, personal use); adopt paid/properly-licensed models at distribution.

See [`DESIGN.md`](specs/DESIGN.md) for the full master spec and rationale.

## Status

Building, in ordered sub-specs under [`specs/`](specs/). Each step runs and adds something audible.

- **✅ Spec 01 — `core-loop`** (implemented & verified): the L0 spine — CLI Host + Director + Brain + static persona + typed talk-back + session history + the basic player (superseded by 03-02's engine).
- **✅ Spec 02 — `voice-provider`** (code-implemented; real-voice acceptance is a hands-on gate): the hosted fish-speech voice (`MURMUR_TTS_*` endpoint config, sentence pacing, seed-pinned timbre); local TTS backends are deferred. **L0 is now audible.**
- **✅ Spec 03 — `brain-harness` + `ducking` + `guide-harness`** (code-implemented; by-ear acceptance is the open gate): Claude-driven music discovery, the mixing AudioEngine with ducking, cadence scheduling, startup checks + the yt-dlp repair guide. **L1 is code-complete.**

Also landed since: the no-dead-air look-ahead (04) and persistent memory across sessions (05). Still ahead: proactive + pacing — turning to you, time anchors, going quiet when you're away (07); first run & rapport — the setup questions, an optional read of your Claude Code history to get to know you sooner, and the memory of how you two get on (06); the TUI (10). Two former specs are gone: the token economy is now folded into the specs that own the behavior, and Claude Code ingestion lives inside first-run setup.

> **The L0 loop is talk-only.** The irreducible magic is "autonomous voice + you can talk back"; music is the immediate next step (L1).

## Requirements

- Node.js ≥ 24
- A local **Claude Code** subscription login (for the real brain) — or run `--brain stub` fully offline
- For a real voice: a hosted TTS endpoint (fish-speech; set `MURMUR_TTS_URL` — see `make dev-fishaudio`)

## Install & run

```bash
# core (runs model-free: stub voice, stub or real brain)
npm install

# run the loop
node src/main.ts

# fully offline / no network (canned brain + silent stub voice)
node src/main.ts --brain stub --voice stub

# a real voice (hosted TTS endpoint from the environment / .env)
node src/main.ts --voice hosted
```

**Music** needs two external binaries — `ffmpeg` (decode) and `yt-dlp` (source) — which are deliberately *not* Python dependencies: the startup check detects a missing/broken one and the setup assistant offers to fix it (`murmur --setup-music` runs the same repair on demand). To provision by hand: `brew install ffmpeg yt-dlp`. Without them the radio runs talk-only; `--no-music` skips music entirely.

Useful flags: `--max-segments N` (produce N segments then stop), `--persona PATH`, `--gap SECONDS`, `--brain {claude,stub}`, `--voice {stub,hosted}`, `--no-music`, `--no-bed`, `--cadence {every_n,random,brain}`. Stop cleanly with `Ctrl-C`.

## Development

One command sets up and runs the app; a second terminal tails a live debug log:

```bash
make dev      # sync deps, preflight (prompts to fix any blocker), launch the app
make logs     # in another terminal: tail diagnostics + memory while it runs
```

`make dev` runs the real brain + music with the hosted voice (`VOICE=hosted`,
endpoint loaded from the gitignored `.env` — `make dev-fishaudio` selects the
fish.audio config); pass `VOICE=stub` for a silent voice, or `STUB=1 make dev`
for a fully offline session (canned brain, no music — needs no
network/binaries). The program timeline mirrors to `.dev/dev.log`; `make logs`
(`scripts/devwatch.py`) tails that and folds in a periodic memory-tree line.
`make help` lists every target.

Under the hood:

```bash
npm install
npm test                      # fast unit layer (vitest; fakes, no network)
npm run typecheck             # tsc over src/ + scripts/
npm run lint                  # oxlint
brew install ffmpeg yt-dlp    # binaries real runs need (music)
```

Testing is layered (see [`DESIGN.md` §11](specs/DESIGN.md)): unit tests are test-first against fakes; real-boundary checks run on demand as throwaway `scratch/` smokes; sensory "sounds human / feels like radio" checks are human acceptance. Every seam ships a fake, so the core loop is testable without real audio, LLM, or network.

Conventions: specs are written in English and optimized for a coding agent to consume. No CJK anywhere in source (comments, literals, docstrings) — the radio speaks Chinese only at runtime, produced by the model from the persona prompt; enforced by `scripts/check_source_language.py` via pre-commit.

## License

Open-source, non-commercial. Distributed models are chosen/licensed at distribution time (see the two-phase strategy in `specs/DESIGN.md` §3.7).
