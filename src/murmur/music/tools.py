"""Harness tools for music discovery (spec 03-01 §2.3).

Two ``BrainTool``s wrapping a ``MusicProvider``: ``search_music`` (non-terminal,
returns candidates to judge) and ``submit_pick`` (terminal — resolves the chosen
ref and, on success, ends the task, handing back the source so ``next_track`` can
rebuild the ``AudioClip`` with no side-channel).
"""

from __future__ import annotations

from typing import Any

from ..contracts import MusicProvider

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

    async def run(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args["query"])
        limit = int(args.get("limit", 5))
        candidates = await self._provider.search(query, limit=limit)
        # Explicit wire shape (not asdict) so the model-facing JSON is defined
        # here and a future TrackCandidate field does not silently leak.
        return {
            "candidates": [
                {
                    "ref": c.ref,
                    "title": c.title,
                    "uploader": c.uploader,
                    "duration_s": c.duration_s,
                    "extra": c.extra,
                }
                for c in candidates
            ]
        }


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

    def __init__(self, provider: MusicProvider) -> None:
        self._provider: MusicProvider = provider

    async def run(self, args: dict[str, Any]) -> dict[str, Any]:
        ref = str(args["ref"])
        try:
            clip = await self._provider.resolve(ref)
        except Exception as exc:  # any resolve failure -> let the model retry
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "source": clip.source, "kind": clip.kind}
