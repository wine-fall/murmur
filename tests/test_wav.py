"""SilentClipWriter — the shared no-model clip writer (spec 02 §3.5 / spec 01).

One source of truth for the temp-dir + counter + ``clip-NNNN.wav`` convention
used by both the stub VoiceProvider and the sidecar FakeBackend, so the two
no-model paths cannot drift apart.
"""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from murmur.voice._wav import SilentClipWriter, wav_seconds, write_silent_wav


def test_writes_distinct_numbered_mono_clips():
    writer = SilentClipWriter(prefix="murmur-test-")
    p1 = writer.write("hello")
    p2 = writer.write("world")
    assert Path(p1).name == "clip-0001.wav"
    assert Path(p2).name == "clip-0002.wav"
    assert Path(p1).exists() and Path(p2).exists()
    with wave.open(p1, "rb") as w:
        assert w.getnchannels() == 1
        assert w.getnframes() > 0
    writer.close()


def test_close_removes_the_dir_and_resets():
    writer = SilentClipWriter(prefix="murmur-test-")
    clip_dir = Path(writer.write("hi")).parent
    assert clip_dir.exists()
    writer.close()
    assert not clip_dir.exists()
    assert not writer.started


def test_wav_seconds_reads_the_clip_duration(tmp_path):
    path = tmp_path / "clip.wav"
    write_silent_wav(path, seconds=2.0)
    assert wav_seconds(path) == pytest.approx(2.0, abs=0.01)


def test_start_is_idempotent():
    writer = SilentClipWriter(prefix="murmur-test-")
    writer.start()
    first_dir = Path(writer.write("a")).parent
    writer.start()  # no-op — same dir
    assert Path(writer.write("b")).parent == first_dir
    writer.close()
