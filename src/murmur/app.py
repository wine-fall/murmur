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

from .brain import ClaudeBrain, build_brain
from .cadence import CadencePolicy, build_cadence
from .cli_host import CliHost
from .config import Config
from .contracts import MusicProvider
from .director import Director
from .engine import build_engine
from .logging_setup import configure_dev_logging
from .memory import InProcessMemoryStore
from .music.programmer import MusicProgrammer, TrackSource
from .music.provider import YtDlpMusicProvider
from .persona import load_persona
from .startup import MusicStartupCheck, run_startup_checks
from .voice import PROFILES, build_voice


async def _run(config: Config, *, max_segments: int | None) -> None:
    persona = load_persona(config.persona_path)

    cli = CliHost()
    memory = InProcessMemoryStore()
    voice = build_voice(
        config.voice_provider,
        tts_url=config.tts_url,
        tts_reference_id=config.tts_reference_id,
        tts_api_key=config.tts_api_key,
        tts_seed=config.tts_seed,
    )
    player = build_engine(ffmpeg=config.ffmpeg_cmd)
    brain = build_brain(config.brain_provider, model=config.model)

    await voice.start()
    cli.banner(
        persona.splitlines()[0] if persona else "(empty)",
        brain=config.brain_provider,
        voice=config.voice_provider,
    )
    cli.start()

    # Startup checks (spec 03-02 §2.4): music is on by default and needs the
    # real brain (the stub has no harness); a failed/declined check degrades
    # the session to talk-only — the radio still starts.
    provider: MusicProvider | None = None
    music: TrackSource | None = None
    cadence: CadencePolicy | None = None
    if config.music_enabled and isinstance(brain, ClaudeBrain):
        results = await run_startup_checks(
            cli,
            [
                MusicStartupCheck(
                    brain, ytdlp=config.ytdlp_cmd, ffmpeg=config.ffmpeg_cmd
                )
            ],
        )
        if results.get("music"):
            provider = YtDlpMusicProvider(config.ytdlp_cmd)
            await provider.start()
            music = MusicProgrammer(
                brain=brain, provider=provider, model=config.music_model
            )
            cadence = build_cadence(
                config.cadence_mode,
                every_n=config.music_every_n,
                brain=brain,
                model=config.music_model,
            )
        else:
            cli.info(
                "music is off this session (talk-only). Fix later with: "
                "murmur --setup-music"
            )
    elif config.music_enabled:
        cli.info("music needs the claude brain; running talk-only.")

    director = Director(
        config=config,
        persona=persona,
        brain=brain,
        voice=voice,
        player=player,
        memory=memory,
        cli_host=cli,
        music=music,
        cadence=cadence,
    )
    try:
        await director.run(max_segments=max_segments)
    finally:
        # Orderly shutdown (§3.6): stop all audio (voice + music, no orphaned
        # ffmpeg), close the providers. Best-effort even via Ctrl-C.
        with contextlib.suppress(asyncio.CancelledError):
            await player.aclose()
        if provider is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await provider.aclose()
        with contextlib.suppress(asyncio.CancelledError):
            await voice.aclose()
        cli.info("stopped cleanly.")


async def _run_setup(config: Config) -> None:
    """Run the music (yt-dlp) preflight + guide harness, routed through the CLI
    Host (spec 03-03). Explicit entry for now (``--setup-music``); the auto
    startup-preflight + in-conversation trigger is a later UX refinement."""
    from .setup import run_music_setup

    cli = CliHost()
    cli.start()  # spawn the stdin reader so the guide's confirms can be answered
    await run_music_setup(
        cli, ClaudeBrain(config.model), ytdlp=config.ytdlp_cmd, ffmpeg=config.ffmpeg_cmd
    )


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
        # Derived from the backend registry so a new PROFILES row is CLI-selectable
        # without editing this list. 'spark' is primary; 'sidecar-fake' exists for
        # internal plumbing diagnostics (intentionally not offered here).
        choices=["stub", "remote", *sorted(PROFILES)],
        default=None,
        help=(
            "VoiceProvider: 'stub' (silent wav, no sidecar/model), a real MLX "
            "voice via the warm sidecar ('spark' is primary), or 'remote' "
            "(off-machine HTTP TTS — set MURMUR_TTS_URL; spec 02 §3.6)."
        ),
    )
    p.add_argument(
        "--no-music",
        action="store_true",
        help="skip the music startup check and scheduling (talk-only session)",
    )
    p.add_argument(
        "--cadence",
        choices=["every_n", "random", "brain"],
        default=None,
        help=(
            "talk<->music scheduling mode (default: every_n; 'brain' spends a "
            "cheap model call per segment boundary)"
        ),
    )
    p.add_argument(
        "--setup-music",
        action="store_true",
        help="run the yt-dlp music preflight + setup/repair guide, then exit (spec 03-03)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    # Dev-only: if $MURMUR_DEV_LOG is set (make dev sets it), stream diagnostics
    # to that file for `make logs` to tail. A no-op otherwise (shipping default).
    configure_dev_logging()
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
    if args.no_music:
        config = replace(config, music_enabled=False)
    if args.cadence is not None:
        config = replace(config, cadence_mode=args.cadence)

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
