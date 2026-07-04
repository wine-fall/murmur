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

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

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
# 2.3 MusicProvider — declared here; implemented in spec 03-01, widened to
#     search + resolve (selection is Claude-driven). yt-dlp is the default
#     adapter; musicdl is an optional user-installed one behind the same seam.
# --------------------------------------------------------------------------- #


def _empty_extra() -> dict[str, Any]:
    """Typed default factory for ``TrackCandidate.extra`` (keeps pyright strict
    happy — a bare ``dict`` factory infers ``dict[Unknown, Unknown]``)."""
    return {}


@dataclass(frozen=True)
class TrackCandidate:
    """A search hit the brain judges (spec 03-01 §2.2).

    Carries enough signal to reject junk (hour-long loops, low-quality
    re-uploads) and prefer official audio. ``ref`` is the opaque provider handle
    (URL / id) passed back to ``MusicProvider.resolve``.
    """

    ref: str
    title: str
    uploader: str
    duration_s: int
    extra: dict[str, Any] = field(
        default_factory=_empty_extra
    )  # e.g. {"view_count": ...}


@runtime_checkable
class MusicProvider(Protocol):
    async def start(self) -> None: ...

    async def search(self, query: str, *, limit: int = 5) -> list[TrackCandidate]:
        """Search the source for candidate tracks (metadata only, no download)."""
        ...

    async def resolve(self, ref: str) -> AudioClip:  # AudioClip(kind="music")
        """Resolve a candidate's ``ref`` to a playable clip (stream URL or file)."""
        ...

    async def aclose(self) -> None: ...


# --------------------------------------------------------------------------- #
# 2.4 MemoryStore — in-process impl here; persistent impl in spec 05
# --------------------------------------------------------------------------- #


@runtime_checkable
class MemoryStore(Protocol):
    def record(self, turn: Turn) -> None: ...

    def recent(self, n: int) -> list[Turn]: ...
