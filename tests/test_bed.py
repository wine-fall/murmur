"""Bed acquisition layer (spec 03-04 §2.2/§2.3): manifest, cached source, and
the first-run pull. No network here — the pull's downloader is injected, so the
"resolve via 03-01 yt-dlp acquisition" step is faked (acceptance #4/#5)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from murmur.bed import CachedBedSource, pull_bed, read_manifest


def test_read_manifest_skips_comments_and_blank_lines(tmp_path: Path):
    manifest = tmp_path / "bed_sources.txt"
    manifest.write_text(
        "# a curated bed manifest\n"
        "\n"
        "https://example.com/one\n"
        "  https://example.com/two  \n"
        "# trailing comment\n",
        encoding="utf-8",
    )
    assert read_manifest(manifest) == [
        "https://example.com/one",
        "https://example.com/two",
    ]


def test_read_manifest_missing_file_is_empty(tmp_path: Path):
    assert read_manifest(tmp_path / "nope.txt") == []


def test_cached_bed_source_lists_local_files_sorted(tmp_path: Path):
    (tmp_path / "b.webm").write_bytes(b"b")
    (tmp_path / "a.m4a").write_bytes(b"a")
    (tmp_path / ".hidden").write_bytes(b"x")  # dotfiles ignored
    (tmp_path / "c.part").write_bytes(b"c")  # partial downloads ignored
    tracks = CachedBedSource(tmp_path).tracks()
    assert [p.name for p in tracks] == ["a.m4a", "b.webm"]
    assert all(isinstance(p, Path) for p in tracks)


def test_cached_bed_source_missing_dir_is_empty(tmp_path: Path):
    assert CachedBedSource(tmp_path / "absent").tracks() == []


def test_pull_bed_downloads_each_ref_into_the_cache(tmp_path: Path):
    manifest = tmp_path / "m.txt"
    manifest.write_text("refA\nrefB\n", encoding="utf-8")
    cache = tmp_path / "cache"
    pulled: list[str] = []

    async def fake_download(ref: str, dest_base: Path) -> None:
        pulled.append(ref)
        dest_base.with_suffix(".wav").write_bytes(b"pcm")

    count = asyncio.run(
        pull_bed(manifest=manifest, cache_dir=cache, download=fake_download)
    )
    assert pulled == ["refA", "refB"]
    assert count == 2
    assert len(CachedBedSource(cache).tracks()) == 2


def test_pull_bed_skips_already_cached_refs(tmp_path: Path):
    """Idempotent: a warm cache skips the pull entirely — no download call
    (acceptance #5; and #4's 'never resolve on the hot path' posture)."""
    manifest = tmp_path / "m.txt"
    manifest.write_text("refA\nrefB\n", encoding="utf-8")
    cache = tmp_path / "cache"

    async def fake_download(ref: str, dest_base: Path) -> None:
        dest_base.with_suffix(".wav").write_bytes(b"pcm")

    asyncio.run(pull_bed(manifest=manifest, cache_dir=cache, download=fake_download))

    # Second run over the same warm cache: the downloader must not fire again.
    called: list[str] = []

    async def tripwire(ref: str, dest_base: Path) -> None:
        called.append(ref)

    count = asyncio.run(
        pull_bed(manifest=manifest, cache_dir=cache, download=tripwire)
    )
    assert called == []  # nothing re-pulled
    assert count == 2


def test_pull_bed_continues_past_a_failing_ref(tmp_path: Path):
    """A dead ref must not abort the pull (acceptance #5)."""
    manifest = tmp_path / "m.txt"
    manifest.write_text("good1\nbad\ngood2\n", encoding="utf-8")
    cache = tmp_path / "cache"

    async def flaky_download(ref: str, dest_base: Path) -> None:
        if ref == "bad":
            raise RuntimeError("dead ref")
        dest_base.with_suffix(".wav").write_bytes(b"pcm")

    count = asyncio.run(
        pull_bed(manifest=manifest, cache_dir=cache, download=flaky_download)
    )
    assert count == 2  # the two good refs landed; the bad one was skipped


def test_pull_bed_offline_leaves_empty_cache_no_crash(tmp_path: Path):
    """Every ref dead (offline) -> empty cache, no exception (degrade §3.4)."""
    manifest = tmp_path / "m.txt"
    manifest.write_text("a\nb\n", encoding="utf-8")
    cache = tmp_path / "cache"

    async def dead(ref: str, dest_base: Path) -> None:
        raise RuntimeError("offline")

    count = asyncio.run(pull_bed(manifest=manifest, cache_dir=cache, download=dead))
    assert count == 0
    assert CachedBedSource(cache).tracks() == []
