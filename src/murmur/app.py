"""Application wiring + entry point (spec 01 §3.1).

Constructs the core components, wires the seams, and runs the autonomous talk
loop as a single foreground asyncio process (master §3.6). Closing the terminal
or Ctrl-C stops it; cleanup shuts down the voice backend (§3.6).

Spec 01 step 1: the loop runs against the stub VoiceProvider and StubBrain.
Step 2 swaps in the real (claude-agent-sdk) Brain. Step 3 adds the real
AudioPlayer (external player subprocess), typed talk-back, cancel-and-resume
interjection, and ``/quit`` (the Director arbitrates; see director.py).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
from dataclasses import replace
from pathlib import Path

from .audio_player import AudioPlayer
from .brain import build_brain
from .cli_host import CliHost
from .config import Config
from .director import Director
from .memory import InProcessMemoryStore
from .persona import load_persona
from .voice import build_voice


async def _run(config: Config, *, max_segments: int | None) -> None:
    persona = load_persona(config.persona_path)

    cli = CliHost()
    memory = InProcessMemoryStore()
    voice = build_voice(config.voice_provider)
    player = AudioPlayer(config.player_cmd)
    brain = build_brain(config.brain_provider, model=config.model)
    director = Director(
        config=config,
        persona=persona,
        brain=brain,
        voice=voice,
        player=player,
        memory=memory,
        cli_host=cli,
    )

    await voice.start()
    cli.banner(
        persona.splitlines()[0] if persona else "(empty)",
        brain=config.brain_provider,
        voice=config.voice_provider,
    )
    try:
        await director.run(max_segments=max_segments)
    finally:
        # Orderly shutdown (§3.6): stop playback, close the voice backend.
        # Best-effort even if we got here via cancellation (Ctrl-C).
        with contextlib.suppress(asyncio.CancelledError):
            await player.stop()
        with contextlib.suppress(asyncio.CancelledError):
            await voice.aclose()
        cli.info("stopped cleanly.")


async def _run_setup(config: Config) -> None:
    """Run the music (yt-dlp) preflight + guide harness, routed through the CLI
    Host (spec 03-03). Explicit entry for now (``--setup-music``); the auto
    startup-preflight + in-conversation trigger is a later UX refinement."""
    from .brain import ClaudeBrain
    from .setup import run_music_setup

    cli = CliHost()
    cli.start()  # spawn the stdin reader so the guide's confirms can be answered
    await run_music_setup(cli, ClaudeBrain(config.model))


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="murmur", description="personal companion radio (L0)"
    )
    p.add_argument(
        "--max-segments",
        type=int,
        default=None,
        metavar="N",
        help="produce N talk segments then stop cleanly (default: run until Ctrl-C)",
    )
    p.add_argument(
        "--persona",
        type=Path,
        default=None,
        metavar="PATH",
        help="override the persona seed file path",
    )
    p.add_argument(
        "--gap",
        type=float,
        default=None,
        metavar="SECONDS",
        help="override the inter-segment gap",
    )
    p.add_argument(
        "--brain",
        choices=["claude", "stub"],
        default=None,
        help="Brain to use: 'claude' (real, default) or 'stub' (canned, no network)",
    )
    p.add_argument(
        "--voice",
        choices=["stub", "spark", "qwen3", "chatterbox", "dia"],
        default=None,
        help=(
            "VoiceProvider: 'stub' (silent wav, no sidecar/model) or a real MLX "
            "voice via the warm sidecar ('spark' primary / 'qwen3' / 'chatterbox' "
            "/ 'dia'). ('sidecar-fake' exists for internal plumbing diagnostics.)"
        ),
    )
    p.add_argument(
        "--player",
        default=None,
        metavar="CMD",
        help="external audio player binary (default: afplay)",
    )
    p.add_argument(
        "--setup-music",
        action="store_true",
        help="run the yt-dlp music preflight + setup/repair guide, then exit (spec 03-03)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)
    config = Config.default()
    if args.persona is not None:
        config = replace(config, persona_path=args.persona)
    if args.gap is not None:
        config = replace(config, inter_segment_gap=args.gap)
    if args.brain is not None:
        config = replace(config, brain_provider=args.brain)
    if args.voice is not None:
        config = replace(config, voice_provider=args.voice)
    if args.player is not None:
        config = replace(config, player_cmd=args.player)

    if args.setup_music:
        try:
            asyncio.run(_run_setup(config))
        except KeyboardInterrupt:
            pass
        return

    try:
        asyncio.run(_run(config, max_segments=args.max_segments))
    except KeyboardInterrupt:
        # Cleanup already ran in _run's finally before the interrupt propagated.
        pass


if __name__ == "__main__":
    main()
