"""The mixing audio engine (spec 03-02).

Replaces the spec-01 afplay ``AudioPlayer`` as the sole audio authority: one
output stream, two logical channels (music + voice), sample-level mixing with
a gain-envelope duck. ``mixer`` holds the pure math; ``core`` the engine,
handles, and buffer plumbing (testable with fakes); ``ffmpeg_io`` the real
decoder + sounddevice sink (integration layer).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from .core import AudioEngine


def build_probe(*, ffmpeg: str = "ffmpeg") -> Callable[[str], Awaitable[bool]]:
    """A pull-time playability probe (spec 04) for the music pick pipeline: does
    this resolved stream actually decode? Same ffmpeg/format as ``build_engine``,
    off the audio path (opened, one frame read, torn down)."""
    from .ffmpeg_io import stream_decodes

    samplerate, channels = 48_000, 2

    async def probe(source: str) -> bool:
        return await stream_decodes(
            source, samplerate=samplerate, channels=channels, ffmpeg=ffmpeg
        )

    return probe


def build_engine(*, ffmpeg: str = "ffmpeg") -> AudioEngine:
    """The production engine: ffmpeg decode, wav voice loading, sounddevice
    out (opened lazily on first play). 48 kHz stereo float32 (spec §3.1)."""
    from .ffmpeg_io import FfmpegDecoder, SounddeviceSink, load_voice_wav

    samplerate, channels = 48_000, 2
    return AudioEngine(
        decoder_factory=lambda source: FfmpegDecoder(
            source, samplerate=samplerate, channels=channels, ffmpeg=ffmpeg
        ),
        voice_loader=lambda source: load_voice_wav(
            source, samplerate=samplerate, channels=channels
        ),
        sink_factory=SounddeviceSink,
        samplerate=samplerate,
        channels=channels,
    )


__all__ = ["AudioEngine", "build_engine", "build_probe"]
