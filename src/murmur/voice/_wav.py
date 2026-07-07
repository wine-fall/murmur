"""Silent-wav helpers shared by the no-model voice paths.

Both the spec-01 stub ``VoiceProvider`` and the spec-02 sidecar ``FakeBackend``
need to write a complete, real (silent) wav whose duration scales with the text,
so playback pacing feels like a real spoken segment without any TTS model. This
keeps that logic in one place.
"""

from __future__ import annotations

import shutil
import tempfile
import wave
from pathlib import Path

SAMPLE_RATE = 16_000
_MIN_SECONDS = 1.5
_SECONDS_PER_CHAR = 0.18  # rough speaking pace, for realistic playback timing
_MAX_SECONDS = 20.0


def estimate_seconds(text: str) -> float:
    """A plausible spoken duration for ``text`` (bounded), so a silent clip
    occupies the air for about as long as real speech would."""
    return max(_MIN_SECONDS, min(_MAX_SECONDS, len(text) * _SECONDS_PER_CHAR))


def wav_seconds(path: Path | str) -> float:
    """Duration of a wav in seconds (frames / framerate). Used to report the
    spoken length of a synthesized clip so callers can compute a real-time
    factor (generation time / audio duration)."""
    with wave.open(str(path), "rb") as wav:
        rate = wav.getframerate()
        return wav.getnframes() / rate if rate else 0.0


def write_silent_wav(
    path: Path, seconds: float, sample_rate: int = SAMPLE_RATE
) -> None:
    frames = int(sample_rate * seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * frames)


class SilentClipWriter:
    """A lazily-created temp dir that hands out successive ``clip-NNNN.wav``
    silent clips. The single source of truth for the no-model clip convention,
    shared by the spec-01 stub provider and the spec-02 sidecar FakeBackend so
    the two no-model paths cannot drift apart.
    """

    def __init__(self, prefix: str) -> None:
        self._prefix = prefix
        self._dir: Path | None = None
        self._counter: int = 0

    @property
    def started(self) -> bool:
        return self._dir is not None

    def start(self) -> None:
        if self._dir is None:
            self._dir = Path(tempfile.mkdtemp(prefix=self._prefix))

    def write(self, text: str) -> str:
        """Write the next silent clip (duration scaled to ``text``); return its path."""
        self.start()
        assert self._dir is not None
        self._counter += 1
        path = self._dir / f"clip-{self._counter:04d}.wav"
        write_silent_wav(path, estimate_seconds(text))
        return str(path)

    def close(self) -> None:
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None
