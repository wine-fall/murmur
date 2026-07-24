"""Outbound interface contracts owned by spec 01 (the core is the consumer).

These types and Protocols are the seams that keep murmur's parts decoupled and
buildable in order. The core loop (spec 01) only ever depends on what is
declared here; implementations land in the specs noted below:

- ``VoiceProvider``  -> implemented in spec 02 (TTS sidecar + adapters).
- ``Player``         -> implemented by the mixing ``AudioEngine`` (spec 03-02),
                        the sole audio authority. (The spec-01 afplay
                        ``AudioPlayer`` reference impl was retired; git history
                        keeps it.)
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
    the file and return this. The Player consumes it opaquely — it only
    needs ``source`` and ``kind``.
    """

    source: str  # local file path (L0); may be a stream URL once spec 03-01 lands
    kind: str  # "talk" | "music"
    # Optional display metadata (spec 03-02 extension): who/what is playing.
    # Producers that know it set it (music picks); talk clips leave it None.
    title: str | None = None
    artist: str | None = None


@dataclass(frozen=True)
class Turn:
    """One unit of program/conversation history."""

    role: str  # "radio" (it spoke) | "user" (you typed)
    text: str


@dataclass(frozen=True)
class TalkBeat:
    """One self-initiated talk beat from the batch call (spec 04 §3.2). ``topic``
    is the optional 2–5 word ledger key the model tags it with (spec 05 §3.9);
    ``None`` when untagged (the beat then ledgers no topic — degrade silently)."""

    text: str
    topic: str | None = None


@dataclass(frozen=True)
class ContextPack:
    """The compact context handed to the Brain per call (master §6).

    ``scene`` is the time-of-day bucket (spec 04 §3.4) the Director derives from
    the local clock so the host's talk can speak to the current time; ``None``
    when unset (the prompt then omits any time-of-day cue). ``profile`` is the
    tier-① listener facts (spec 05 §2.2; ``""`` = no profile yet) and
    ``covered_topics`` the recent cross-day topic keys from the tier-③ ledger
    (anti-repeat; empty = nothing recorded). Spec 07 adds ``activity``.
    """

    persona: str
    recent: list[Turn]
    scene: str | None = None
    profile: str = ""
    covered_topics: tuple[str, ...] = ()


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
# Player — the audio-playback seam the Director consumes (spec 01 §3.3)
# --------------------------------------------------------------------------- #


@runtime_checkable
class Player(Protocol):
    """One clip on air at a time; ``stop()`` cancels it (the cancel-and-resume
    interjection, spec 01 §3.3). The mixing ``AudioEngine`` is the real impl;
    tests inject a fake. Kept a Protocol so the Director depends on the
    capability, not the concrete class (interface-first, DESIGN §11.1)."""

    async def play(self, clip: AudioClip) -> None: ...

    async def stop(self) -> None: ...


# --------------------------------------------------------------------------- #
# 2.3 MusicProvider — declared here; implemented in spec 03-01, widened to
#     search + resolve (selection is Claude-driven). yt-dlp is the default
#     adapter; musicdl is an optional user-installed one behind the same seam.
# --------------------------------------------------------------------------- #


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
    # Typed factory (a bare ``dict`` infers dict[Unknown, Unknown] under pyright
    # strict). e.g. {"view_count": ...}
    extra: dict[str, Any] = field(default_factory=dict[str, Any])


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

    # --- spec 05 additions (additive; spec-01 signatures unchanged) --------- #

    def profile(self) -> str:
        """Tier-① listener facts (natural language); ``""`` when none yet."""
        ...

    def record_event(self, kind: str, key: str) -> None:
        """Append a tier-③ ledger event; ``kind`` is ``"topic"`` or ``"song"``."""
        ...

    def recent_topics(self, n: int) -> list[str]:
        """Last ``n`` topic keys, oldest-first — spans sessions/days (anti-repeat
        must survive cold boots and the midnight boundary, spec 05 §2.1)."""
        ...

    def recent_songs(self, n: int) -> list[str]:
        """Last ``n`` song keys (``"title — artist"``), oldest-first."""
        ...
