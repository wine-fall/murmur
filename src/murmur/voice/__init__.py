"""VoiceProvider adapters.

Spec 01 ships only the stub (``stub.StubVoiceProvider``). Real TTS adapters
(e.g. Qwen3-TTS) land in spec 02 alongside the warm sidecar process. The
``build_voice`` factory selects an adapter by ``Config.voice_provider`` so the
core never imports a concrete adapter directly.
"""

from __future__ import annotations

from ..contracts import VoiceProvider
from .stub import StubVoiceProvider


def build_voice(name: str) -> VoiceProvider:
    """Construct the configured VoiceProvider adapter.

    spec 02 extends this with real adapters (e.g. ``"qwen3"``).
    """
    if name == "stub":
        return StubVoiceProvider()
    raise ValueError(
        f"unknown voice_provider {name!r}; spec 01 ships only 'stub' "
        f"(real adapters arrive in spec 02)"
    )
