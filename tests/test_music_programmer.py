"""MusicProgrammer.next_track find-and-pull flow (spec 03-01 §3.2), fakes only.

These pin the plumbing — search -> submit_pick -> resolved pick, retry on a
resolve failure, None when nothing resolves, and the §2.5 context split — not
selection quality (that is the Ollama/human layer). Per the 03-02 extension,
next_track returns a TrackPick (clip with title/artist + the announce line).
"""

from __future__ import annotations

import asyncio
import wave
from pathlib import Path

import numpy as np
import pytest
from fakes import FakeMusicBrain, FakeMusicProvider

from murmur.contracts import AudioClip, TrackCandidate
from murmur.music.context import MusicContext
from murmur.music.programmer import MusicProgrammer, TrackPick


def _cands(*refs: str) -> list[TrackCandidate]:
    return [
        TrackCandidate(ref=r, title=f"T-{r}", uploader="U", duration_s=200)
        for r in refs
    ]


def test_next_track_returns_a_pick_with_clip_metadata_and_announce():
    provider = FakeMusicProvider(candidates=_cands("r1", "r2"), resolvable={"r1", "r2"})
    prog = MusicProgrammer(brain=FakeMusicBrain(), provider=provider, model="haiku")

    async def go():
        pick = await prog.next_track(MusicContext(persona="P", situation="S"))
        assert isinstance(pick, TrackPick)
        assert pick.clip.source == "stream:r1"
        assert pick.clip.kind == "music"
        assert pick.clip.title == "T-r1"
        assert pick.clip.artist == "U"
        assert pick.announce == "up next: T-r1"

    asyncio.run(go())


def test_next_track_announce_is_none_when_the_task_omits_it():
    provider = FakeMusicProvider(candidates=_cands("r1"), resolvable={"r1"})
    prog = MusicProgrammer(
        brain=FakeMusicBrain(with_announce=False), provider=provider, model="haiku"
    )

    async def go():
        pick = await prog.next_track(MusicContext(persona="P", situation="S"))
        assert pick is not None
        assert pick.announce is None

    asyncio.run(go())


def test_next_track_retries_when_a_pick_fails_to_resolve():
    provider = FakeMusicProvider(candidates=_cands("bad", "good"), resolvable={"good"})
    prog = MusicProgrammer(brain=FakeMusicBrain(), provider=provider, model="haiku")

    async def go():
        pick = await prog.next_track(MusicContext(persona="P", situation="S"))
        assert pick is not None
        assert pick.clip.source == "stream:good"
        assert provider.resolved == ["bad", "good"]  # tried the first, then the next

    asyncio.run(go())


def test_next_track_skips_a_pick_whose_stream_never_plays():
    # spec 04: both refs resolve, but only "good" actually decodes. The pull-time
    # probe drops the dead stream so next_track returns a PLAYABLE pick — the
    # model never announces a track that would 403 at playback.
    provider = FakeMusicProvider(
        candidates=_cands("dead", "good"), resolvable={"dead", "good"}
    )

    async def probe(source: str) -> bool:
        return source == "stream:good"

    prog = MusicProgrammer(
        brain=FakeMusicBrain(), provider=provider, model="haiku", probe=probe
    )

    async def go():
        pick = await prog.next_track(MusicContext(persona="P", situation="S"))
        assert pick is not None
        assert pick.clip.source == "stream:good"
        assert provider.resolved == ["dead", "good"]  # probed dead, then took good

    asyncio.run(go())


@pytest.mark.integration
def test_next_track_e2e_drops_a_dead_stream_with_the_real_probe(tmp_path: Path):
    """e2e (real ffmpeg, no network): the REAL build_probe wired through the REAL
    pull pipeline. Local files stand in for resolved stream URLs — one decodes,
    one cannot be opened (the 403 stand-in). next_track must probe the dead one,
    reject it, and return the pick that actually plays (spec 04)."""
    from murmur.engine import build_probe

    good = tmp_path / "good.wav"
    with wave.open(str(good), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(8_000)
        w.writeframes((np.full((2_000, 2), 0.3) * 32767).astype(np.int16).tobytes())
    dead = tmp_path / "nope.mp3"  # nonexistent -> ffmpeg cannot open it

    class LocalProvider:
        def __init__(self) -> None:
            self.resolved: list[str] = []

        async def start(self) -> None: ...

        async def search(self, query: str, *, limit: int = 5) -> list[TrackCandidate]:
            return _cands("dead", "good")

        async def resolve(self, ref: str) -> AudioClip:
            self.resolved.append(ref)
            return AudioClip(source=str(good if ref == "good" else dead), kind="music")

        async def aclose(self) -> None: ...

    provider = LocalProvider()
    prog = MusicProgrammer(
        brain=FakeMusicBrain(),
        provider=provider,
        model="haiku",
        probe=build_probe(ffmpeg="ffmpeg"),
    )

    async def go():
        pick = await prog.next_track(MusicContext(persona="P", situation="S"))
        assert pick is not None
        assert pick.clip.source == str(good)
        assert provider.resolved == ["dead", "good"]  # probed dead, then took good

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
