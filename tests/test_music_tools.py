"""Tests for the harness music tools (spec 03-01 §2.3), fakes only."""

from __future__ import annotations

import asyncio

from fakes import FakeMusicProvider

from murmur.contracts import TrackCandidate
from murmur.music.tools import SearchMusicTool, SubmitPickTool


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
