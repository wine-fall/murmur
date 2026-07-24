"""Director ↔ memory wiring (spec 05 §3.5/§3.9): the context pack carries the
profile + covered-topics, the ledger is written at AIR time (not generation),
and the music situation carries the recent-songs avoid-list. On fakes."""

from __future__ import annotations

import asyncio
from dataclasses import replace

from fakes import (
    FakeBrain,
    FakeCli,
    FakeEngine,
    FakeMusicProgrammer,
    FakeVoice,
    ScriptedCadence,
)

from murmur.cadence import EveryNCadence
from murmur.config import Config
from murmur.contracts import AudioClip, Turn
from murmur.director import Director
from murmur.memory import InProcessMemoryStore
from murmur.music.programmer import TrackPick


def _pick(ref: str = "r1") -> TrackPick:
    return TrackPick(
        clip=AudioClip(source=f"stream:{ref}", kind="music", title="T1", artist="U"),
        announce="up next: T1",
    )


def _make(*, picks=None, cadence=None, tag_topics=False, memory=None):
    cli = FakeCli()
    brain = FakeBrain(tag_topics=tag_topics)
    engine = FakeEngine()
    director = Director(
        config=replace(Config.default(), inter_segment_gap=0.0),
        persona="test-persona",
        brain=brain,
        voice=FakeVoice(),
        player=engine,
        memory=memory or InProcessMemoryStore(),
        cli_host=cli,
        music=FakeMusicProgrammer(picks=picks) if picks is not None else None,
        cadence=cadence,
    )
    return director, cli, brain


def test_context_pack_carries_profile_and_covered_topics():
    store = InProcessMemoryStore()
    store._profile = "Listener loves jazz."  # seed the profile tier directly
    store.record_event("topic", "night walks")
    director, _, brain = _make(tag_topics=False, memory=store)

    async def go():
        await director.run(max_segments=1)

    asyncio.run(go())
    # The batch call saw a pack built from the store.
    ctx = brain.packs[-1]
    assert ctx.profile == "Listener loves jazz."
    assert ctx.covered_topics == ("night walks",)


def test_tagged_beat_ledgers_its_topic_at_air_time():
    store = InProcessMemoryStore()
    director, _, _ = _make(tag_topics=True, memory=store)

    async def go():
        await director.run(max_segments=2)

    asyncio.run(go())
    # Each aired batch beat recorded its topic key (spec 05 §3.9).
    assert store.recent_topics(10) == ["topic-1", "topic-2"]


def test_untagged_beats_ledger_no_topic():
    store = InProcessMemoryStore()
    director, _, _ = _make(tag_topics=False, memory=store)

    async def go():
        await director.run(max_segments=2)

    asyncio.run(go())
    assert store.recent_topics(10) == []  # degrade silently, no topic events


def test_played_song_is_ledgered_at_air_time():
    store = InProcessMemoryStore()
    director, _, _ = _make(picks=[_pick()], cadence=EveryNCadence(n=1), memory=store)

    async def go():
        await director.run(max_segments=2)

    asyncio.run(go())
    assert store.recent_songs(10) == ["T1 — U"]


def test_music_situation_carries_recent_songs_avoid_list():
    store = InProcessMemoryStore()
    store.record_event("song", "Old Song — Someone")
    director, _, _ = _make(picks=[_pick()], cadence=EveryNCadence(n=1), memory=store)

    async def go():
        await director.run(max_segments=2)

    asyncio.run(go())
    # The music task's situation warned the brain off the recently-played song.
    programmer = director._music
    situation = programmer.contexts[-1].situation  # type: ignore[union-attr]
    assert "Old Song — Someone" in situation
