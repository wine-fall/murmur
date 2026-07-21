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

import asyncio
import contextlib
import subprocess
import tempfile
import wave
from typing import IO, Any, Callable

import numpy as np

_CHUNK_FRAMES = 4_096


async def stream_decodes(
    source: str,
    *,
    samplerate: int,
    channels: int,
    ffmpeg: str = "ffmpeg",
    timeout_s: float = 6.0,
) -> bool:
    """Pull-time playability probe (spec 04): True if ffmpeg can open ``source``
    and decode at least one frame within ``timeout_s``. A resolved googlevideo
    URL that 403s never yields a frame (``read`` raises / returns None), so this
    returns False and the pick is dropped before it can be announced. Bounded and
    always tears the subprocess down — a hung stream times out to False, never
    leaks."""
    decoder = await asyncio.to_thread(
        FfmpegDecoder, source, samplerate=samplerate, channels=channels, ffmpeg=ffmpeg
    )

    def _first_frame() -> bool:
        try:
            return decoder.read() is not None
        except Exception:
            return False

    try:
        return await asyncio.wait_for(asyncio.to_thread(_first_frame), timeout_s)
    except asyncio.TimeoutError:
        return False
    finally:
        await asyncio.to_thread(decoder.close)  # terminates ffmpeg; unblocks read


class FfmpegDecoder:
    """One track's PCM source: an ffmpeg subprocess piping f32le to stdout.

    ``read`` blocks on the pipe and returns (frames, channels) float32 chunks;
    None at a clean end-of-stream, and RAISES if ffmpeg exited abnormally (a
    network 403 mid-stream, bad input) — a died-mid-track and a clean end used
    to be indistinguishable (both hit stdout EOF), which made an announced song
    that silently never played look identical to one that finished. ``close``
    terminates the subprocess (which unblocks a pending read) and reaps it — the
    no-orphans path (spec §5.4). ffmpeg's stderr goes to a temp file (not a pipe:
    an undrained stderr pipe would deadlock a long track), read back only on an
    abnormal exit to name the cause.
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
        self._closing = False  # our own terminate() -> not an ffmpeg failure
        self._errfile: IO[bytes] = tempfile.TemporaryFile()
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
            stderr=self._errfile,
        )

    def read(self) -> "np.ndarray[Any, np.dtype[np.float32]] | None":
        stdout = self._proc.stdout
        if stdout is None:
            return None
        while True:
            data = stdout.read(self._chunk_bytes)
            if not data:
                # stdout EOF. Clean end -> None; a nonzero exit that we did not
                # trigger means the decode failed -> raise so the feeder logs it
                # as an error instead of a silent, normal-looking end-of-stream.
                with contextlib.suppress(Exception):
                    self._proc.wait(timeout=2.0)
                rc = self._proc.returncode
                if not self._closing and rc not in (0, None):
                    raise RuntimeError(f"ffmpeg exited {rc}: {self._stderr_tail()}")
                return None  # EOF (a trailing partial frame is dropped)
            buf = self._remainder + data
            usable = len(buf) - (len(buf) % self._frame_bytes)
            self._remainder = buf[usable:]
            if usable:
                flat: Any = np.frombuffer(buf[:usable], dtype=np.float32)
                return flat.reshape(-1, self._channels)

    def _stderr_tail(self, limit: int = 500) -> str:
        try:
            self._errfile.seek(0)
            return self._errfile.read().decode("utf-8", "replace")[-limit:].strip()
        except Exception:
            return ""

    def close(self) -> None:
        self._closing = True
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
        with contextlib.suppress(Exception):
            self._errfile.close()


class SounddeviceSink:
    """The one output stream. Pulls mixed blocks from ``render`` on the
    PortAudio callback thread; any render failure outputs silence for that
    block rather than killing the stream (a glitch, not a crash)."""

    def __init__(
        self,
        render: Callable[[int], np.ndarray[Any, np.dtype[np.float32]]],
        samplerate: int,
        channels: int,
        blocksize: int,
    ) -> None:
        import sounddevice  # lazy: unit tests never import the audio stack

        def _callback(outdata: Any, frames: int, _time: Any, _status: Any) -> None:
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
