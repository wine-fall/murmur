"""Real-I/O layer of the engine (spec 03-02 §3.1): wav loading is unit-fast;
ffmpeg decode and the sounddevice sink are integration-tagged (real binary /
real audio device, run on demand: pytest -m integration).
"""

from __future__ import annotations

import asyncio
import wave
from pathlib import Path

import numpy as np
import pytest

from murmur.engine.ffmpeg_io import FfmpegDecoder, load_voice_wav, stream_decodes

_ENGINE_SR = 8_000
_CH = 2


def _write_wav(path: Path, values: np.ndarray, *, rate: int, channels: int) -> None:
    pcm = (values * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())


def test_load_voice_wav_upmixes_mono_and_resamples(tmp_path: Path):
    # 16 kHz mono, constant 0.5, 0.1 s -> engine rate stereo, same duration.
    src_rate, seconds = 16_000, 0.1
    values = np.full(int(src_rate * seconds), 0.5, dtype=np.float32)
    path = tmp_path / "talk.wav"
    _write_wav(path, values, rate=src_rate, channels=1)

    out = load_voice_wav(str(path), samplerate=_ENGINE_SR, channels=_CH)
    assert out.dtype == np.float32
    assert out.shape[1] == _CH
    assert abs(len(out) - int(_ENGINE_SR * seconds)) <= 1
    assert np.allclose(out, 0.5, atol=0.01)
    assert np.array_equal(out[:, 0], out[:, 1])  # mono duplicated to stereo


def test_load_voice_wav_same_format_roundtrips(tmp_path: Path):
    frames = 64
    values = np.linspace(-0.5, 0.5, frames * _CH, dtype=np.float32).reshape(frames, _CH)
    path = tmp_path / "talk.wav"
    _write_wav(path, values, rate=_ENGINE_SR, channels=_CH)

    out = load_voice_wav(str(path), samplerate=_ENGINE_SR, channels=_CH)
    assert out.shape == (frames, _CH)
    assert np.allclose(out, values, atol=1e-3)  # int16 quantization only


@pytest.mark.integration
def test_ffmpeg_decoder_decodes_a_local_wav(tmp_path: Path):
    # Stereo fixture: ffmpeg's mono->stereo upmix applies a -3 dB pan law,
    # so a same-layout source keeps sample values exact.
    seconds = 0.25
    values = np.full((int(_ENGINE_SR * seconds), _CH), 0.5, dtype=np.float32)
    path = tmp_path / "music.wav"
    _write_wav(path, values, rate=_ENGINE_SR, channels=_CH)

    decoder = FfmpegDecoder(str(path), samplerate=_ENGINE_SR, channels=_CH)
    try:
        chunks = []
        while (block := decoder.read()) is not None:
            assert block.dtype == np.float32
            assert block.shape[1] == _CH
            chunks.append(block)
    finally:
        decoder.close()
    got = np.concatenate(chunks)
    assert abs(len(got) - int(_ENGINE_SR * seconds)) < _ENGINE_SR * 0.02
    assert np.allclose(got, 0.5, atol=0.01)


@pytest.mark.integration
def test_ffmpeg_decoder_raises_on_abnormal_exit(tmp_path: Path):
    # A source ffmpeg cannot open exits nonzero. read() must surface that as an
    # error (the "announced but silent" bug: a died decode used to look like a
    # clean end-of-stream), not return None.
    decoder = FfmpegDecoder(
        str(tmp_path / "does-not-exist.mp3"), samplerate=_ENGINE_SR, channels=_CH
    )
    try:
        with pytest.raises(RuntimeError, match="ffmpeg exited"):
            decoder.read()
    finally:
        decoder.close()


@pytest.mark.integration
def test_stream_decodes_probe_true_for_audio_false_for_a_dead_source(tmp_path: Path):
    # The pull-time playability probe (spec 04): a real file decodes -> True; a
    # source ffmpeg cannot open (the 403 stand-in) -> False, not a hang/raise.
    seconds = 0.25
    values = np.full((int(_ENGINE_SR * seconds), _CH), 0.5, dtype=np.float32)
    good = tmp_path / "music.wav"
    _write_wav(good, values, rate=_ENGINE_SR, channels=_CH)

    async def go():
        assert await stream_decodes(str(good), samplerate=_ENGINE_SR, channels=_CH)
        assert not await stream_decodes(
            str(tmp_path / "nope.mp3"), samplerate=_ENGINE_SR, channels=_CH
        )

    asyncio.run(go())


@pytest.mark.integration
def test_engine_plays_a_local_file_through_real_ffmpeg(tmp_path: Path):
    """Acceptance #5 (local-file half): the same engine, real decode, no
    audio device (the test pumps render() itself)."""
    from murmur.contracts import AudioClip
    from murmur.engine.core import AudioEngine

    seconds = 0.25
    values = np.full((int(_ENGINE_SR * seconds), _CH), 0.5, dtype=np.float32)
    path = tmp_path / "music.wav"
    _write_wav(path, values, rate=_ENGINE_SR, channels=_CH)

    async def go():
        eng = AudioEngine(
            decoder_factory=lambda src: FfmpegDecoder(
                src, samplerate=_ENGINE_SR, channels=_CH
            ),
            voice_loader=lambda src: load_voice_wav(
                src, samplerate=_ENGINE_SR, channels=_CH
            ),
            sink_factory=None,
            samplerate=_ENGINE_SR,
            channels=_CH,
        )
        handle = await eng.play_music(AudioClip(source=str(path), kind="music"))
        heard = False
        for _ in range(2_000):
            block = eng.render(80)
            # int16 quantization: 0.5 comes back as ~0.49997.
            if block.any() and np.allclose(block, 0.5, atol=0.01):
                heard = True
                break
            await asyncio.sleep(0.002)
        assert heard
        await handle.stop()
        await eng.aclose()

    asyncio.run(go())


@pytest.mark.integration
def test_sounddevice_sink_opens_and_pulls_blocks():
    from murmur.engine.ffmpeg_io import SounddeviceSink

    pulled = []

    def render(frames: int) -> np.ndarray:
        pulled.append(frames)
        return np.zeros((frames, _CH), dtype=np.float32)

    sink = SounddeviceSink(render, 48_000, _CH, 1_024)
    try:
        import time

        time.sleep(0.3)
    finally:
        sink.close()
    assert pulled  # the audio thread actually asked for blocks
