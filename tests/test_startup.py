"""Startup checks phase (spec 03-02 §2.4): extensible, decoupled, gate music.

Acceptance #9: checks run before broadcasting through one seam; a second
registered fake check runs without any app-loop change; the music check wraps
03-03's run_music_setup and its result gates music for the session.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fakes import FakeCli, FakeGuideBrain

from murmur.music.preflight import PreflightResult
from murmur.startup import MusicStartupCheck, run_startup_checks


class _FakeCheck:
    def __init__(self, name: str, result: bool, log: list[str]) -> None:
        self.name = name
        self._result = result
        self._log = log

    async def run(self, host: Any) -> bool:
        self._log.append(self.name)
        return self._result


def test_checks_run_in_order_and_results_are_collected():
    log: list[str] = []
    checks = [_FakeCheck("music", True, log), _FakeCheck("future-thing", False, log)]

    async def go():
        return await run_startup_checks(FakeCli(), checks)

    results = asyncio.run(go())
    # The seam is real: the second check ran with no app-loop change, and a
    # failing check does not abort the phase (features degrade, radio starts).
    assert log == ["music", "future-thing"]
    assert results == {"music": True, "future-thing": False}


def test_music_check_passes_without_touching_the_brain_when_healthy():
    brain = FakeGuideBrain()

    async def healthy(binary: str) -> PreflightResult:
        return PreflightResult(ok=True, reason="")

    async def go():
        check = MusicStartupCheck(brain, ytdlp="yt-dlp", check=healthy)
        return await check.run(FakeCli())

    assert asyncio.run(go()) is True
    assert brain.calls == 0  # deterministic preflight only — 0 tokens


def test_music_check_returns_false_when_broken_and_user_declines():
    brain = FakeGuideBrain()

    async def broken(binary: str) -> PreflightResult:
        return PreflightResult(ok=False, reason="no such binary")

    async def go():
        cli = FakeCli(lines=["n"])  # decline the guide offer
        check = MusicStartupCheck(brain, ytdlp="yt-dlp", check=broken)
        return await check.run(cli)

    assert asyncio.run(go()) is False
    assert brain.calls == 0  # declined -> the guide never ran
