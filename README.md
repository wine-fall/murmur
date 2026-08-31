<p align="center">
  <img src="assets/murmur-logo.svg" alt="A minimal line drawing of a person whispering behind a raised hand" width="150">
</p>

# murmur

**A companion radio — "a whole radio station, for an audience of one," with an agent for a brain.**

murmur is always on the air. It finds a topic and chats with you on its own, plays a song, comes back and keeps going; at the right times it says good morning / good night. It *broadcasts, never solicits* — it keeps going whether or not you say anything, and when you type back it chats for a bit, then eases back into the program. The host is **yours from the first minute** — a few questions when you first run it, and you have a character that stays who it is. What grows is how well it knows you. You talk to it with the **keyboard**; it answers with a **voice that sounds human**.

Existing tools are either "voice-control Claude to write code" or message-driven assistants. Nobody occupies the **proactive + emotional companionship + voice radio** combination. That gap is murmur.

> Open-source and non-commercial — but **not self-contained**. Three things come off the network: the brain is a Claude session, the music streams in, and the voice is [fish-speech](https://github.com/fishaudio/fish-speech) by [@fishaudio](https://github.com/fishaudio), reached over a hosted endpoint. What runs on your machine is everything murmur itself owns — program logic, keyboard I/O, memory, persona, and audio mixing. A local TTS is a noted want, not current code.

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
| **Program Director** | the soul: continuously decide what plays next (talk / music / time-anchor); modulate pacing |
| **Brain** | Claude session (via `@anthropic-ai/claude-agent-sdk`) — generate talk scripts, respond when you type; persona + memory injected. A *harnessed agent* with murmur-owned tools, isolated from your local Claude Code environment |
| **VoiceProvider** | text → speech; hot-swappable TTS (v1 = a hosted [fish-speech](https://github.com/fishaudio/fish-speech) endpoint) |
| **MusicProvider** | topic/query → audio stream; hot-swappable (v1 = yt-dlp, covering YouTube + Bilibili) |
| **AudioEngine** | sole audio authority: one output stream mixing music + voice, gain-envelope **ducking** (talk rides over the song; an interjection ducks it, never stops it) |
| **Memory** | who you are, topics discussed, songs played (anti-repeat), conversation log — and the host's own character file, written once at setup and yours to edit after that |

**No dead air**: while the current segment plays, the Director prepares the next one's audio ahead of time so it joins seamlessly.

### Key decisions (and why)

- **TypeScript on the Claude Agent SDK** — the brain harness is the heart of the product, and `@anthropic-ai/claude-agent-sdk` is the first-class surface for it (the Python implementation served as the behavior oracle for the rewrite — GitHub issue #54). The mixer is a Web Audio graph on `node-web-audio-api`; local TTS models are deferred, so no Python/MLX runtime is needed.
- **Brain = a harnessed agent (Claude today), subscription auth** — reuses your local Claude Code OAuth credentials; no `ANTHROPIC_API_KEY` needed. Every model sits behind a seam (`Brain`, `VoiceProvider`, `MusicProvider`) so swaps are adapter/config changes; a second brain backend (Codex SDK) is a recorded direction.
- **Keyboard in, voice out** — no ASR this round; ASR is solved and not the value-add. The hard part is making the AI *sound human*, and that's the focus.
- **Two-phase model strategy** — experiment now with the best available models (private, personal use); adopt paid/properly-licensed models at distribution.

See [`DESIGN.md`](specs/DESIGN.md) for the full master spec and rationale.

## Status

**Every code spec on the roadmap is built.** Built in ordered sub-specs under
[`specs/`](specs/), each step adding something audible:

- the L0 spine — host, director, brain, typed talk-back — with the hosted
  fish-speech voice (01, 02);
- the brain harness, the mixing engine with ducking, and the talking setup
  guide (03);
- the no-dead-air look-ahead (04), persistent three-tier memory (05),
  first-run persona seed & rapport (06), presence — time anchors, going
  quiet when you're away (07);
- the TUI front-end with the visualizer and pixel pet, now the default (10);
- the agentic reply turn — ask and it switches the music, tell it you're done
  and it wraps up the broadcast properly (11).

What remains is acceptance **by ear** — pacing over a real day, onboarding in
a real terminal, how the steering feels — plus a few engineering debts. The
live tracker is [`specs/STATUS.md`](specs/STATUS.md).

## Requirements

- Node.js ≥ 24 and **pnpm** (`corepack enable pnpm`, or `brew install pnpm`)
- A local **Claude Code** subscription login (for the real brain) — or run `--brain stub` fully offline
- For a real voice: a hosted [fish-speech](https://github.com/fishaudio/fish-speech) endpoint (set `MURMUR_TTS_URL` — see `make dev-fishaudio`)

## Install & run

```bash
# as a CLI (Node ≥ 24; no build step, no checkout)
npm install -g murmur-radio
murmur

# from a checkout: core (runs model-free: stub voice, stub or real brain)
pnpm install

# run the loop
node src/main.ts

# fully offline / no network (canned brain + silent stub voice)
node src/main.ts --brain stub --voice stub

# a real voice (hosted TTS endpoint from the environment / .env)
node src/main.ts --voice hosted
```

**Missing pieces are fixed by talking, not by following instructions.** murmur assumes you have Claude Code, so that is the one thing it takes as given — everything else it can walk you through installing itself, asking before each change. The radio always launches: without `ffmpeg`/`yt-dlp` it runs talk-only, without `bun` it uses the plain text front-end, without a voice endpoint it shows its lines instead of speaking. On a boot with any of those gaps it names them and offers to sort them out; decline once and it stops asking. `murmur --setup` (or `--setup-music`) reopens that conversation on demand. To provision by hand instead: `brew install ffmpeg yt-dlp`. `--no-music` skips music entirely.

**What it plays is yours to rewrite.** The rules murmur uses to choose a song live in `~/.murmur/music-policy.md`, a plain markdown file it writes on first run and re-reads before every pick — edit it mid-broadcast and it takes effect on its own, no restart. (murmur lines a song up shortly before it needs one, so an edit reaches the next song or the one after.) Say you want more Cantonese, no covers, nothing you have heard this month; delete the file to go back to the defaults. What never changes there is *how* a pick works (search, judge, commit) — that half stays in the code, so a policy can be as loose as you like without breaking the radio.

Left to its own memory a model plays the same handful of famous songs forever, because the search only ever executes what it already thought of. Point murmur at a listening catalogue — `MURMUR_LISTENING_API_KEY`, and `MURMUR_LISTENING_URL` if you want a host other than the default — and the pick task gets two more tools: `similar_music`, for what real people play alongside an artist or track, and `top_tracks`, for what they actually play most by an artist, because a fresh name whose one famous single gets aired is the same habit one level down. The default host is [Last.fm](https://www.last.fm/api/account/create), whose key is free and needs no listening account; the protocol is public, so anything else that speaks it works too. Without a key murmur behaves exactly as it did before.

Useful flags: `--max-segments N` (produce N segments then stop), `--persona PATH`, `--gap SECONDS`, `--brain {claude,stub}`, `--voice {stub,hosted}`, `--no-music`, `--no-bed`, `--cadence {every_n,random,brain}`, plus the pacing switches `--no-anchors` (drop the good-morning / midday / good-night beats) and `--no-gating` (keep talking even when you are away). Stop cleanly with `Ctrl-C`.

**When something goes wrong**, murmur has already written it down: every run mirrors its timeline to `~/.murmur/log/murmur-<date>.log`, one file per day, the last two weeks kept and older days swept at startup. Attach the day's file to a bug report. Point `MURMUR_DEV_LOG` somewhere else to move it, or set it to an empty string to write no log at all.

## Development

One command sets up and runs the app; a second terminal tails a live debug log:

```bash
make dev      # sync deps, report what is missing, launch the app either way
make logs     # in another terminal: tail diagnostics + memory while it runs
```

`make dev` runs the real brain + music with the hosted voice (`VOICE=hosted`,
endpoint loaded from the gitignored `.env` — `make dev-fishaudio` selects the
fish.audio config); pass `VOICE=stub` for a silent voice, or `STUB=1 make dev`
for a fully offline session (canned brain, no music — needs no
network/binaries). The program timeline mirrors to `.dev/dev.log`; `make logs`
(`scripts/devwatch.ts`) tails that and folds in a periodic memory-tree line.
`make help` lists every target.

Under the hood:

```bash
pnpm install
pnpm test                      # fast unit layer (vitest; fakes, no network)
pnpm run typecheck             # tsc over src/, test/ + the tooling scripts
pnpm run lint                  # oxlint
brew install ffmpeg yt-dlp    # binaries real runs need (music)
```

Testing is layered (see [`DESIGN.md` §11](specs/DESIGN.md)): unit tests are test-first against fakes; real-boundary checks run on demand as throwaway `scratch/` smokes; sensory "sounds human / feels like radio" checks are human acceptance. Every seam ships a fake, so the core loop is testable without real audio, LLM, or network.

Conventions: specs are written in English and optimized for a coding agent to consume. No CJK anywhere in source (comments, literals, docstrings) — the radio speaks whatever language the listener settled on at onboarding (the machine's locale by default, English as the floor), produced by the model from the persona; enforced by `scripts/check-source-language.ts` via pre-commit.

## Credits

The voice is [fish-speech](https://github.com/fishaudio/fish-speech) by [@fishaudio](https://github.com/fishaudio) — the reason murmur sounds like a person on the radio instead of a screen reader. murmur talks to it over a hosted endpoint; the model and the work behind it are theirs.

## License

Open-source, non-commercial. Distributed models are chosen/licensed at distribution time (see the two-phase strategy in `specs/DESIGN.md` §3.7).
