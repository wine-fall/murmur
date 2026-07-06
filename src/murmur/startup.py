"""Startup checks phase (spec 03-02 §2.4) — extensible environment preflight.

The app runs the registered checks in order before broadcasting. Each check is
interactive-capable (it talks through the CLI Host) and returns whether its
feature is usable; a False degrades that feature for the session, never aborts
the radio. The seam exists so future onboarding checks (other providers,
models, credentials) slot in without touching the app loop.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Protocol, runtime_checkable

from .cli_host import Host
from .harness import GuideCapable
from .music.preflight import PreflightResult, preflight_music
from .setup import run_music_setup


@runtime_checkable
class StartupCheck(Protocol):
    name: str

    async def run(self, host: Host) -> bool:
        """Check (and optionally interactively repair) one feature's
        environment; True means the feature is usable this session."""
        ...


async def run_startup_checks(
    host: Host, checks: Sequence[StartupCheck]
) -> dict[str, bool]:
    """Run every registered check in order; collect name -> usable. A failing
    check never stops the phase — features degrade, the radio still starts."""
    results: dict[str, bool] = {}
    for check in checks:
        results[check.name] = await check.run(host)
    return results


class MusicStartupCheck:
    """The first (and, here, only) check: yt-dlp preflight + guide offer,
    delegating to 03-03's ``run_music_setup`` verbatim. This is where 03-03's
    'automatic trigger' lands."""

    name = "music"

    def __init__(
        self,
        brain: GuideCapable,
        *,
        ytdlp: str = "yt-dlp",
        ffmpeg: str = "ffmpeg",
        check: Callable[..., Awaitable[PreflightResult]] = preflight_music,
    ) -> None:
        self._brain = brain
        self._ytdlp = ytdlp
        self._ffmpeg = ffmpeg
        self._check = check

    async def run(self, host: Host) -> bool:
        return await run_music_setup(
            host,
            self._brain,
            ytdlp=self._ytdlp,
            ffmpeg=self._ffmpeg,
            check=self._check,
        )
