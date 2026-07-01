"""Real MLX TTS synthesis across the four L0 backends — integration, on demand
only (DESIGN §11.2/§11.3).

Excluded from the fast suite (marked ``integration``); run deliberately with the
``tts-mlx`` extra installed:  ``pytest -m integration``. Loads each real model and
renders a clip — slow (seconds + multi-GB downloads on first run). Auto-skips if
mlx-audio is not installed. It checks that a real, non-empty wav is produced;
whether the voice *sounds human* (and which one wins the blind A/B) is human
acceptance, not this test.
"""

from __future__ import annotations

import importlib.util
import wave
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration

_MLX_AVAILABLE = importlib.util.find_spec("mlx_audio") is not None


@pytest.mark.skipif(not _MLX_AVAILABLE, reason="mlx-audio not installed ([tts-mlx])")
@pytest.mark.parametrize("name", ["spark", "qwen3", "chatterbox", "dia"])
def test_mlx_backend_renders_a_real_nonempty_wav(name):
    from murmur.voice.backend import SynthesisRequest
    from murmur.voice.sidecar import build_backend

    backend = build_backend(name)
    backend.load()
    backend.warm()
    path = backend.synthesize(SynthesisRequest(text="Hello, this is a test."))
    assert Path(path).exists()
    with wave.open(path, "rb") as w:
        assert w.getnframes() > 0


@pytest.mark.skipif(not _MLX_AVAILABLE, reason="mlx-audio not installed ([tts-mlx])")
def test_mlx_backend_stays_warm_across_calls():
    # Acceptance §2: the model loads once; later calls do not reload it.
    from murmur.voice.backend import SynthesisRequest
    from murmur.voice.sidecar import build_backend

    backend = build_backend("spark")
    backend.load()
    model_after_load = backend._model
    backend.warm()
    p1 = backend.synthesize(SynthesisRequest(text="One."))
    p2 = backend.synthesize(SynthesisRequest(text="Two."))
    assert backend._model is model_after_load  # never reloaded
    assert p1 != p2
    assert Path(p1).exists() and Path(p2).exists()
