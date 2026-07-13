"""VoiceProvider adapters.

The ``build_voice`` factory selects an adapter by ``Config.voice_provider`` so
the core never imports a concrete adapter directly:

- ``"stub"``        — spec-01 silent-wav provider (no sidecar, no model).
- ``"spark"`` / ``"qwen3"`` / ``"chatterbox"`` / ``"dia"`` / ``"voxcpm2"`` — the real
  MLX voices via the supervised warm sidecar (spec 02 §3.3; ``spark`` is primary,
  ``voxcpm2`` is the post-L0 quality-reference candidate).
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
from .remote import RemoteVoiceProvider
from .stub import StubVoiceProvider


def build_voice(
    name: str,
    *,
    tts_url: str = "",
    tts_reference_id: str = "",
    tts_api_key: str = "",
    tts_seed: int | None = None,
    tts_model: str = "",
) -> VoiceProvider:
    """Construct the configured VoiceProvider adapter (spec 02 §3.5 hot-swap).

    The ``tts_*`` args (from ``config``) are only consulted for ``"remote"``
    (§3.6) — a URL selects the off-machine HTTP backend; every other name
    ignores them, so existing callers pass a bare ``name``.
    """
    if name == "stub":
        return StubVoiceProvider()
    if name == "sidecar-fake":
        return SidecarVoiceProvider("fake")
    if name == "remote":  # off-machine HTTP TTS (spec 02 §3.6)
        if not tts_url:
            raise ValueError(
                "voice_provider 'remote' needs a TTS URL (set MURMUR_TTS_URL)"
            )
        return RemoteVoiceProvider(
            tts_url,
            reference_id=tts_reference_id or None,
            api_key=tts_api_key or None,
            seed=tts_seed,
            model=tts_model or None,
        )
    if name in PROFILES:  # spark / qwen3 / chatterbox / dia / voxcpm2
        return SidecarVoiceProvider(name)
    available = ", ".join(["stub", "sidecar-fake", "remote", *sorted(PROFILES)])
    raise ValueError(f"unknown voice_provider {name!r}; expected one of: {available}")
