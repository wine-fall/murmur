"""The thin generic MLX backend: request→generate-kwargs mapping + the profile
registry (spec 02 §3.3/§3.5).

All unit, no MLX: the deterministic middle-layer logic (merging profile defaults
with a SynthesisRequest, mapping to generate() kwargs, backend selection by name)
is testable without loading any model. The real model load/synth is the tagged
integration test (test_mlx_backend_integration.py).
"""

from __future__ import annotations

import pytest

from murmur.voice import build_voice
from murmur.voice.backend import SynthesisRequest
from murmur.voice.client import SidecarVoiceProvider
from murmur.voice.mlx_backend import PROFILES, MlxAudioBackend, MlxProfile
from murmur.voice.sidecar import build_backend


def _backend(**profile_kw) -> MlxAudioBackend:
    return MlxAudioBackend(MlxProfile(repo="test/repo", **profile_kw))


# --- request -> generate() kwargs mapping --------------------------------- #


def test_profile_defaults_fill_voice_and_language():
    kw = _backend(voice="Chelsie", language="zh")._build_generate_kwargs(
        SynthesisRequest(text="hi")
    )
    assert kw["voice"] == "Chelsie"
    assert kw["lang_code"] == "zh"


def test_request_overrides_profile_defaults():
    kw = _backend(voice="Chelsie")._build_generate_kwargs(
        SynthesisRequest(text="hi", voice="Ethan")
    )
    assert kw["voice"] == "Ethan"


def test_none_fields_are_dropped():
    kw = _backend()._build_generate_kwargs(SynthesisRequest(text="hi"))
    assert "voice" not in kw
    assert "lang_code" not in kw
    assert "ref_audio" not in kw


def test_reference_audio_and_text_passed_when_present():
    kw = _backend()._build_generate_kwargs(
        SynthesisRequest(text="hi", reference_audio="/r.wav", reference_text="ref")
    )
    assert kw["ref_audio"] == "/r.wav"
    assert kw["ref_text"] == "ref"


def test_params_merge_request_wins_over_profile():
    kw = _backend(
        default_params={"speed": 1.0, "temperature": 0.7}
    )._build_generate_kwargs(SynthesisRequest(text="hi", params={"speed": 1.3}))
    assert kw["speed"] == 1.3  # request overrides profile default
    assert kw["temperature"] == 0.7  # profile default kept


def test_text_is_not_a_kwarg():
    # text goes to generate() positionally, never as a kwarg.
    kw = _backend(voice="v")._build_generate_kwargs(SynthesisRequest(text="hi"))
    assert "text" not in kw


# --- profile registry + selection ----------------------------------------- #


def test_registry_wires_exactly_the_four_backends():
    assert set(PROFILES) == {"spark", "qwen3", "chatterbox", "dia"}


def test_spark_is_the_primary():
    assert "Spark" in PROFILES["spark"].repo


def test_build_backend_constructs_mlx_without_loading_a_model():
    for name in ("spark", "qwen3", "chatterbox", "dia"):
        backend = build_backend(name)
        assert isinstance(backend, MlxAudioBackend)
        assert backend._profile is PROFILES[name]


def test_build_backend_unknown_raises():
    with pytest.raises(ValueError):
        build_backend("nope")


# --- core-side factory (hot-swap by name) ---------------------------------- #


def test_build_voice_wires_the_four_mlx_names():
    for name in ("spark", "qwen3", "chatterbox", "dia"):
        provider = build_voice(name)
        assert isinstance(provider, SidecarVoiceProvider)
        assert provider._backend == name
