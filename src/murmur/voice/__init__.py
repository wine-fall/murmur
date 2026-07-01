"""VoiceProvider adapters.

The ``build_voice`` factory selects an adapter by ``Config.voice_provider`` so
the core never imports a concrete adapter directly:

- ``"stub"``        — spec-01 silent-wav provider (no sidecar, no model).
- ``"spark"`` / ``"qwen3"`` / ``"chatterbox"`` / ``"dia"`` — the four real MLX
  voices via the supervised warm sidecar (spec 02 §3.3; ``spark`` is primary).
- ``"sidecar-fake"``— **internal/diagnostic, not a user-facing voice** (kept off
  the ``--voice`` menu): the full two-process sidecar path running the no-model
  ``FakeBackend``, so tests (and a future ``doctor`` self-check) can exercise
  spawn/supervise/restart + hot-swap on any machine without the heavy model.

Constructing a sidecar provider imports no heavy dependency — the model loads
only inside the subprocess that ``start()`` spawns.
"""

from __future__ import annotations

from ..contracts import VoiceProvider
from .client import SidecarVoiceProvider
from .mlx_backend import PROFILES
from .stub import StubVoiceProvider


def build_voice(name: str) -> VoiceProvider:
    """Construct the configured VoiceProvider adapter (spec 02 §3.5 hot-swap)."""
    if name == "stub":
        return StubVoiceProvider()
    if name == "sidecar-fake":
        return SidecarVoiceProvider("fake")
    if name in PROFILES:  # spark / qwen3 / chatterbox / dia
        return SidecarVoiceProvider(name)
    available = ", ".join(["stub", "sidecar-fake", *sorted(PROFILES)])
    raise ValueError(f"unknown voice_provider {name!r}; expected one of: {available}")
