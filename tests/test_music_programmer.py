"""MusicProgrammer.next_track find-and-pull flow (spec 03-01 §3.2), fakes only.

These pin the plumbing — search -> submit_pick -> resolved clip, retry on a
resolve failure, None when nothing resolves, and the §2.5 context split — not
selection quality (that is the Ollama/human layer).
"""

from __future__ import annotations

import asyncio

from fakes import FakeMusicBrain, FakeMusicProvider

from murmur.contracts import AudioClip, TrackCandidate
from murmur.music.context import MusicContext
from murmur.music.programmer import MusicProgrammer


def _cands(*refs: str) -> list[TrackCandidate]:
    return [
        TrackCandidate(ref=r, title=f"T-{r}", uploader="U", duration_s=200)
        for r in refs
    ]


def test_next_track_returns_the_resolved_clip():
    provider = FakeMusicProvider(candidates=_cands("r1", "r2"), resolvable={"r1", "r2"})
    prog = MusicProgrammer(brain=FakeMusicBrain(), provider=provider, model="haiku")

    async def go():
        clip = await prog.next_track(MusicContext(persona="P", situation="S"))
        assert clip == AudioClip(source="stream:r1", kind="music")

    asyncio.run(go())


def test_next_track_retries_when_a_pick_fails_to_resolve():
    provider = FakeMusicProvider(candidates=_cands("bad", "good"), resolvable={"good"})
    prog = MusicProgrammer(brain=FakeMusicBrain(), provider=provider, model="haiku")

    async def go():
        clip = await prog.next_track(MusicContext(persona="P", situation="S"))
        assert clip == AudioClip(source="stream:good", kind="music")
        assert provider.resolved == ["bad", "good"]  # tried the first, then the next

    asyncio.run(go())


def test_next_track_returns_none_when_nothing_resolves():
    provider = FakeMusicProvider(candidates=_cands("a", "b"), resolvable=set())
    prog = MusicProgrammer(brain=FakeMusicBrain(), provider=provider, model="haiku")

    async def go():
        assert await prog.next_track(MusicContext(persona="P", situation="S")) is None

    asyncio.run(go())


def test_next_track_inserts_persona_as_cached_prefix_and_situation_in_the_turn():
    provider = FakeMusicProvider(candidates=_cands("r1"), resolvable={"r1"})
    brain = FakeMusicBrain()
    prog = MusicProgrammer(brain=brain, provider=provider, model="haiku")

    async def go():
        await prog.next_track(MusicContext(persona="PERSONA_X", situation="SIT_Y"))
        task = brain.tasks[-1]
        assert task["system_prompt"] == "PERSONA_X"  # cached prefix = persona
        assert "SIT_Y" in task["prompt"]  # volatile situation rode the turn
        assert task["model"] == "haiku"

    asyncio.run(go())
