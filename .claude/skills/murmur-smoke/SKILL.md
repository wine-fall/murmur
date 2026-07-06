---
name: murmur-smoke
description: Use when you need to see murmur's REAL behavior instead of the fakes the unit suite uses — the real Claude brain (run_task / run_guide via claude-agent-sdk), real yt-dlp, audio playback, or the interactive guide — or when a change is unit-test-green but might be broken at the claude-agent-sdk / real-integration boundary, or you're troubleshooting a real-run failure or a stochastic/sensory behavior. The murmur companion to writing unit tests (murmur-build-spec).
---

# murmur-smoke

## Overview

murmur's unit suite runs on **fakes** (`StubBrain`/`FakeBrain`, `FakeVoice`, `FakeMusicProvider`, `FakeGuideBrain`) and **deliberately never touches** the real Claude brain, `yt-dlp`, audio, or the interactive guide (DESIGN §11). That is exactly where bugs hide: this project has shipped **unit-green code that was broken at the real/SDK boundary** — tool results missing the MCP `content` shape, and `can_use_tool` needing streaming mode — neither of which a fake can catch. A **throwaway script that runs the real thing** is how you see it work and debug it.

This does **not** replace unit tests. It is the companion for the real / integration / interactive / sensory layer, and its findings get **folded back into a test**.

## When to use

- Observe REAL behavior: `Brain.run_task` / `run_guide` with the real Claude brain, real `yt-dlp` search/resolve, audio, or the guide conversation.
- A change is **unit-green but possibly broken** at the `claude-agent-sdk` seam (fakes bypass the SDK).
- Debugging a real-run failure, or a stochastic/sensory behavior a unit test cannot assert.

**Not for** deterministic logic — that is a unit test, written test-first (see `murmur-build-spec`). Don't smoke what you can assert.

## Where scripts live

`scratch/` at the repo root — **gitignored, never committed**. Durable across sessions, rerunnable. One script per thing you probe; delete freely. Seed examples already there: `scratch/smoke_music.py` (find + pull) and `scratch/guide_fix.py` (guide harness).

## The flow

1. **Name the ONE thing to observe** ("does `run_guide` get the model to call `submit_pick`?"). One question per script.
2. **Write the smallest runnable script** in `scratch/`: import murmur, build the *real* component, print the observable output. No abstraction.
3. **Run it** (see run notes) and read the output.
4. **Add signal + iterate**: `MURMUR_HARNESS_DEBUG=1` dumps the harness's SDK messages (tool calls, tool results, text); add prints; rerun.
5. **Fold the finding into a test** — the script is throwaway; the *artifact* is a deterministic unit test (or an `integration`-tagged test) that locks the behavior/bug.

## Run notes (murmur-specific)

- **venv**: `.venv/bin/python scratch/x.py` (or `source .venv/bin/activate`, then `python …`).
- **Real Claude**: needs `claude` logged in (subscription OAuth, no API key). Harness runs Haiku (find-music) / Opus (guide).
- **Real yt-dlp / ffmpeg**: unbound external binaries (master §10.1) — `brew install ffmpeg yt-dlp`; both must be on PATH; needs network.
- **Corporate MITM proxy** (e.g. Cloudflare Gateway): yt-dlp fails TLS verify (`CERTIFICATE_VERIFY_FAILED`) because it uses `certifi`, not the system CA bundle — **not a murmur bug** (it's what the guide harness fixes). For a smoke, run off that network or point `certifi` at the corp CA.
- **Sandboxed Bash**: network may be TLS-intercepted; run the script unsandboxed (with the user's OK) or have the user run it in their terminal.
- **Interactive flows** (the guide): need a real stdin to answer prompts — cannot be fully smoked headless; run in a real terminal.
- **`bypassPermissions`**: never for an unsupervised run; the guide uses `default` (per-action confirm).

## Common mistakes

- Committing scratch scripts — they live in gitignored `scratch/` only.
- Smoke-testing deterministic logic instead of writing a unit test (test-first, `murmur-build-spec`).
- Stopping at "it worked in the script" — fold the finding into a test so it is locked against recurrence.
- Running the guide agent with `bypassPermissions` unsupervised.
