"""Tests for the harness music tools (spec 03-01 §2.3), fakes only."""

from __future__ import annotations

import asyncio

from fakes import FakeMusicProvider

from murmur.contracts import TrackCandidate
from murmur.music.tools import (
    SearchMusicTool,
    SubmitPickTool,
    parse_submit_success,
)


def test_search_music_returns_candidates_and_is_not_terminal():
    cands = [TrackCandidate(ref="r1", title="T1", uploader="U", duration_s=200)]
    provider = FakeMusicProvider(candidates=cands, resolvable={"r1"})
    tool = SearchMusicTool(provider)

    async def go():
        out = await tool.run({"query": "jazz", "limit": 3})
        assert [c["ref"] for c in out["candidates"]] == ["r1"]
        assert provider.searched == [("jazz", 3)]

    asyncio.run(go())
    assert tool.terminal is False
    assert tool.name == "search_music"
    assert "query" in tool.input_schema.get("properties", {})


def test_submit_pick_ok_returns_source_kind_and_metadata_and_is_terminal():
    cands = [TrackCandidate(ref="r1", title="T1", uploader="U", duration_s=200)]
    provider = FakeMusicProvider(candidates=cands, resolvable={"r1"})
    tool = SubmitPickTool(provider)

    async def go():
        out = await tool.run(
            {
                "ref": "r1",
                "why": "fits the mood",
                "title": "T1",
                "artist": "U",
                "announce": "up next: T1",
            }
        )
        assert out == {
            "ok": True,
            "source": "stream:r1",
            "kind": "music",
            "title": "T1",
            "artist": "U",
            "announce": "up next: T1",
        }

    asyncio.run(go())
    assert tool.terminal is True
    assert tool.name == "submit_pick"
    for key in ("title", "artist", "announce"):
        assert key in tool.input_schema.get("properties", {})


def test_submit_pick_tolerates_missing_metadata():
    cands = [TrackCandidate(ref="r1", title="T1", uploader="U", duration_s=200)]
    provider = FakeMusicProvider(candidates=cands, resolvable={"r1"})
    tool = SubmitPickTool(provider)

    async def go():
        out = await tool.run({"ref": "r1", "why": "x"})
        assert out["ok"] is True
        assert out["title"] is None
        assert out["artist"] is None
        assert out["announce"] is None

    asyncio.run(go())


def test_submit_pick_resolve_failure_is_a_nonterminating_result():
    provider = FakeMusicProvider(candidates=[], resolvable=set())
    tool = SubmitPickTool(provider)

    async def go():
        out = await tool.run({"ref": "missing", "why": "x"})
        assert out["ok"] is False
        assert "error" in out

    asyncio.run(go())


def test_submit_pick_rejects_an_unplayable_stream_as_a_retryable_error():
    # spec 04: resolve can succeed but the stream 403s and never decodes. A
    # pull-time probe rejects it as a NON-terminating error so the model picks
    # another candidate — the pick is validated before it can be announced.
    cands = [TrackCandidate(ref="r1", title="T1", uploader="U", duration_s=200)]
    provider = FakeMusicProvider(candidates=cands, resolvable={"r1"})

    async def probe_dead(source: str) -> bool:
        return False

    tool = SubmitPickTool(provider, probe=probe_dead)

    async def go():
        out = await tool.run({"ref": "r1", "why": "x"})
        assert out["ok"] is False
        assert "error" in out
        assert provider.resolved == ["r1"]  # resolved, then rejected on the probe

    asyncio.run(go())


def test_submit_pick_accepts_a_stream_that_decodes():
    cands = [TrackCandidate(ref="r1", title="T1", uploader="U", duration_s=200)]
    provider = FakeMusicProvider(candidates=cands, resolvable={"r1"})

    async def probe_ok(source: str) -> bool:
        return True

    tool = SubmitPickTool(provider, probe=probe_ok)

    async def go():
        out = await tool.run({"ref": "r1", "why": "x"})
        assert out["ok"] is True
        assert out["source"] == "stream:r1"

    asyncio.run(go())


def test_submit_pick_does_not_probe_when_resolve_fails():
    provider = FakeMusicProvider(candidates=[], resolvable=set())
    probed: list[str] = []

    async def probe(source: str) -> bool:
        probed.append(source)
        return True

    tool = SubmitPickTool(provider, probe=probe)

    async def go():
        out = await tool.run({"ref": "missing", "why": "x"})
        assert out["ok"] is False
        assert probed == []  # resolve failed first — nothing to probe

    asyncio.run(go())


def test_submit_pick_missing_ref_is_a_clean_error_not_a_crash():
    # The model controls args; an omitted 'ref' must degrade to a retryable
    # error result, never raise (it used to KeyError on args["ref"]).
    provider = FakeMusicProvider(candidates=[], resolvable=set())
    tool = SubmitPickTool(provider)

    async def go():
        out = await tool.run({"why": "no ref supplied"})
        assert out["ok"] is False
        assert "ref" in out["error"]
        assert provider.resolved == []  # never even tried to resolve

    asyncio.run(go())


def test_parse_submit_success_validates_the_opaque_result():
    good = {
        "ok": True,
        "source": "stream:r1",
        "kind": "music",
        "title": "T1",
        "artist": "U",
        "announce": "up next",
    }
    pick = parse_submit_success(good)
    assert pick is not None
    assert pick["source"] == "stream:r1"
    assert pick["announce"] == "up next"

    # Not a usable success -> None, so next_track falls back to talk.
    assert parse_submit_success(None) is None
    assert parse_submit_success({}) is None
    assert parse_submit_success({"ok": False, "error": "boom"}) is None
    assert parse_submit_success({"ok": True}) is None  # missing source
    assert parse_submit_success({"ok": True, "source": ""}) is None  # empty source


def test_parse_submit_success_defaults_and_scrubs_drifted_fields():
    # A drifted shape (non-str kind, numeric title) must not produce a bad clip:
    # kind defaults to "music" and non-string metadata is dropped to None.
    pick = parse_submit_success(
        {"ok": True, "source": "s", "kind": 7, "title": 123, "artist": None}
    )
    assert pick is not None
    assert pick["kind"] == "music"
    assert pick["title"] is None
    assert pick["artist"] is None
