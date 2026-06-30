"""AudioPlayer — the sole audio authority (spec 01 §3.5).

Plays one ``AudioClip`` at a time by handing its file to an external player
subprocess (e.g. ``afplay`` on macOS); ``stop()`` terminates that subprocess.
Only this component emits sound; nothing else in the core touches the speakers.

Two cancellation paths are deliberately distinguished:
- ``stop()`` cancels the inner playback task, so ``play()`` returns normally —
  this is the cancel-and-resume interjection (§3.3): a typed line stops the
  current segment and the Director decides what plays next.
- cancelling the ``play()`` call itself (shutdown / Ctrl-C) terminates the
  subprocess and propagates, so the program loop unwinds cleanly.
"""

from __future__ import annotations

import asyncio
import contextlib

from .contracts import AudioClip


class AudioPlayer:
    """Sole audio authority. One clip on air at a time; cancellable."""

    def __init__(self, player_cmd: str = "afplay") -> None:
        self._player_cmd: str = player_cmd
        self._current: asyncio.Task[None] | None = None

    async def play(self, clip: AudioClip) -> None:
        # Cancellation propagates — whether from stop() (an interjection cancels
        # the inner render task) or from this play() call being cancelled
        # (shutdown). asyncio cancels the inner task in both cases, and _render
        # terminates the subprocess on cancellation, so the speakers go quiet
        # either way. play() always runs as its own task, so propagating is
        # safe; the Director cleans the task up.
        self._current = asyncio.ensure_future(self._render(clip.source))
        try:
            await self._current
        finally:
            self._current = None

    async def stop(self) -> None:
        """Terminate the current playback, if any (the interjection signal)."""
        task = self._current
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _render(self, source: str) -> None:
        proc = await asyncio.create_subprocess_exec(
            self._player_cmd,
            source,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await proc.wait()
        except asyncio.CancelledError:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
            with contextlib.suppress(Exception):
                await proc.wait()
            raise
