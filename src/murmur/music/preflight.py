"""Deterministic yt-dlp preflight (spec 03-03 §2).

A cheap, local check — **no LLM** (master §7 pillar 1) — that decides whether
yt-dlp can actually fetch in this environment. It runs one trivial search and
classifies the outcome; the guide harness only engages when this says "broken",
and the ``reason`` seeds the agent's diagnosis (e.g. a TLS/cert error from a
corporate proxy). Uses ``--flat-playlist`` to keep the probe light.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

_REASON_MAX = 500


@dataclass(frozen=True)
class PreflightResult:
    ok: bool
    reason: str  # "" when ok; else a short human-readable reason


async def preflight_ytdlp(
    binary: str = "yt-dlp", *, probe_query: str = "test"
) -> PreflightResult:
    """Probe whether ``binary`` can fetch. ok = exit 0 with non-empty output;
    otherwise broken, with ``reason`` (stderr snippet, or "binary not found")."""
    args = ["--dump-json", "--flat-playlist", f"ytsearch1:{probe_query}"]
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, NotADirectoryError):
        return PreflightResult(ok=False, reason=f"yt-dlp binary not found: {binary!r}")
    except PermissionError:
        return PreflightResult(ok=False, reason=f"yt-dlp not executable: {binary!r}")

    stdout_b, stderr_b = await proc.communicate()
    if proc.returncode == 0 and stdout_b.strip():
        return PreflightResult(ok=True, reason="")

    stderr = stderr_b.decode(errors="replace").strip()
    reason = stderr or f"yt-dlp exited {proc.returncode} with no output"
    return PreflightResult(ok=False, reason=reason[:_REASON_MAX])
