"""Deterministic music-dependency preflight (spec 03-03 §2).

Cheap, local probes — **no LLM** (master §7 pillar 1) — that decide whether the
music dependencies actually work in this environment: one probe per unbound
binary (``preflight_ytdlp`` runs a trivial search; ``preflight_ffmpeg`` runs
``-version``) and ``preflight_music`` aggregating both (music is usable iff BOTH
are). The guide harness only engages when the aggregate says "broken", and the
``reason`` — naming each broken binary — seeds the agent's diagnosis (missing
entirely, a TLS/cert error from a corporate proxy, ...).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

_REASON_MAX = 500


@dataclass(frozen=True)
class PreflightResult:
    ok: bool
    reason: str  # "" when ok; else a short human-readable reason


async def _probe(
    name: str, binary: str, args: list[str], *, require_stdout: bool
) -> PreflightResult:
    """Run one binary probe and classify it. ok = exit 0 (plus non-empty stdout
    when ``require_stdout``); otherwise broken, with ``reason`` (stderr snippet,
    or "binary not found")."""
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, NotADirectoryError):
        return PreflightResult(ok=False, reason=f"{name} binary not found: {binary!r}")
    except PermissionError:
        return PreflightResult(ok=False, reason=f"{name} not executable: {binary!r}")

    stdout_b, stderr_b = await proc.communicate()
    if proc.returncode == 0 and (not require_stdout or stdout_b.strip()):
        return PreflightResult(ok=True, reason="")

    stderr = stderr_b.decode(errors="replace").strip()
    suffix = " with no output" if require_stdout else ""
    reason = stderr or f"{name} exited {proc.returncode}{suffix}"
    return PreflightResult(ok=False, reason=reason[:_REASON_MAX])


async def preflight_ytdlp(
    binary: str = "yt-dlp", *, probe_query: str = "test"
) -> PreflightResult:
    """Probe whether ``binary`` can fetch (a trivial flat search — network)."""
    args = ["--dump-json", "--flat-playlist", f"ytsearch1:{probe_query}"]
    return await _probe("yt-dlp", binary, args, require_stdout=True)


async def preflight_ffmpeg(binary: str = "ffmpeg") -> PreflightResult:
    """Probe whether ``binary`` is a working ffmpeg (``-version``; no network)."""
    return await _probe("ffmpeg", binary, ["-version"], require_stdout=False)


async def preflight_music(
    *, ytdlp: str = "yt-dlp", ffmpeg: str = "ffmpeg"
) -> PreflightResult:
    """Aggregate: music is usable iff BOTH binaries are (spec 03-03 §2). The
    combined reason prefixes each broken binary's name so the guide (and the
    user) see exactly which pieces need fixing."""
    yt, ff = await asyncio.gather(preflight_ytdlp(ytdlp), preflight_ffmpeg(ffmpeg))
    reasons: list[str] = []
    if not yt.ok:
        reasons.append(f"yt-dlp: {yt.reason}")
    if not ff.ok:
        reasons.append(f"ffmpeg: {ff.reason}")
    if not reasons:
        return PreflightResult(ok=True, reason="")
    return PreflightResult(ok=False, reason=" | ".join(reasons))
