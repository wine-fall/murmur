# How murmur works

Two processes. A Node.js (TypeScript) **engine** owns the program and the audio; a **front-end** owns the screen and the keyboard — the TUI by default, a plain-text host where there is no `bun` or when you pass `--plain`. Inside the engine one loop drives "speaking up" while your typing arrives on its own channel; both feed the brain.

| Component | Responsibility |
|---|---|
| **Front-end** | render the program — now playing, the log, the pet — and read what you type; the TUI runs out-of-process over IPC, the plain host in-process |
| **Program Director** | the soul: continuously decide what plays next (talk / music / time-anchor); modulate pacing |
| **Brain** | Claude session (via `@anthropic-ai/claude-agent-sdk`) — generate talk scripts, respond when you type; persona + memory injected. A *harnessed agent* with murmur-owned tools, isolated from your local Claude Code environment |
| **VoiceProvider** | text → speech; hot-swappable TTS (v1 = a hosted [fish-speech](https://github.com/fishaudio/fish-speech) endpoint) |
| **MusicProvider** | topic/query → audio stream; hot-swappable (v1 = yt-dlp, covering YouTube + Bilibili) |
| **AudioEngine** | sole audio authority: one output stream mixing music + voice, gain-envelope **ducking** (talk rides over the song; an interjection ducks it, never stops it) |
| **Memory** | who you are, topics discussed, songs played (anti-repeat), conversation log — and the host's own character file, written once at setup and yours to edit after that |

**No dead air**: while the current segment plays, the Director prepares the next one's audio ahead of time so it joins seamlessly.

## Key decisions (and why)

- **TypeScript on the Claude Agent SDK** — the brain harness is the heart of the product, and `@anthropic-ai/claude-agent-sdk` is the first-class surface for it (the Python implementation served as the behavior oracle for the rewrite — GitHub issue #54). The mixer is a Web Audio graph on `node-web-audio-api`; local TTS models are deferred, so no Python/MLX runtime is needed.
- **Brain = a harnessed agent (Claude today), subscription auth** — reuses your local Claude Code OAuth credentials; no `ANTHROPIC_API_KEY` needed. Every model sits behind a seam (`Brain`, `VoiceProvider`, `MusicProvider`) so swaps are adapter/config changes; a second brain backend (Codex SDK) is a recorded direction.
- **Keyboard in, voice out** — no ASR this round; ASR is solved and not the value-add. The hard part is making the AI *sound human*, and that's the focus.
- **murmur ships no model** — the brain is your own Claude session and the voice is an endpoint you point it at, so each model's terms stay between you and that model's author, never redistributed by murmur. See [License](../README.md#license).

See [`DESIGN.md`](../specs/DESIGN.md) for the full master spec and rationale.
