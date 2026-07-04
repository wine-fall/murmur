"""yt-dlp MusicProvider adapter — the default music source (spec 03-01 §2.2).

Shells out to ``yt-dlp`` (covers YouTube + Bilibili, no login/account):
- ``search`` runs ``yt-dlp --dump-json ytsearch{limit}:<query>`` — full metadata
  (duration, uploader, view_count) so the brain can reject junk (hour-long
  loops, wrong version) and prefer official audio. Richer than ``--flat-playlist``
  at the cost of extracting each hit; a handful of results is acceptable latency.
- ``resolve`` runs ``yt-dlp -f bestaudio -g <ref>`` → a **stream URL** (no disk
  download — master decision A); the ducking engine (spec 03-02) decodes it.

The subprocess call is thin; the real logic is the two pure parse helpers, which
are unit-tested directly. A real end-to-end run is the tagged integration test.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, cast

from ..contracts import AudioClip, TrackCandidate


def _parse_search_output(stdout: str, limit: int) -> list[TrackCandidate]:
    """Parse ``yt-dlp --dump-json`` output (one JSON object per line) into
    candidates, tolerant of non-JSON noise, capped at ``limit``."""
    candidates: list[TrackCandidate] = []
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(parsed, dict):
            continue
        entry = cast("dict[str, Any]", parsed)

        title = entry.get("title")
        ref = entry.get("webpage_url") or entry.get("url") or entry.get("id")
        if not title or not ref:
            continue

        duration_raw = entry.get("duration")
        try:
            duration_s = int(duration_raw) if duration_raw is not None else 0
        except (TypeError, ValueError):
            duration_s = 0

        extra: dict[str, Any] = {}
        view_count = entry.get("view_count")
        if view_count is not None:
            extra["view_count"] = view_count

        candidates.append(
            TrackCandidate(
                ref=str(ref),
                title=str(title),
                uploader=str(entry.get("uploader") or entry.get("channel") or ""),
                duration_s=duration_s,
                extra=extra,
            )
        )
        if len(candidates) >= limit:
            break
    return candidates


def _parse_resolve_output(stdout: str) -> str:
    """First non-empty line of ``yt-dlp -g`` output is the stream URL."""
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if line:
            return line
    raise ValueError("yt-dlp -g produced no stream URL")


class YtDlpMusicProvider:
    """Default ``MusicProvider``: search + resolve via the ``yt-dlp`` binary."""

    def __init__(self, binary: str = "yt-dlp") -> None:
        self._binary: str = binary

    async def start(self) -> None:
        return None

    async def search(self, query: str, *, limit: int = 5) -> list[TrackCandidate]:
        stdout = await self._run(["--dump-json", f"ytsearch{limit}:{query}"])
        return _parse_search_output(stdout, limit)

    async def resolve(self, ref: str) -> AudioClip:
        stdout = await self._run(["-f", "bestaudio", "-g", ref])
        return AudioClip(source=_parse_resolve_output(stdout), kind="music")

    async def aclose(self) -> None:
        return None

    async def _run(self, args: list[str]) -> str:
        proc = await asyncio.create_subprocess_exec(
            self._binary,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_b, stderr_b = await proc.communicate()
        if proc.returncode != 0:
            detail = stderr_b.decode(errors="replace").strip()
            raise RuntimeError(f"yt-dlp failed ({proc.returncode}): {detail}")
        return stdout_b.decode(errors="replace")
