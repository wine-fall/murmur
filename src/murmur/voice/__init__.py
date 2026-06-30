"""VoiceProvider adapters.

The ``build_voice`` factory selects an adapter by ``Config.voice_provider`` so
the core never imports a concrete adapter directly:

- ``"stub"``        — spec-01 silent-wav provider (no sidecar, no model).
- ``"qwen3"``       — real Qwen3-TTS via the supervised warm sidecar (spec 02).
- ``"sidecar-fake"``— the full two-process sidecar path running the no-model
  ``FakeBackend``: exercises spawn/supervise/restart + hot-swap (acceptance
  §3/§4) without the heavy model.

Constructing a sidecar provider imports no heavy dependency — the model loads
only inside the subprocess that ``start()`` spawns.
"""

from __future__ import annotations

from ..contracts import VoiceProvider
from .client import SidecarVoiceProvider
from .stub import StubVoiceProvider


def build_voice(name: str) -> VoiceProvider:
    """Construct the configured VoiceProvider adapter (spec 02 §3.5 hot-swap)."""
    if name == "stub":
        return StubVoiceProvider()
    if name == "qwen3":
        return SidecarVoiceProvider("qwen3")
    if name == "sidecar-fake":
        return SidecarVoiceProvider("fake")
    raise ValueError(
        f"unknown voice_provider {name!r}; expected 'stub', 'qwen3', or 'sidecar-fake'"
    )
