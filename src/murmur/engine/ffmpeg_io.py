"""Real I/O for the engine (spec 03-02 §3.1): ffmpeg decode, sounddevice out,
wav voice loading.

ffmpeg owns network + decode + resample (`-f f32le -ar <rate> -ac <ch>`); the
engine only mixes. The sounddevice sink is the ONE output stream (sole audio
authority); its PortAudio callback calls ``AudioEngine.render``. Voice wavs
(spec 02 clips) are short local files, loaded whole and normalized to the mix
format here.
"""

# numpy's array-construction stubs (frombuffer/stack/tile) are partially
# unknown under pyright strict, and sounddevice ships no stubs; both are
# confined to this real-I/O module.
# pyright: reportUnknownMemberType=false, reportMissingTypeStubs=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

import contextlib
import subprocess
import wave
from typing import Any, Callable

import numpy as np

_CHUNK_FRAMES = 4_096


class FfmpegDecoder:
    """One track's PCM source: an ffmpeg subprocess piping f32le to stdout.

    ``read`` blocks on the pipe and returns (frames, channels) float32 chunks;
    None at end-of-stream. ``close`` terminates the subprocess (which unblocks
    a pending read) and reaps it — the no-orphans path (spec §5.4).
    """

    def __init__(
        self,
        source: str,
        *,
        samplerate: int,
        channels: int,
        ffmpeg: str = "ffmpeg",
    ) -> None:
        self._channels = channels
        self._frame_bytes = 4 * channels
        self._chunk_bytes = _CHUNK_FRAMES * self._frame_bytes
        self._remainder = b""
        self._proc = subprocess.Popen(
            [
                ffmpeg,
                "-nostdin",
                "-loglevel",
                "error",
                "-i",
                source,
                "-f",
                "f32le",
                "-ar",
                str(samplerate),
                "-ac",
                str(channels),
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def read(self) -> "np.ndarray[Any, np.dtype[np.float32]] | None":
        stdout = self._proc.stdout
        if stdout is None:
            return None
        while True:
            data = stdout.read(self._chunk_bytes)
            if not data:
                return None  # EOF (a trailing partial frame is dropped)
            buf = self._remainder + data
            usable = len(buf) - (len(buf) % self._frame_bytes)
            self._remainder = buf[usable:]
            if usable:
                flat: Any = np.frombuffer(buf[:usable], dtype=np.float32)
                return flat.reshape(-1, self._channels)

    def close(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.terminate()
        if self._proc.stdout is not None:
            with contextlib.suppress(Exception):
                self._proc.stdout.close()
        with contextlib.suppress(Exception):
            self._proc.wait(timeout=2.0)
        if self._proc.poll() is None:  # still alive -> escalate, never orphan
            with contextlib.suppress(Exception):
                self._proc.kill()
                self._proc.wait(timeout=1.0)


class SounddeviceSink:
    """The one output stream. Pulls mixed blocks from ``render`` on the
    PortAudio callback thread; any render failure outputs silence for that
    block rather than killing the stream (a glitch, not a crash)."""

    def __init__(
        self,
        render: Callable[[int], Any],
        samplerate: int,
        channels: int,
        blocksize: int,
    ) -> None:
        import sounddevice  # lazy: unit tests never import the audio stack

        def _callback(
            outdata: Any, frames: int, _time: Any, _status: Any
        ) -> None:
            try:
                outdata[:] = render(frames)
            except Exception:
                outdata.fill(0.0)

        self._stream = sounddevice.OutputStream(
            samplerate=samplerate,
            channels=channels,
            blocksize=blocksize,
            dtype="float32",
            callback=_callback,
        )
        self._stream.start()

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._stream.stop()
        with contextlib.suppress(Exception):
            self._stream.close()


def load_voice_wav(
    path: str, *, samplerate: int, channels: int
) -> "np.ndarray[Any, np.dtype[np.float32]]":
    """Load a (short) voice wav and normalize to the mix format (spec §3.3):
    float32 in [-1, 1], resampled to ``samplerate``, up/down-mixed to
    ``channels``."""
    with wave.open(path, "rb") as wav:
        n_channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())

    if width == 2:
        flat: Any = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        flat = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported wav sample width: {width} bytes")
    pcm = flat.reshape(-1, n_channels)

    if rate != samplerate:
        src_n = len(pcm)
        dst_n = max(1, int(round(src_n * samplerate / rate)))
        src_t = np.arange(src_n, dtype=np.float64)
        dst_t = np.linspace(0.0, src_n - 1, dst_n)
        pcm = np.stack(
            [np.interp(dst_t, src_t, pcm[:, c]) for c in range(n_channels)],
            axis=1,
        ).astype(np.float32)

    if n_channels < channels:
        pcm = np.tile(pcm[:, :1], (1, channels))
    elif n_channels > channels:
        pcm = pcm[:, :channels]
    return np.ascontiguousarray(pcm, dtype=np.float32)
