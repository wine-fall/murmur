"""Harness tools for music discovery (spec 03-01 §2.3).

Two ``BrainTool``s wrapping a ``MusicProvider``: ``search_music`` (non-terminal,
returns candidates to judge) and ``submit_pick`` (terminal — resolves the chosen
ref and, on success, ends the task, handing back the source so ``next_track`` can
rebuild the ``AudioClip`` with no side-channel).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Literal, TypedDict

from ..contracts import MusicProvider

# Pull-time playability check (spec 04): given a resolved stream source, return
# True if it actually decodes. Injected (real impl opens ffmpeg and reads a
# frame) so this module stays free of the audio engine.
StreamProbe = Callable[[str], Awaitable[bool]]


# --------------------------------------------------------------------------- #
# Wire shapes — the JSON these tools hand back. Defined ONCE here (producer) and
# imported by the consumer (music.programmer) so pyright binds the two ends: a
# renamed/dropped field is a type error, not a silent runtime surprise. The
# harness itself stays shape-agnostic (Mapping[str, object]); only these two
# tools and their reader know the concrete shape.
# --------------------------------------------------------------------------- #


class CandidatePayload(TypedDict):
    ref: str
    title: str
    uploader: str
    duration_s: int
    extra: dict[str, Any]  # provider passthrough — genuinely open-ended JSON


class SearchResult(TypedDict):
    candidates: list[CandidatePayload]


class SubmitSuccess(TypedDict):
    ok: Literal[True]
    source: str
    kind: str
    title: str | None
    artist: str | None
    announce: str | None


class SubmitError(TypedDict):
    ok: Literal[False]
    error: str


def _opt_str(value: object) -> str | None:
    """Coerce an untrusted result value to a non-empty ``str`` or ``None``."""
    return value if isinstance(value, str) and value else None


def parse_submit_success(result: Mapping[str, object] | None) -> SubmitSuccess | None:
    """Validate an opaque terminal-tool result into a typed pick, or ``None`` if
    it is not a usable success (no terminal call, a failure result, or a shape
    that drifted). The one place the ``submit_pick`` wire shape is trusted."""
    if not result or result.get("ok") is not True:
        return None
    source = result.get("source")
    if not isinstance(source, str) or not source:
        return None
    kind = result.get("kind")
    return SubmitSuccess(
        ok=True,
        source=source,
        kind=kind if isinstance(kind, str) and kind else "music",
        title=_opt_str(result.get("title")),
        artist=_opt_str(result.get("artist")),
        announce=_opt_str(result.get("announce")),
    )


_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "search terms for the track"},
        "limit": {"type": "integer", "description": "max candidates (default 5)"},
    },
    "required": ["query"],
}

_SUBMIT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "ref": {"type": "string", "description": "the chosen candidate's ref"},
        "why": {"type": "string", "description": "one line: why this track"},
        "title": {"type": "string", "description": "the track's title"},
        "artist": {"type": "string", "description": "the track's artist/uploader"},
        "announce": {
            "type": "string",
            "description": (
                "one short in-persona spoken line introducing the track "
                "(the DJ's 'up next'), in the persona's language"
            ),
        },
    },
    "required": ["ref", "why"],
}


class SearchMusicTool:
    """Non-terminal: search the source and return candidates to judge."""

    name = "search_music"
    description = (
        "Search for candidate tracks by query; returns candidates "
        "(ref, title, uploader, duration_s) to judge before picking."
    )
    input_schema = _SEARCH_SCHEMA
    terminal = False

    def __init__(self, provider: MusicProvider) -> None:
        self._provider: MusicProvider = provider

    async def run(self, args: Mapping[str, object]) -> SearchResult:
        raw_query = args.get("query")
        query = raw_query if isinstance(raw_query, str) else str(raw_query or "")
        raw_limit = args.get("limit")
        limit = raw_limit if isinstance(raw_limit, int) else 5
        candidates = await self._provider.search(query, limit=limit)
        # Explicit wire shape (not asdict) so the model-facing JSON is defined
        # here and a future TrackCandidate field does not silently leak.
        return SearchResult(
            candidates=[
                CandidatePayload(
                    ref=c.ref,
                    title=c.title,
                    uploader=c.uploader,
                    duration_s=c.duration_s,
                    extra=c.extra,
                )
                for c in candidates
            ]
        )


class SubmitPickTool:
    """Terminal: resolve the chosen ref. Success ends the task with the source;
    failure is a non-terminating result so the model can pick again."""

    name = "submit_pick"
    description = (
        "Commit to ONE track by its ref, with a one-line reason. Resolves it to a "
        "playable source; on success this ends the task. If it fails, pick another."
    )
    input_schema = _SUBMIT_SCHEMA
    terminal = True

    def __init__(self, provider: MusicProvider, probe: StreamProbe | None = None) -> None:
        self._provider: MusicProvider = provider
        self._probe = probe

    async def run(self, args: Mapping[str, object]) -> SubmitSuccess | SubmitError:
        raw_ref = args.get("ref")
        ref = raw_ref if isinstance(raw_ref, str) else ""
        if not ref:
            return SubmitError(ok=False, error="submit_pick requires a 'ref'")
        try:
            clip = await self._provider.resolve(ref)
        except Exception as exc:  # any resolve failure -> let the model retry
            return SubmitError(ok=False, error=str(exc))

        # Validate playability at pull time (spec 04): a resolved googlevideo URL
        # can still 403 in ffmpeg and never decode a frame. Reject it as a
        # non-terminating error so the model picks another candidate now (during
        # talk), instead of the announce claiming a track that never plays.
        if self._probe is not None and not await self._probe(clip.source):
            return SubmitError(
                ok=False, error=f"{ref} resolved but the stream did not play; pick another"
            )

        # Metadata rides the terminal result (spec 03-02): the model supplies
        # title/artist from the candidate it judged and writes the announce
        # line itself; all optional — a missing announce just skips the intro.
        return SubmitSuccess(
            ok=True,
            source=clip.source,
            kind=clip.kind,
            title=_opt_str(args.get("title")),
            artist=_opt_str(args.get("artist")),
            announce=_opt_str(args.get("announce")),
        )
