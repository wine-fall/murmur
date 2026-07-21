"""Background-bed acquisition + cache (spec 03-04 §2.2/§2.3).

The bed audio is a curated manifest of yt-dlp-resolvable refs committed to the
repo (``assets/bed_sources.txt``), pulled to a per-user cache during first-run
loading. At runtime the engine plays only the local cached files — no network,
no resolve latency (that is the dead-air spec 04 exists to hide). This module
owns the manifest reader, the local ``CachedBedSource`` the engine consumes, and
the loading-time pull; ``make bed-refresh`` re-pulls after the manifest changes.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
from collections.abc import Awaitable, Callable
from pathlib import Path

from . import paths
from .logging_setup import get_log

_log = get_log("bed")

# The committed manifest and the per-user cache (outside the repo, survives
# clones) — spec 03-04 §2.3 "cache location — decided". The cache is rebuildable
# state, so it lives under murmur's cache root (spec 05 §2.3 path governance);
# $MURMUR_HOME relocates it.
DEFAULT_MANIFEST = Path(__file__).resolve().parent.parent.parent / "assets" / "bed_sources.txt"
DEFAULT_CACHE_DIR = paths.cache_root() / "bed"

# Partial / hidden files are not playable tracks.
_SKIP_SUFFIXES = {".part", ".ytdl", ".tmp"}


def read_manifest(path: Path) -> list[str]:
    """Refs from the manifest, one per line; ``#`` comments and blanks skipped.
    A missing manifest is simply empty (degrade to no bed)."""
    if not path.exists():
        return []
    refs: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            refs.append(line)
    return refs


def _cache_key(ref: str) -> str:
    """A stable filename stem for a ref, so a warm cache is recognised across
    runs regardless of the ref's characters."""
    return hashlib.sha256(ref.encode("utf-8")).hexdigest()[:16]


def _cached_files(cache_dir: Path) -> list[Path]:
    if not cache_dir.is_dir():
        return []
    return sorted(
        p
        for p in cache_dir.iterdir()
        if p.is_file() and not p.name.startswith(".") and p.suffix not in _SKIP_SUFFIXES
    )


class CachedBedSource:
    """The runtime ``BedSource`` (spec 03-04 §2.2): lists the cached local bed
    files in a stable order. No network — resolving happened at loading time."""

    def __init__(self, cache_dir: Path) -> None:
        self._cache_dir = cache_dir

    def tracks(self) -> list[Path]:
        return _cached_files(self._cache_dir)


async def ytdlp_download(ref: str, dest_base: Path, *, ytdlp: str = "yt-dlp") -> None:
    """Pull one ref's best audio to ``<dest_base>.<ext>`` via yt-dlp (reusing the
    03-01 acquisition binary). Loading-time only — never on the audio path."""
    proc = await asyncio.create_subprocess_exec(
        ytdlp,
        "-f",
        "bestaudio/best",
        "-o",
        f"{dest_base}.%(ext)s",
        ref,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip()
        raise RuntimeError(f"yt-dlp failed ({proc.returncode}): {detail}")


async def pull_bed(
    *,
    manifest: Path,
    cache_dir: Path,
    download: Callable[[str, Path], Awaitable[None]],
    log: Callable[[str], None] = _log.event,
) -> int:
    """First-run pull (spec 03-04 §2.3): resolve each manifest ref into the cache
    via ``download``, skipping already-cached refs and continuing past a failing
    one (a dead ref never aborts the pull). Returns the number of cached tracks
    afterward — 0 (offline / empty manifest) degrades cleanly to no bed."""
    refs = read_manifest(manifest)
    if not refs:
        return len(_cached_files(cache_dir))
    cache_dir.mkdir(parents=True, exist_ok=True)
    failures = 0
    for ref in refs:
        key = _cache_key(ref)
        if any(cache_dir.glob(f"{key}.*")):
            continue  # warm cache — skip, no network
        log(f"bed: pulling {ref}")
        try:
            await download(ref, cache_dir / key)
        except Exception as exc:  # a dead ref must not abort the pull
            failures += 1
            # The raw yt-dlp error (e.g. a 403 on one source) is noise to the
            # user: the pull degrades cleanly, so keep the detail in the debug
            # log and surface only a calm summary below.
            _log.debug(f"bed: pull failed for {ref!r}: {exc}")
    cached = len(_cached_files(cache_dir))
    if failures:
        log(
            f"bed: {failures} source(s) unavailable, skipped "
            f"({cached}/{len(refs)} ready)"
        )
    return cached


def main() -> None:
    """``make bed-refresh``: (re-)pull the committed manifest into the cache."""
    count = asyncio.run(
        pull_bed(
            manifest=DEFAULT_MANIFEST,
            cache_dir=DEFAULT_CACHE_DIR,
            download=ytdlp_download,
            log=print,
        )
    )
    print(f"bed: {count} track(s) cached in {DEFAULT_CACHE_DIR}")


if __name__ == "__main__":  # pragma: no cover
    with contextlib.suppress(KeyboardInterrupt):
        main()
