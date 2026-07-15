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
        # every_n=1: talk, then music, then talk again (counter reset). The talk
        # look-ahead SURVIVES the song (spec 04 §3.3) — the buffered talk-2 airs
        # after the song, warm, instead of regenerating cold into dead air.
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


def test_talk_lookahead_survives_a_song_no_cold_regen():
    """spec 04 §3.3: a beat buffered before a music segment airs AFTER the song
    (talk-2), not a cold-regenerated fresh beat — so the music->talk boundary has
    no Brain/synth wait. (Pre-§3.3 the song discarded the buffer and the post-song
    talk was a cold call.)"""

    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            picks=[_pick(announce=None)], cadence=EveryNCadence(n=1)
        )
        await director.run(max_segments=3)  # talk, music (no announce), talk
        assert [c.source for c in engine.music_played] == ["stream:r1"]
        assert cli.radio == ["talk-1", "talk-2"]  # talk-2 was buffered pre-song

    asyncio.run(go())


def test_talk_lookahead_depth_two_covers_two_music_completions():
    """spec 04 §3.3: depth-2 buffer — across TWO music completions, each post-song
    talk airs a warm buffered beat (talk-2 after song 1, talk-3 after song 2), with
    no cold regeneration at either music->talk boundary."""

    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            picks=[_pick(ref="r1", announce=None), _pick(ref="r2", announce=None)],
            cadence=ScriptedCadence(["talk", "music", "talk", "music", "talk"]),
        )
        await director.run(max_segments=5)
        assert [c.source for c in engine.music_played] == ["stream:r1", "stream:r2"]
        # talk-1 (seg1) buffers talk-2; song1; talk-2 airs warm (seg3), its record
        # triggers the next batch (talk-3,…); song2; talk-3 airs warm (seg5). The
        # low, gap-free numbering proves both post-song talks came from the buffer.
        assert cli.radio == ["talk-1", "talk-2", "talk-3"]

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
        # Prefetched after talk-1 (found nothing) -> music branch falls back to
        # talk-2, which re-primes the next prefetch: two attempts, both empty
        # (spec 04 — a transient "nothing found" must not disable music).
        assert len(programmer.contexts) == 2
        # The silent fallback is observable (found live: invisible otherwise).
        assert any("back to talk" in m for m in cli.infos)

    asyncio.run(go())


def test_announce_synthesis_failure_skips_the_intro_not_the_song():
    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            picks=[_pick(announce="up next: T1")]
        )
        director._voice = FakeVoice(fail_on=["up next: T1"])  # type: ignore[attr-defined]
        await director.run(max_segments=2)
        # The song still played; only the intro was skipped.
        assert [c.source for c in engine.music_played] == ["stream:r1"]
        assert "up next: T1" not in cli.radio
        assert any("synthesis failed" in m for m in cli.infos)

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


def test_music_pick_is_prefetched_during_talk():
    """spec 04 slice 1: the pick is found in the background after the first talk,
    so the music branch consumes an already-resolved pick. Observable: it was
    fetched once, early — its mood context has talk-1 but NOT the later talk-2
    (a cold fetch at the branch would have seen both)."""

    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            picks=[_pick()], cadence=EveryNCadence(n=2)
        )
        await director.run(max_segments=3)  # talk-1, talk-2, then music
        assert [c.source for c in engine.music_played] == ["stream:r1"]
        assert len(programmer.contexts) == 1  # fetched once (single-slot, one-ahead)
        situation = programmer.contexts[0].situation
        assert "talk-1" in situation  # prefetched after the first talk...
        assert "talk-2" not in situation  # ...before the second (fired early)

    asyncio.run(go())


def test_prefetch_fires_before_synthesis_with_fresh_mood():
    """The prefetch needs only the talk TEXT (mood), not its audio — so it fires
    right after the Brain produces the text, BEFORE TTS, overlapping synthesis
    too. The just-generated (not-yet-recorded) turn is fed into the mood so the
    pick still fits the current segment (spec 04 §3.1)."""

    async def go():
        events: list[tuple[str, str]] = []
        cli = FakeCli()
        programmer = FakeMusicProgrammer(picks=[_pick(announce=None)], events=events)
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=FakeBrain(),
            # synth_delay makes synthesis yield, so the (already-scheduled)
            # prefetch runs during it — proving the search overlaps TTS.
            voice=FakeVoice(events=events, synth_delay=0.05),
            player=FakeEngine(),
            memory=InProcessMemoryStore(),
            cli_host=cli,
            music=programmer,
            cadence=EveryNCadence(n=1),  # talk-1, then music
        )
        await director.run(max_segments=2)
        fetches = [i for i, e in enumerate(events) if e[0] == "fetch"]
        synths = [i for i, e in enumerate(events) if e == ("synth", "talk-1")]
        assert fetches and synths
        assert fetches[0] < synths[0]  # prefetch started BEFORE talk-1's TTS
        assert "talk-1" in events[fetches[0]][1]  # fresh text rode into the mood

    asyncio.run(go())


def test_cold_fallback_when_no_prefetch_available():
    """If the music branch fires with nothing prefetched (here: music is the very
    first segment, no talk ran to prime it), it does a cold fetch — correctness
    never depends on a warm buffer."""

    async def go():
        director, cli, brain, engine, programmer, memory = _make(
            picks=[_pick(announce=None)],
            cadence=ScriptedCadence(["music"]),  # music first, no talk before it
        )
        await director.run(max_segments=1)
        assert [c.source for c in engine.music_played] == ["stream:r1"]
        assert len(programmer.contexts) == 1  # the cold fetch at the branch

    asyncio.run(go())


def test_no_prefetch_when_music_wired_but_no_cadence():
    """Partial wiring (music but no cadence) is a talk-only Director — _wants_music
    is always False — so prefetch must NOT fire a search that can never be
    consumed (mirror the _wants_music gate)."""

    async def go():
        cli = FakeCli()
        programmer = FakeMusicProgrammer(picks=[_pick()])
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=FakeBrain(),
            voice=FakeVoice(),
            player=FakeEngine(),
            memory=InProcessMemoryStore(),
            cli_host=cli,
            music=programmer,  # music wired...
            cadence=None,  # ...but no cadence -> music can never play
        )
        await director.run(max_segments=2)
        assert programmer.contexts == []  # no speculative, unconsumable search
        assert director._pending_pick is None

    asyncio.run(go())


def test_prefetch_is_cancelled_on_shutdown():
    """An in-flight prefetch must not outlive the loop: /quit during the priming
    talk ends the run without hanging, and the pending task is settled."""

    class BlockingProgrammer:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.contexts: list[object] = []

        async def next_track(self, ctx):
            self.contexts.append(ctx)
            self.started.set()
            await asyncio.sleep(3600)  # block until cancelled

    async def go():
        prog = BlockingProgrammer()
        cli = FakeCli(["/quit"])
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=FakeBrain(),
            voice=FakeVoice(),
            player=FakeEngine(play_delay=0.05),
            memory=InProcessMemoryStore(),
            cli_host=cli,
            music=prog,
            cadence=EveryNCadence(n=2),
        )
        # /quit lands during talk-1 (which fired the prefetch); run must not hang
        # on the blocking fetch.
        await asyncio.wait_for(director.run(max_segments=None), 2.0)
        assert prog.started.is_set()  # the prefetch did fire during the talk
        assert director._pending_pick is None  # and was settled, not orphaned

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
