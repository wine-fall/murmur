"""TtsBackend / FakeBackend + the sidecar serve() loop (spec 02 §3.1-§3.5).

All unit, no heavy model: the FakeBackend writes a silent wav, and serve() is
driven over in-memory text streams (io.StringIO) instead of a real subprocess.
The real-subprocess path is exercised in step 2 (the supervising client).
"""

from __future__ import annotations

import io
import wave
from pathlib import Path

import pytest

from murmur.voice.backend import FakeBackend, SynthesisRequest
from murmur.voice.protocol import decode, encode
from murmur.voice.sidecar import build_backend, serve


def _run_serve(backend, requests: list[dict]) -> list[dict]:
    """Feed encoded request dicts through serve(); return decoded responses."""
    stdin = io.StringIO("".join(encode(r) for r in requests))
    stdout = io.StringIO()
    serve(backend, stdin=stdin, stdout=stdout)
    return [decode(line + "\n") for line in stdout.getvalue().splitlines()]


class _SpyBackend:
    """Records call order; returns a fixed path. Not a FakeBackend so warm()
    never reaches a model/synth path."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def load(self) -> None:
        self.calls.append("load")

    def warm(self) -> None:
        self.calls.append("warm")

    def synthesize(self, req: SynthesisRequest) -> str:
        self.calls.append("synthesize")
        return "/tmp/spy.wav"


class _FailingBackend:
    """Healthy load/warm, but synthesize blows up — to prove the loop survives a
    backend failure and keeps serving."""

    def load(self) -> None:
        pass

    def warm(self) -> None:
        pass

    def synthesize(self, req: SynthesisRequest) -> str:
        raise RuntimeError("kaboom")


# --- FakeBackend ---------------------------------------------------------- #


def test_fake_backend_synthesize_writes_a_real_mono_wav():
    backend = FakeBackend()
    backend.load()
    path = backend.synthesize(SynthesisRequest(text="hello there"))
    assert Path(path).exists()
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1
        assert w.getnframes() > 0


def test_fake_backend_synthesize_implicitly_loads():
    # Robust to being called before load() (mirrors the stub provider).
    path = FakeBackend().synthesize(SynthesisRequest(text="hi"))
    assert Path(path).exists()


# --- serve() loop --------------------------------------------------------- #


def test_serve_loads_and_warms_before_first_request():
    spy = _SpyBackend()
    resps = _run_serve(spy, [{"op": "health"}])
    assert spy.calls[:2] == ["load", "warm"]
    assert resps == [{"ready": True}]


def test_serve_synthesize_returns_an_existing_wav_path():
    resps = _run_serve(FakeBackend(), [{"op": "synthesize", "request": {"text": "hi"}}])
    assert len(resps) == 1
    assert Path(resps[0]["audio_path"]).exists()


def test_serve_synthesize_reports_timings():
    # gen_s (model time) + audio_s (clip duration) so the parent can log rtf.
    resps = _run_serve(
        FakeBackend(), [{"op": "synthesize", "request": {"text": "hello there"}}]
    )
    timings = resps[0]["timings"]
    assert timings["gen_s"] >= 0.0
    assert timings["audio_s"] > 0.0  # the silent clip has a real duration


def test_first_synthesize_carries_load_and_warm_timings_then_not():
    # load/warm happen once at startup (before any request) — ride the first
    # synth response, and never repeat on later ones.
    resps = _run_serve(
        FakeBackend(),
        [
            {"op": "synthesize", "request": {"text": "one"}},
            {"op": "synthesize", "request": {"text": "two"}},
        ],
    )
    assert "load_s" in resps[0]["timings"] and "warm_s" in resps[0]["timings"]
    assert "load_s" not in resps[1]["timings"]


def test_serve_unknown_op_returns_error_and_keeps_serving():
    resps = _run_serve(FakeBackend(), [{"op": "bogus"}, {"op": "health"}])
    assert "error" in resps[0]
    assert resps[1] == {"ready": True}  # the loop survived the bad request


def test_serve_synthesize_missing_text_returns_error():
    resps = _run_serve(
        FakeBackend(), [{"op": "synthesize", "request": {}}, {"op": "health"}]
    )
    assert "error" in resps[0]
    assert resps[1] == {"ready": True}


def test_serve_backend_failure_returns_error_and_keeps_serving():
    resps = _run_serve(
        _FailingBackend(),
        [{"op": "synthesize", "request": {"text": "hi"}}, {"op": "health"}],
    )
    assert "error" in resps[0] and "kaboom" in resps[0]["error"]
    assert resps[1] == {"ready": True}


def test_serve_skips_blank_lines():
    stdin = io.StringIO("\n" + encode({"op": "health"}) + "\n")
    stdout = io.StringIO()
    serve(FakeBackend(), stdin=stdin, stdout=stdout)
    resps = [decode(line + "\n") for line in stdout.getvalue().splitlines()]
    assert resps == [{"ready": True}]


# --- backend factory ------------------------------------------------------ #


def test_build_backend_fake():
    assert isinstance(build_backend("fake"), FakeBackend)


def test_build_backend_unknown_raises():
    with pytest.raises(ValueError):
        build_backend("nope")
