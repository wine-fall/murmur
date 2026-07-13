"""Config defaults + provider factories (spec 01 §3.1)."""

from __future__ import annotations

import pytest

from murmur.app import _apply_overrides, _parse_args
from murmur.brain import ClaudeBrain, StubBrain, build_brain
from murmur.config import Config
from murmur.voice import build_voice
from murmur.voice.mlx_backend import PROFILES
from murmur.voice.stub import StubVoiceProvider


def test_config_defaults():
    c = Config.default()
    assert c.brain_provider == "claude"
    assert c.voice_provider == "stub"
    assert c.ffmpeg_cmd == "ffmpeg"
    assert c.model == "claude-opus-4-8"
    assert c.recent_window > 0
    assert c.inter_segment_gap >= 0
    # spec 03-02: music on by default, local cadence, cheap music model.
    assert c.music_enabled is True
    assert c.cadence_mode == "every_n"
    assert c.music_every_n >= 1
    assert "haiku" in c.music_model


def test_build_voice_selects_stub():
    assert isinstance(build_voice("stub"), StubVoiceProvider)


def test_build_voice_unknown_raises():
    with pytest.raises(ValueError):
        build_voice("nope")


def test_build_brain_selects_impl():
    assert isinstance(build_brain("stub", model="m"), StubBrain)
    # Constructing the real Brain does not touch the network.
    assert isinstance(build_brain("claude", model="claude-opus-4-8"), ClaudeBrain)


def test_build_brain_unknown_raises():
    with pytest.raises(ValueError):
        build_brain("nope", model="m")


def test_cli_voice_flag_accepts_every_registered_voice():
    # The --voice choices must stay derived from the PROFILES registry: adding a
    # backend row (regression: voxcpm2) must not leave the CLI rejecting it while
    # build_voice() accepts it. Every registry name + "stub" must parse.
    for name in ("stub", *PROFILES):
        assert _parse_args(["--voice", name]).voice == name


def test_cli_tts_flags_override_config():
    # --tts-* let you switch the remote endpoint / model / voice from the command
    # line (e.g. local -> fish.audio s2.1-pro-free) without editing .env; CLI wins.
    args = _parse_args(
        [
            "--voice",
            "remote",
            "--tts-url",
            "https://api.fish.audio",
            "--tts-model",
            "s2.1-pro-free",
            "--tts-reference",
            "ref123",
        ]
    )
    cfg = _apply_overrides(Config.default(), args)
    assert cfg.voice_provider == "remote"
    assert cfg.tts_url == "https://api.fish.audio"
    assert cfg.tts_model == "s2.1-pro-free"
    assert cfg.tts_reference_id == "ref123"


def test_cli_tts_flags_absent_leave_config_untouched(monkeypatch):
    # No --tts-* flags -> config keeps its env-derived values (no clobber to "").
    monkeypatch.setenv("MURMUR_TTS_URL", "http://box:8080")
    cfg = _apply_overrides(Config.default(), _parse_args([]))
    assert cfg.tts_url == "http://box:8080"
