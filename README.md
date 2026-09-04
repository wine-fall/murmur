<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/murmur-logo-dark.svg">
    <img src="assets/murmur-logo.svg" alt="A minimal line drawing of a person whispering behind a raised hand" width="150">
  </picture>
</p>

# murmur

**A companion radio — "a whole radio station, for an audience of one," with an agent for a brain.**

<p align="center">
  <video src="https://github.com/user-attachments/assets/2d26bfab-b72d-425b-b21a-548326ff19eb" controls width="100%"></video>
</p>

<p align="center"><em><strong>Turn the sound on</strong> — the voice is the point. Two and a half minutes of the radio actually running.</em></p>

murmur is always on the air. It finds a topic and chats with you on its own, plays a song, comes back and keeps going; at the right times it says good morning / good night. It *broadcasts, never solicits* — it keeps going whether or not you say anything, and when you type back it chats for a bit, then eases back into the program. The host is **yours from the first minute** — a few questions when you first run it, and you have a character that stays who it is. What grows is how well it knows you. You talk to it with the **keyboard**; it answers with a **voice that sounds human**.

Existing tools are either "voice-control Claude to write code" or message-driven assistants. Nobody occupies the **proactive + emotional companionship + voice radio** combination. That gap is murmur.

> Open-source (MIT) — but **not self-contained**. The main three come off the network — the brain is a Claude session, the music streams in, and the voice is [fish-speech](https://github.com/fishaudio/fish-speech) by [@fishaudio](https://github.com/fishaudio), reached over a hosted endpoint — and a fourth if you hand it a listening catalogue to find songs in. What runs on your machine is everything murmur itself owns — program logic, keyboard I/O, memory, persona, and audio mixing. A local TTS is a noted want, not current code.

## Core experience

Three things together define its character; none is optional:

- **🎙️ A continuous radio stream** — not "you ask, I answer," but a program stream that never goes silent. It *spontaneously* picks topics and talks, alternates talk with music, and hits time anchors (morning / midday / night) on schedule.
- **🔀 Hybrid proactive/passive** — mostly broadcasting (no reply required; it's that voice in the background), occasionally turning to you. Engage and you chat; stay quiet and it flows on.
- **🌱 A host that stays, a rapport that grows** — one host, not a rack of preset channels. Its character comes from a few questions on the first run and then holds still; it's a plain text file you can open and rewrite whenever you like, and nothing changes it behind your back. What does change is the part that should: what it knows about you, and how the two of you get on.
- **🔧 A machine you can open** — the parts that decide what you hear are yours to edit, not sealed behind a menu. The rules it picks songs by are a markdown file it re-reads before every song, so a change lands mid-broadcast; every setting has a pane, and also changes if you just say so on the air. It keeps an account of itself, too: a run that dies without saying goodnight is remembered and raised the next time you tune in, and one command turns "that was wrong" into a report that writes itself, log attached, and arrives at GitHub needing only your send.

## Architecture

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

### Key decisions (and why)

- **TypeScript on the Claude Agent SDK** — the brain harness is the heart of the product, and `@anthropic-ai/claude-agent-sdk` is the first-class surface for it (the Python implementation served as the behavior oracle for the rewrite — GitHub issue #54). The mixer is a Web Audio graph on `node-web-audio-api`; local TTS models are deferred, so no Python/MLX runtime is needed.
- **Brain = a harnessed agent (Claude today), subscription auth** — reuses your local Claude Code OAuth credentials; no `ANTHROPIC_API_KEY` needed. Every model sits behind a seam (`Brain`, `VoiceProvider`, `MusicProvider`) so swaps are adapter/config changes; a second brain backend (Codex SDK) is a recorded direction.
- **Keyboard in, voice out** — no ASR this round; ASR is solved and not the value-add. The hard part is making the AI *sound human*, and that's the focus.
- **murmur ships no model** — the brain is your own Claude session and the voice is an endpoint you point it at, so each model's terms stay between you and that model's author, never redistributed by murmur. See [License](#license).

See [`DESIGN.md`](specs/DESIGN.md) for the full master spec and rationale.

## Status

**Every code spec is built** — the L0 spine, the brain harness and the ducking
mixer, the no-dead-air look-ahead, memory, presence, the TUI front-end, the
settings surface, and the agentic reply turn, in ordered sub-specs under
[`specs/`](specs/).

What remains is acceptance **by ear** — pacing over a real day, onboarding in a
real terminal, how the steering feels — plus a handful of engineering debts.
What is being built right now is [`specs/STATUS.md`](specs/STATUS.md); where it
goes next, in order, is [`ROADMAP.md`](ROADMAP.md).

## Requirements

- Node.js ≥ 24 and **pnpm** (`corepack enable pnpm`, or `brew install pnpm`)
- A local **Claude Code** subscription login (for the real brain) — or run `--brain stub` fully offline
- For a real voice: a hosted [fish-speech](https://github.com/fishaudio/fish-speech) endpoint (set `MURMUR_TTS_URL` — see `make dev-fishaudio`)
- Optional, and murmur offers to install them for you: `ffmpeg` + `yt-dlp` for music, `bun` for the TUI. Missing any of them it runs degraded rather than refusing to start

## Install & run

```bash
# as a CLI (Node ≥ 24; no build step, no checkout)
npm install -g murmur-radio
murmur

# from a checkout: core (runs model-free: stub voice, stub or real brain)
pnpm install

# run the loop
node src/main.ts

# fully offline / no network (canned brain, silent voice, no music or bed)
node src/main.ts --brain stub --voice stub --no-music --no-bed

# a real voice (hosted TTS endpoint from the environment / .env)
node src/main.ts --voice hosted
```

**Missing pieces are fixed by talking, not by following instructions.** murmur assumes you have Claude Code, so that is the one thing it takes as given — everything else it can walk you through installing itself, asking before each change. The radio always launches: without `ffmpeg`/`yt-dlp` it runs talk-only, without `bun` it uses the plain text front-end, without a voice endpoint it shows its lines instead of speaking. On a boot with any of those gaps it names them and offers to sort them out; decline once and it stops asking. `murmur --setup` reopens that conversation on demand, and `brew install ffmpeg yt-dlp` does it the old way.

**What it plays is yours to rewrite.** The rules murmur uses to choose a song live in `~/.murmur/music-policy.md`, a plain markdown file it writes on first run and re-reads before every pick — edit it mid-broadcast and it takes effect on its own, no restart. (murmur lines a song up shortly before it needs one, so an edit reaches the next song or the one after.) Say you want more Cantonese, no covers, nothing you have heard this month; delete the file to go back to the defaults. What never changes there is *how* a pick works (search, judge, commit) — that half stays in the code, so a policy can be as loose as you like without breaking the radio.

Left to its own memory a model plays the same handful of famous songs forever, because a search only ever executes what it already thought of. Give it a listening catalogue — an API key in `MURMUR_LISTENING_API_KEY` — and the pick gains two tools that ask what real people actually play: around an artist or track, and *by* an artist, since airing a fresh name's one famous single is the same habit a level down. It points at [Last.fm](https://www.last.fm/api/account/create) by default, whose key is free: the protocol is public and read-only, and it never touches an account of yours (point `MURMUR_LISTENING_URL` elsewhere and anything else speaking it works). Without a key, nothing changes.

Worth knowing: `--plain` (skip the TUI), `--no-music`, `--persona PATH`, `--version`, and the four-flag offline run above. The rest — pacing, cadence, segment caps, TTS overrides — are the option table at the top of `src/config.ts`. In the TUI a `/` opens the list of what it takes — settings, the setup guide, a bug, a wish, `/update` (checks npm for a newer murmur and installs it), and `/quit`; the plain host takes the same commands typed in full, and `Ctrl-C` is the same goodbye.

**When something goes wrong**, murmur has already written it down: every run mirrors its timeline to `~/.murmur/log/murmur-<date>.log`, one file per day, the last two weeks kept and older days swept at startup. You rarely have to go looking — `/bug` turns what just happened into a filled-in report with that log attached and hands it over however the machine allows: onto the clipboard, into a pre-filled GitHub form, or filed through `gh` on a box with no browser. A run that dies without saying goodnight is noticed on the next boot and offered up the same way. Point `MURMUR_DEV_LOG` somewhere else to move the log, or set it to an empty string to write none.

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

murmur's own code is **MIT** — see [`LICENSE`](LICENSE).

**Third-party services.** murmur ships no model weights; it calls services that carry their own terms, and complying with them is yours:

- **Brain** — your own Claude session, under your own Anthropic subscription.
- **Voice** — the default endpoint serves [fish-speech](https://github.com/fishaudio/fish-speech), whose model carries the [Fish Audio Research License](https://github.com/fishaudio/fish-speech/blob/main/LICENSE) (research and non-commercial use free; commercial use by separate license). Whoever operates the endpoint you point at may add service terms of their own — read both; murmur is not a party to either.
- **Music** — retrieval runs through `yt-dlp` on your machine, against whatever source you point it at.

And these, only on the paths that need them:

- **A package registry** — a packaged first boot runs `bun install` for the TUI; without it murmur falls back to the plain front-end.
- **`raw.githubusercontent.com`** — downloading a built-in voice preset's reference clip (cached and hash-pinned after the first fetch).
- **[Last.fm](https://www.last.fm/api), or the catalogue you point `MURMUR_LISTENING_URL` at** — only with a listening key set.
- **`registry.npmjs.org`** — the version check behind `/update`.
