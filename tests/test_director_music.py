"""Director music branch (spec 03-02 §3.5): cadence scheduling, the first real
MusicContext, announce-over-song, and duck-not-stop interjections — on fakes.

The talk branch (test_director.py) is unchanged; these pin the fork:
- the cadence seam decides talk vs music; next_track None falls back to talk,
- the pick's announce is synthesized and played OVER the started music,
- a typed line during a song replies over it (engine stop() never targets the
  music; the handle is only stopped on /quit),
- MusicContext.situation carries the session's recent turns (Delivers #9).
"""

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
from murmur.contracts import AudioClip
from murmur.director import Director
from murmur.memory import InProcessMemoryStore
from murmur.music.programmer import TrackPick


def _pick(ref: str = "r1", announce: str | None = "up next: T1") -> TrackPick:
    return TrackPick(
        clip=AudioClip(source=f"stream:{ref}", kind="music", title="T1", artist="U"),
        announce=announce,
    )


def _make(
    *,
    lines: list[str] | None = None,
    play_delay: float = 0.0,
    picks: list[TrackPick] | None = None,
    cadence=None,
    auto_finish: bool = True,
):
    cli = FakeCli(lines)
    brain = FakeBrain()
    voice = FakeVoice()
    engine = FakeEngine(play_delay=play_delay, auto_finish=auto_finish)
    programmer = FakeMusicProgrammer(picks=picks)
    memory = InProcessMemoryStore()
    director = Director(
        config=replace(Config.default(), inter_segment_gap=0.0),
        persona="test-persona",
        brain=brain,
        voice=voice,
        player=engine,
        memory=memory,
        cli_host=cli,
        music=programmer,
        cadence=cadence if cadence is not None else EveryNCadence(n=1),
    )
    return director, cli, brain, engine, programmer, memory


def test_cadence_schedules_music_and_announce_rides_over_it():
    async def go():
        director, cli, brain, engine, programmer, memory = _make(picks=[_pick()])
        await director.run(max_segments=3)
        # every_n=1: talk, then music, then talk again (counter reset).
        assert cli.radio == ["talk-1", "up next: T1", "talk-2"]
        assert [c.source for c in engine.music_played] == ["stream:r1"]
        # The announce was spoken (played on the voice channel) AFTER the
        # music started, so it rides the ducked song head.
        assert "fake:up next: T1" in engine.played
        assert [t.text for t in memory.recent(10)] == [
            "talk-1",
            "up next: T1",
            "talk-2",
        ]

    asyncio.run(go())


def test_music_context_carries_recent_turns_and_persona():
    async def go():
        director, cli, brain, engine, programmer, memory = _make(picks=[_pick()])
        await director.run(max_segments=2)
        ctx = programmer.contexts[-1]
        assert ctx.persona == "test-persona"
        assert "talk-1" in ctx.situation  # the session's recent turns rode in

    asyncio.run(go())


def test_next_track_none_falls_back_to_talk():
    async def go():
        director, cli, brain, engine, programmer, memory = _make(picks=[])
        await director.run(max_segments=2)
        assert engine.music_played == []
        assert cli.radio == ["talk-1", "talk-2"]  # the music slot became talk
        assert len(programmer.contexts) == 1  # it did try after the first talk

    asyncio.run(go())


def test_pick_without_announce_skips_the_intro():
    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            picks=[_pick(announce=None)]
        )
        await director.run(max_segments=2)
        assert [c.source for c in engine.music_played] == ["stream:r1"]
        assert cli.radio == ["talk-1"]  # no announce segment rendered
        assert engine.played == ["fake:talk-1"]  # nothing extra spoken

    asyncio.run(go())


def test_typed_line_during_song_replies_over_it_without_stopping():
    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            lines=["hey"],
            picks=[_pick(announce=None)],
            cadence=ScriptedCadence(["music"]),
            auto_finish=False,
        )
        run_task = asyncio.ensure_future(director.run(max_segments=1))
        # Wait until the reply over the song has been spoken.
        for _ in range(500):
            if "fake:reply:hey" in engine.played:
                break
            await asyncio.sleep(0.005)
        assert brain.responded_to == ["hey"]
        assert engine.handles[0].stops == 0  # the song was NOT stopped
        assert engine.stops == 0  # and no voice stop either (no chained line)
        engine.handles[0].finish()  # the song ends naturally
        await asyncio.wait_for(run_task, 2.0)
        assert [t.text for t in memory.recent(10)] == ["hey", "reply:hey"]

    asyncio.run(go())


def test_typed_line_interrupts_the_announce_but_not_the_song():
    """The announce is an on-air spoken segment: user turns take priority
    (spec 01 invariant) — cancelling it cuts the intro, never the song."""

    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            lines=["hey"],
            play_delay=0.05,  # keeps the announce on air long enough to lose
            picks=[_pick(announce="up next: T1")],
            cadence=ScriptedCadence(["music"]),
        )
        await asyncio.wait_for(director.run(max_segments=1), 2.0)
        assert brain.responded_to == ["hey"]
        assert engine.stops >= 1  # the announce (voice channel) was cancelled
        assert engine.handles[0].stops == 0  # the song was not
        # The announce turn is still part of the program history.
        assert "up next: T1" in [t.text for t in memory.recent(10)]

    asyncio.run(go())


def test_music_machinery_failure_falls_back_to_talk():
    """A music error must never crash the radio (review fix)."""

    class ExplodingEngine(FakeEngine):
        async def play_music(self, clip: AudioClip):
            raise RuntimeError("no audio device")

    async def go():
        cli = FakeCli()
        brain = FakeBrain()
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=brain,
            voice=FakeVoice(),
            player=ExplodingEngine(),
            memory=InProcessMemoryStore(),
            cli_host=cli,
            music=FakeMusicProgrammer(picks=[_pick()]),
            cadence=ScriptedCadence(["music", "talk"]),
        )
        await asyncio.wait_for(director.run(max_segments=2), 2.0)
        assert cli.radio == ["talk-1", "talk-2"]  # degraded, not crashed

    asyncio.run(go())


def test_quit_during_song_stops_the_handle():
    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            lines=["/quit"],
            picks=[_pick(announce=None)],
            cadence=ScriptedCadence(["music"]),
            auto_finish=False,
        )
        await asyncio.wait_for(director.run(max_segments=None), 2.0)
        assert engine.handles[0].stops == 1  # shutdown stops the music
        assert brain.responded_to == []

    asyncio.run(go())


def test_talk_only_director_needs_no_music_wiring():
    """No music/cadence provided -> exactly the spec-01 loop (regression)."""

    async def go():
        cli = FakeCli()
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=FakeBrain(),
            voice=FakeVoice(),
            player=FakeEngine(),
            memory=InProcessMemoryStore(),
            cli_host=cli,
        )
        await director.run(max_segments=2)
        assert cli.radio == ["talk-1", "talk-2"]

    asyncio.run(go())
