"""The thin generic MLX backend: request→generate-kwargs mapping + the profile
registry (spec 02 §3.3/§3.5).

All unit, no MLX: the deterministic middle-layer logic (merging profile defaults
with a SynthesisRequest, mapping to generate() kwargs, backend selection by name)
is testable without loading any model. The real model load/synth is the tagged
integration test (test_mlx_backend_integration.py).
"""

from __future__ import annotations

import sys
import types

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


def test_registry_wires_the_backend_candidates():
    # L0 shipped four; VoxCPM2 (OpenBMB) was added as a fifth blind-A/B candidate.
    assert set(PROFILES) == {"spark", "qwen3", "chatterbox", "dia", "voxcpm2"}


def test_spark_is_the_primary():
    assert "Spark" in PROFILES["spark"].repo


def test_build_backend_constructs_mlx_without_loading_a_model():
    for name in ("spark", "qwen3", "chatterbox", "dia", "voxcpm2"):
        backend = build_backend(name)
        assert isinstance(backend, MlxAudioBackend)
        assert backend._profile is PROFILES[name]


def test_build_backend_unknown_raises():
    with pytest.raises(ValueError):
        build_backend("nope")


# --- core-side factory (hot-swap by name) ---------------------------------- #


def test_build_voice_wires_the_mlx_names():
    for name in ("spark", "qwen3", "chatterbox", "dia", "voxcpm2"):
        provider = build_voice(name)
        assert isinstance(provider, SidecarVoiceProvider)
        assert provider._backend == name


# --- _render releases the MLX buffer cache (spec 02 §3.5 memory hygiene) ---- #


def test_render_releases_the_mlx_buffer_cache_after_writing(monkeypatch, tmp_path):
    """The reclaimable Metal buffer pool (~8 GB of a synth's footprint) is
    released after each synth, and only after the wav is written — so the
    sidecar's resting footprint stays at the model working set. Fakes MLX +
    mlx-audio; no real model."""
    calls: list[str] = []

    mx = types.ModuleType("mlx.core")
    mx.reset_peak_memory = lambda: calls.append("reset_peak")  # type: ignore[attr-defined]
    mx.clear_cache = lambda: calls.append("clear_cache")  # type: ignore[attr-defined]
    mx.concatenate = lambda arrs, axis=0: arrs[0]  # type: ignore[attr-defined]
    audio_io = types.ModuleType("mlx_audio.audio_io")
    audio_io.write = lambda *a, **k: calls.append("audio_write")  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "mlx", types.ModuleType("mlx"))
    monkeypatch.setitem(sys.modules, "mlx.core", mx)
    monkeypatch.setitem(sys.modules, "mlx_audio", types.ModuleType("mlx_audio"))
    monkeypatch.setitem(sys.modules, "mlx_audio.audio_io", audio_io)

    backend = _backend()
    backend._model = types.SimpleNamespace(  # type: ignore[assignment]
        sample_rate=16000,
        generate=lambda text, **kw: [types.SimpleNamespace(audio=[0.0])],
    )
    backend._dir = tmp_path
    backend.synthesize(SynthesisRequest(text="hello"))

    assert calls.count("clear_cache") == 1
    assert calls.index("clear_cache") > calls.index("audio_write")  # after write


# --- close() removes the clip temp dir (issue #46) ------------------------- #


def test_close_removes_the_clip_temp_dir(tmp_path):
    backend = _backend()
    clips = tmp_path / "clips"
    clips.mkdir()
    (clips / "clip-0001.wav").write_bytes(b"riff")
    backend._dir = clips
    backend.close()
    assert not clips.exists()


def test_close_before_load_is_a_noop():
    _backend().close()  # no dir yet -> must not raise


# --- normalize_tts_text (spec 02 §3.4 hygiene; found live with Spark) --------


def test_normalize_collapses_paragraph_breaks_and_runs_of_whitespace():
    from murmur.voice.mlx_backend import normalize_tts_text

    assert normalize_tts_text("hello\n\nworld") == "hello world"
    assert normalize_tts_text("a  b\t c") == "a b c"


def test_normalize_drops_unspeakable_lines():
    """Punctuation/whitespace-only fragments made mlx-audio's Spark splitter
    produce an empty segment -> 'No arrays provided for stacking'."""
    from murmur.voice.mlx_backend import normalize_tts_text

    assert normalize_tts_text("hello\n...\nworld") == "hello world"
    assert normalize_tts_text("...\n\n---") == ""


def test_normalize_keeps_cjk_speakable_text():
    # CJK via escapes (no literal CJK in source, master S0): runtime values
    # are real Chinese lines with an ellipsis-only line between them.
    from murmur.voice.mlx_backend import normalize_tts_text

    hello = "\u4f60\u597d"
    ellipsis_line = "\u2026\u2026"
    bye = "\u518d\u89c1\u3002"
    assert normalize_tts_text(f"{hello}\n\n{ellipsis_line}\n{bye}") == f"{hello} {bye}"
