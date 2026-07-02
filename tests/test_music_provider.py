"""Unit tests for the yt-dlp MusicProvider adapter (spec 03-01 §2.2).

The subprocess itself is not exercised here (that is the tagged integration
test); these pin the deterministic **parsing** of yt-dlp output into
``TrackCandidate`` / ``AudioClip``, which is where the real logic lives.
"""

from __future__ import annotations

import pytest

from murmur.contracts import TrackCandidate
from murmur.music.provider import _parse_resolve_output, _parse_search_output

_SEARCH_JSON = (
    '{"id":"abc","title":"Rainy Night Jazz","uploader":"JazzCafe",'
    '"duration":214,"view_count":10000,"webpage_url":"https://youtu.be/abc"}\n'
    '{"id":"def","title":"10 Hour Rain Loop","channel":"LoopMaker",'
    '"duration":36000,"view_count":500}\n'
)


def test_parse_search_output_builds_candidates() -> None:
    cands = _parse_search_output(_SEARCH_JSON, limit=5)

    assert [c.title for c in cands] == ["Rainy Night Jazz", "10 Hour Rain Loop"]
    first = cands[0]
    assert isinstance(first, TrackCandidate)
    # ref prefers the webpage URL; falls back to the id when absent.
    assert first.ref == "https://youtu.be/abc"
    assert cands[1].ref == "def"
    # uploader falls back from "uploader" to "channel".
    assert first.uploader == "JazzCafe"
    assert cands[1].uploader == "LoopMaker"
    # duration is surfaced so the brain can reject hour-long loops.
    assert first.duration_s == 214
    assert cands[1].duration_s == 36000
    assert first.extra.get("view_count") == 10000


def test_parse_search_output_respects_limit_and_skips_junk_lines() -> None:
    noisy = "not json\n" + _SEARCH_JSON + "\n{bad}\n"
    cands = _parse_search_output(noisy, limit=1)
    assert len(cands) == 1
    assert cands[0].title == "Rainy Night Jazz"


def test_parse_resolve_output_takes_first_nonempty_url() -> None:
    assert (
        _parse_resolve_output("\nhttps://stream.example/a.m4a\nhttps://ignored\n")
        == "https://stream.example/a.m4a"
    )


def test_parse_resolve_output_raises_when_empty() -> None:
    with pytest.raises(ValueError):
        _parse_resolve_output("   \n\n")


@pytest.mark.integration
def test_yt_dlp_search_and_resolve_live() -> None:
    """On-demand (needs yt-dlp + network): real search -> resolve to a URL."""
    import asyncio
    import shutil

    from murmur.music.provider import YtDlpMusicProvider

    if shutil.which("yt-dlp") is None:
        pytest.skip("yt-dlp not installed")

    provider = YtDlpMusicProvider()

    async def go() -> None:
        candidates = await provider.search("lofi hip hop radio", limit=3)
        assert candidates and all(c.ref for c in candidates)
        clip = await provider.resolve(candidates[0].ref)
        assert clip.kind == "music"
        assert clip.source.startswith("http")

    asyncio.run(go())
