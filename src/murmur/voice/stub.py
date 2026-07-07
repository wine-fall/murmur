"""Stub VoiceProvider (spec 01 §4 — exercises the loop with no spec-02 code).

Writes a complete, real (silent) WAV file to a temp dir and returns it as an
``AudioClip(kind="talk")``. The clip's duration scales with text length so
playback pacing feels like a real spoken segment. This proves the
``VoiceProvider`` seam: the core synthesizes and plays without any TTS model
present. Spec 02 drops in a real adapter behind the same Protocol.
"""

from __future__ import annotations

import asyncio

from ..contracts import AudioClip
from ._wav import SilentClipWriter


class StubVoiceProvider:
    """Silent-WAV VoiceProvider. Satisfies the ``VoiceProvider`` Protocol."""

    def __init__(self) -> None:
        self._clips = SilentClipWriter(prefix="murmur-voice-")

    async def start(self) -> None:
        # Idempotent: a warm "backend" here is just a temp dir for clips.
        self._clips.start()

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        # Writing the WAV is fast but blocking; keep the event loop responsive.
        path = await asyncio.to_thread(self._clips.write, text)
        return AudioClip(source=path, kind="talk")

    async def aclose(self) -> None:
        self._clips.close()
