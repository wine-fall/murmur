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
import shutil
from dataclasses import replace
from pathlib import Path

from .brain import ClaudeBrain, build_brain
from .cadence import CadencePolicy, build_cadence
from .cli_host import CliHost
from .compaction import Compactor
from .config import Config
from .contracts import MemoryStore, MusicProvider
from .director import Director
from .engine import build_engine, build_probe
from .logging_setup import configure_dev_logging
from .memory import InProcessMemoryStore, PersistentMemoryStore
from .music.programmer import MusicProgrammer, TrackSource
from .music.provider import YtDlpMusicProvider
from .persona import load_persona
from .startup import MusicStartupCheck, run_startup_checks
from .voice import PROFILES, build_voice


def build_memory(config: Config, *, persistent: bool) -> MemoryStore:
    """The memory store for a run (spec 05 §3.7). A real (claude) run persists to
    ``memory_dir``; a stub run stays in-process so canned chatter never touches
    the real memory dir (stub isolation)."""
    if persistent:
        return PersistentMemoryStore(config.memory_dir)
    return InProcessMemoryStore()


def resolve_persona_path(config: Config, *, persistent: bool) -> Path:
    """Where to load the persona from (spec 05 §3.2). On a persistent run the
    persona is homed in the memory dir (the living asset's writable home for
    spec 06): the seed is copied there once on first run, and loaded from there
    thereafter. A stub run loads the seed directly (no memory-dir writes)."""
    if not persistent:
        return config.persona_path
    home = config.memory_dir / "persona.md"
    if not home.exists():
        config.memory_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(config.persona_path, home)
    return home


async def _run(config: Config, *, max_segments: int | None) -> None:
    # A real (claude) run persists memory + homes the persona in the memory dir;
    # a stub run stays fully in-process (spec 05 §3.2/§3.7).
    persistent = config.brain_provider == "claude"
    persona = load_persona(resolve_persona_path(config, persistent=persistent))

    cli = CliHost()
    memory = build_memory(config, persistent=persistent)
    voice = build_voice(
        config.voice_provider,
        tts_url=config.tts_url,
        tts_reference_id=config.tts_reference_id,
        tts_api_key=config.tts_api_key,
        tts_seed=config.tts_seed,
        tts_model=config.tts_model,
        tts_sentence_pad_s=config.tts_sentence_pad_s,
    )
    player = build_engine(ffmpeg=config.ffmpeg_cmd)
    brain = build_brain(config.brain_provider, model=config.model)

    # Periodic profile compaction (spec 05 §3.6), off the live loop, only when
    # persisting: a dedicated cheap-tier brain folds history into profile.md.
    # An in-process (stub) store has no compaction surface, so no compactor.
    compactor: Compactor | None = None
    if isinstance(memory, PersistentMemoryStore):
        compactor = Compactor(memory, ClaudeBrain(config.compact_model))

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
                brain=brain,
                provider=provider,
                model=config.music_model,
                probe=build_probe(ffmpeg=config.ffmpeg_cmd),
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

    # Background bed (spec 03-04): a one-time loading pull of the curated
    # manifest into the local cache (onboarding-style, off the audio path), then
    # start the continuous backdrop before the first talk. Degrades to no bed on
    # any failure (offline / empty cache / --no-bed) — the radio still starts.
    if config.bed_enabled:
        from .bed import (
            DEFAULT_CACHE_DIR,
            DEFAULT_MANIFEST,
            CachedBedSource,
            pull_bed,
            ytdlp_download,
        )

        async def _download(ref: str, dest_base: Path) -> None:
            await ytdlp_download(ref, dest_base, ytdlp=config.ytdlp_cmd)

        if not CachedBedSource(DEFAULT_CACHE_DIR).tracks():
            cli.info(
                "preparing background music (one-time setup — downloading a few "
                "tracks; this only happens on first run)..."
            )
        await pull_bed(
            manifest=DEFAULT_MANIFEST,
            cache_dir=DEFAULT_CACHE_DIR,
            download=_download,
            log=cli.info,
        )
        bed_source = CachedBedSource(DEFAULT_CACHE_DIR)
        if bed_source.tracks():
            await player.start_bed(bed_source)
        else:
            cli.info("no background bed this session (empty cache).")

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
        compactor=compactor,
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
        # Final compaction flush (spec 05 §3.6): fold any remaining backlog so a
        # long session's tail lands in the profile. Best-effort; never blocks exit
        # on failure (the Compactor swallows its own errors).
        if compactor is not None:
            with contextlib.suppress(Exception):
                await compactor.flush()
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
    # Remote-backend overrides (spec 02 §3.6): switch endpoint / hosted model /
    # voice from the command line without editing the env, e.g. local -> fish.audio
    #   --voice remote --tts-url https://api.fish.audio --tts-model s2.1-pro-free
    # Only consulted with --voice remote; the API key stays env-only (secret).
    p.add_argument(
        "--tts-url",
        default=None,
        metavar="URL",
        help="remote TTS endpoint (overrides MURMUR_TTS_URL)",
    )
    p.add_argument(
        "--tts-model",
        default=None,
        metavar="NAME",
        help="remote 'model' header, e.g. fish.audio 's2.1-pro-free' (overrides MURMUR_TTS_MODEL)",
    )
    p.add_argument(
        "--tts-reference",
        default=None,
        metavar="ID",
        help="remote voice/reference id (overrides MURMUR_TTS_REFERENCE_ID)",
    )
    p.add_argument(
        "--no-music",
        action="store_true",
        help="skip the music startup check and scheduling (talk-only session)",
    )
    p.add_argument(
        "--no-bed",
        action="store_true",
        help="skip the always-on background music bed (spec 03-04)",
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


def _apply_overrides(config: Config, args: argparse.Namespace) -> Config:
    """Layer CLI flags over the (env-derived) Config — a flag left unset keeps the
    config value. This is what lets you switch backend / hosted model / voice from
    the command line (e.g. local -> fish.audio) without editing the env."""
    if args.persona is not None:
        config = replace(config, persona_path=args.persona)
    if args.gap is not None:
        config = replace(config, inter_segment_gap=args.gap)
    if args.brain is not None:
        config = replace(config, brain_provider=args.brain)
    if args.voice is not None:
        config = replace(config, voice_provider=args.voice)
    if args.tts_url is not None:
        config = replace(config, tts_url=args.tts_url)
    if args.tts_model is not None:
        config = replace(config, tts_model=args.tts_model)
    if args.tts_reference is not None:
        config = replace(config, tts_reference_id=args.tts_reference)
    if args.no_music:
        config = replace(config, music_enabled=False)
    if args.no_bed:
        config = replace(config, bed_enabled=False)
    if args.cadence is not None:
        config = replace(config, cadence_mode=args.cadence)
    return config


def main(argv: list[str] | None = None) -> None:
    # Dev-only: if $MURMUR_DEV_LOG is set (make dev sets it), stream diagnostics
    # to that file for `make logs` to tail. A no-op otherwise (shipping default).
    configure_dev_logging()
    args = _parse_args(argv)
    config = _apply_overrides(Config.default(), args)

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
