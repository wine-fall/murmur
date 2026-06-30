"""Stub VoiceProvider (spec 01 §4 — exercises the loop with no spec-02 code).

Writes a complete, real (silent) WAV file to a temp dir and returns it as an
``AudioClip(kind="talk")``. The clip's duration scales with text length so the
AudioPlayer's pacing feels like a real spoken segment. This proves the
``VoiceProvider`` seam: the core synthesizes and plays without any TTS model
present. Spec 02 drops in a real adapter behind the same Protocol.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
import wave
from pathlib import Path

from ..contracts import AudioClip

_SAMPLE_RATE = 16_000
_MIN_SECONDS = 1.5
_SECONDS_PER_CHAR = 0.18  # rough speaking pace, for realistic playback timing
_MAX_SECONDS = 20.0


def _estimate_seconds(text: str) -> float:
    return max(_MIN_SECONDS, min(_MAX_SECONDS, len(text) * _SECONDS_PER_CHAR))


class StubVoiceProvider:
    """Silent-WAV VoiceProvider. Satisfies the ``VoiceProvider`` Protocol."""

    def __init__(self) -> None:
        self._dir: Path | None = None
        self._counter: int = 0

    async def start(self) -> None:
        # Idempotent: a warm "backend" here is just a temp dir for clips.
        if self._dir is None:
            self._dir = Path(tempfile.mkdtemp(prefix="murmur-voice-"))

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        if self._dir is None:
            await self.start()
        assert self._dir is not None

        seconds = _estimate_seconds(text)
        self._counter += 1
        path = self._dir / f"clip-{self._counter:04d}.wav"

        # Writing the WAV is fast but blocking; keep the event loop responsive.
        await asyncio.to_thread(_write_silent_wav, path, seconds)
        return AudioClip(source=str(path), kind="talk")

    async def aclose(self) -> None:
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None


def _write_silent_wav(path: Path, seconds: float) -> None:
    frames = int(_SAMPLE_RATE * seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(_SAMPLE_RATE)
        wav.writeframes(b"\x00\x00" * frames)
