"""AudioPlayer — the sole audio authority (spec 01 §3.5).

Plays one ``AudioClip`` at a time and supports stop/cancel. Only this component
emits sound; nothing else in the core touches the speakers.

Step 1 of spec 01 ships a **simulated** player: it derives the clip's duration
(from the WAV header for the stub voice) and waits that long, so the loop is
correctly *paced* without requiring a real audio backend. Step 3 swaps the
playback body for an external player subprocess (e.g. ``afplay``) and makes
``stop()`` terminate it — the ``play()``/``stop()`` seam declared here does not
change.
"""

from __future__ import annotations

import asyncio
import contextlib
import wave
from pathlib import Path

from .contracts import AudioClip

_DEFAULT_SECONDS = 3.0


def _clip_duration_seconds(clip: AudioClip) -> float:
    """Best-effort duration for pacing. Reads the WAV header when possible."""
    try:
        with wave.open(clip.source, "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate() or 1
            return frames / rate
    except (wave.Error, OSError, EOFError):
        return _DEFAULT_SECONDS


class AudioPlayer:
    """Sole audio authority. One clip on air at a time; cancellable."""

    def __init__(self) -> None:
        self._current: asyncio.Task[None] | None = None

    async def play(self, clip: AudioClip) -> None:
        """Play ``clip`` to completion.

        Cancellation propagates: when the program is shutting down (Ctrl-C),
        the cancellation must unwind the loop cleanly. The cancel-and-resume
        *interjection* arbitration — where a user line cancels the current
        segment and the Director decides what plays next — is spec 01 step 3;
        it is built on top of ``stop()``, not baked into ``play()`` here.
        """
        seconds = _clip_duration_seconds(clip)
        self._current = asyncio.ensure_future(self._render(seconds))
        try:
            await self._current
        finally:
            self._current = None

    async def stop(self) -> None:
        """Cancel whatever is on air, if anything."""
        task = self._current
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _render(self, seconds: float) -> None:
        # Step 1: simulate playback by waiting the clip's duration. Step 3
        # replaces this with an external-player subprocess.
        await asyncio.sleep(seconds)
