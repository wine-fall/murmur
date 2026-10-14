<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/murmur-logo-dark.svg">
    <img src="assets/murmur-logo.svg" alt="A minimal line drawing of a person whispering behind a raised hand" width="150">
  </picture>
</p>

# murmur

[![npm version](https://img.shields.io/npm/v/murmur-radio)](https://www.npmjs.com/package/murmur-radio)
[![npm downloads](https://img.shields.io/npm/dm/murmur-radio)](https://www.npmjs.com/package/murmur-radio)
[![license: MIT](https://img.shields.io/badge/license-MIT-a9b665)](LICENSE)
[![node 22.16+ | 24+](https://img.shields.io/badge/node-22.16%2B%20%7C%2024%2B-d8a657)](package.json)

```bash
npm install -g murmur-radio && murmur
```

**A companion radio — "a whole radio station, for an audience of one," with an agent for a brain.**

https://github.com/user-attachments/assets/59a300a8-8d61-443f-b592-8677e12e2be4

<p align="center"><em><strong>Sound on</strong> — meet the host, hear a real on-air moment, and see how you reply in this 86-second demo.</em><br><a href="https://www.youtube.com/watch?v=DQ4YbSJF2XM">Watch on YouTube if the player does not load</a><br><a href="https://github.com/user-attachments/assets/59d1f8f0-7eae-4dfb-8dd2-c046d3f559ab">Longer recording of the radio running (2:32)</a></p>

murmur is always on the air. It picks a topic and talks, plays a song, comes back and keeps going — whether or not you say anything. Type back and it answers out loud, chats for a bit, then eases back into the program.

## What it's like

- **It never goes quiet.** Talk and music take turns on their own, with a good morning and a good night at the right hours. Leave it running in the background all day.
- **Talk back, or don't.** Type a line and the host answers in a voice that sounds like a person. Stay quiet and the show goes on.
- **One host, and it gets to know you.** A few questions on the first run give you a host whose character holds still. What grows is what it knows about you — your taste, your days, what you talked about last week.
- **Everything is a file you can open.** The host's character and the rules it picks songs by are plain text under `~/.murmur/`. Change the music rules mid-song and the next pick follows them.

## Get started

You need:

- **Node.js 22.16+ or 24+**
- **Claude Code**, logged in with your subscription — the brain is your own Claude session, so there is no API key to manage.
- A **free [fish.audio](https://fish.audio) API key** for the voice. You don't need it up front: the first run walks you through signing up and pasting it in.

```bash
npm install -g murmur-radio
murmur
```

The first run is a short conversation. It asks a few questions to shape your host, then offers to set up whatever is missing — the voice key, `ffmpeg` + `yt-dlp` for music, `bun` for the full-screen UI, and, if your Node comes from nvm, fnm, asdf or mise, a small `~/.local/bin/murmur` shim so the command doesn't vanish when a project switches Node. Say no and it plays anyway, just with less: talk-only without the music tools, lines on screen instead of spoken without a voice. `murmur --setup` reopens that conversation any time.

## Using it

- **Commands.** In the full-screen UI, `/` lists what it takes: settings, the setup guide, a bug report, a wish, `/update` (installs a newer murmur from npm) and `/quit`. The plain front-end takes the same commands typed in full; `Ctrl-C` says goodbye too.
- **What it plays is yours to rewrite.** The song-picking rules live in `~/.murmur/music-policy.md`, re-read before every pick — ask for more Cantonese, no covers, nothing you've heard this month. Delete the file to go back to the defaults.
- **When something goes wrong**, `/bug` turns what just happened into a filled-in GitHub report with the log attached. A run that dies without saying goodnight is noticed on the next start and offered up the same way. Logs live in `~/.murmur/log/`, one file per day, two weeks kept.
- **Flags worth knowing:** `--plain` (skip the full-screen UI), `--no-music`, `--persona PATH`, `--version`. Pacing, cadence and the rest are the option table at the top of [`src/config.ts`](src/config.ts).

## How it works

A Node.js (TypeScript) engine runs the program and mixes the audio; a front-end draws the screen and reads your keyboard. While one segment plays, the next is already being prepared, so there is no dead air. A song ducks under the host's voice instead of stopping.

murmur ships no model. Three things come off the network: the **brain** is your Claude session (via [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)), the **voice** is [fish-speech](https://github.com/fishaudio/fish-speech) over fish.audio's hosted API, and the **music** streams in through `yt-dlp`. Everything murmur owns — the program logic, memory, persona and audio mixing — runs on your machine.

The components and the reasons behind them: [`docs/architecture.md`](docs/architecture.md). The full design: [`specs/DESIGN.md`](specs/DESIGN.md).

## Status

Every code spec is built. What remains is acceptance by ear — pacing over a real day, how the steering feels — plus a handful of engineering debts. Current focus: [`specs/STATUS.md`](specs/STATUS.md); what comes next: [`ROADMAP.md`](ROADMAP.md); engineering notes with the numbers measured along the way: [`docs/blog/`](docs/blog/).

## Development

Running from a checkout needs **Node 24+** (it runs the TypeScript directly) and **pnpm** (`corepack enable pnpm`). One command sets up and runs the app; a second terminal tails a live debug log:

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
node src/main.ts               # run from source
node src/main.ts --brain stub --voice stub --no-music --no-bed   # fully offline
pnpm test                      # fast unit layer (vitest; fakes, no network)
pnpm run typecheck             # tsc over src/, test/ + the tooling scripts
pnpm run lint                  # oxlint
brew install ffmpeg yt-dlp    # binaries real runs need (music)
```

Testing is layered (see [`DESIGN.md` §11](specs/DESIGN.md)): unit tests are test-first against fakes; real-boundary checks run on demand as throwaway `scratch/` smokes; sensory "sounds human / feels like radio" checks are human acceptance. Every seam ships a fake, so the core loop is testable without real audio, LLM, or network.

Conventions: specs are written in English and optimized for a coding agent to consume. No CJK anywhere in source (comments, literals, docstrings) — the radio speaks whatever language the listener settled on at onboarding (the machine's locale by default, English as the floor), produced by the model from the persona; enforced by `scripts/check-source-language.ts` via pre-commit.

## Credits

The voice is [fish-speech](https://github.com/fishaudio/fish-speech) by [@fishaudio](https://github.com/fishaudio) — the reason murmur sounds like a person on the radio instead of a screen reader. murmur talks to it through fish.audio's hosted API; the model and the work behind it are theirs.

## License

murmur's own code is **MIT** — see [`LICENSE`](LICENSE).

**Third-party services.** murmur ships no model weights; it calls services that carry their own terms, and complying with them is yours:

- **Brain** — your own Claude session, under your own Anthropic subscription.
- **Voice** — fish.audio, the endpoint the first run sets up, serves [fish-speech](https://github.com/fishaudio/fish-speech), whose model carries the [Fish Audio Research License](https://github.com/fishaudio/fish-speech/blob/main/LICENSE) (research and non-commercial use free; commercial use by separate license). Whoever operates the endpoint you point at may add service terms of their own — read both; murmur is not a party to either.
- **Music** — retrieval runs through `yt-dlp` on your machine, against whatever source you point it at.

And these, only on the paths that need them:

- **A package registry** — a packaged first boot runs `bun install` for the TUI; without it murmur falls back to the plain front-end.
- **`raw.githubusercontent.com`** — downloading a built-in voice preset's reference clip (cached and hash-pinned after the first fetch).
- **`registry.npmjs.org`** — the version check behind `/update`.
