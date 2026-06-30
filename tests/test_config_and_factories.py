"""Config defaults + provider factories (spec 01 §3.1)."""

from __future__ import annotations

import pytest

from murmur.brain import ClaudeBrain, StubBrain, build_brain
from murmur.config import Config
from murmur.voice import build_voice
from murmur.voice.stub import StubVoiceProvider


def test_config_defaults():
    c = Config.default()
    assert c.brain_provider == "claude"
    assert c.voice_provider == "stub"
    assert c.player_cmd == "afplay"
    assert c.model == "claude-opus-4-8"
    assert c.recent_window > 0
    assert c.inter_segment_gap >= 0


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
