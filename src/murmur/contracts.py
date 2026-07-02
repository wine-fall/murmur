"""Outbound interface contracts owned by spec 01 (the core is the consumer).

These types and Protocols are the seams that keep murmur's parts decoupled and
buildable in order. The core loop (spec 01) only ever depends on what is
declared here; implementations land in the specs noted below:

- ``VoiceProvider``  -> implemented in spec 02 (TTS sidecar + adapters).
- ``MusicProvider``  -> declared only here; implemented in spec 03-01 (the
                       brain-harness spec; Claude-driven, habit-based search).
- ``MemoryStore``    -> in-process impl in spec 01 (``memory.py``); persistent
                        three-tier impl in spec 05.

Keep these signatures stable. Downstream specs may *extend* (add optional
params / new methods) but must not break them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

# --------------------------------------------------------------------------- #
# 2.1 Data types
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class AudioClip:
    """An opaque, playable audio handle.

    L0 representation: a path to a complete audio file on local disk (e.g. a
    wav under a temp dir). Producers (VoiceProvider, later MusicProvider) write
    the file and return this. The AudioPlayer consumes it opaquely — it only
    needs ``source`` and ``kind``.
    """

    source: str  # local file path (L0); may be a stream URL once spec 03-01 lands
    kind: str  # "talk" | "music"


@dataclass(frozen=True)
class Turn:
    """One unit of program/conversation history."""

    role: str  # "radio" (it spoke) | "user" (you typed)
    text: str


@dataclass(frozen=True)
class ContextPack:
    """The compact context handed to the Brain per call (master §6).

    L0 fields only; spec 05/07 add profile/ledger/time/activity fields.
    """

    persona: str
    recent: list[Turn]


# --------------------------------------------------------------------------- #
# 2.2 VoiceProvider — implemented in spec 02
# --------------------------------------------------------------------------- #


@runtime_checkable
class VoiceProvider(Protocol):
    async def start(self) -> None:
        """Bring the backend to a warm, ready state (e.g. load + warm the TTS
        sidecar). Idempotent. Called once at core startup."""
        ...

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        """Render ``text`` to a complete ``AudioClip(kind="talk")``.

        ``scenario`` lets the core request a fast vs. warm voice (master §3.5
        'split by scenario'); L0 always passes the default. Must be safe to
        call repeatedly on the warm backend.
        """
        ...

    async def aclose(self) -> None:
        """Release the backend / shut down the sidecar."""
        ...


# --------------------------------------------------------------------------- #
# 2.3 MusicProvider — declared only; implemented in spec 03-01
# --------------------------------------------------------------------------- #


@runtime_checkable
class MusicProvider(Protocol):
    async def start(self) -> None: ...

    async def resolve(self, query: str) -> AudioClip:  # AudioClip(kind="music")
        ...

    async def aclose(self) -> None: ...


# --------------------------------------------------------------------------- #
# 2.4 MemoryStore — in-process impl here; persistent impl in spec 05
# --------------------------------------------------------------------------- #


@runtime_checkable
class MemoryStore(Protocol):
    def record(self, turn: Turn) -> None: ...

    def recent(self, n: int) -> list[Turn]: ...
