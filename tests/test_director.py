"""Director arbitration tests (spec 01 §3.3) — the core loop on fakes."""

from __future__ import annotations

import asyncio
from dataclasses import replace

from fakes import FakeBrain, FakeCli, FakePlayer, FakeVoice

from murmur.config import Config
from murmur.director import Director, Steer
from murmur.memory import InProcessMemoryStore


def test_steer_from_line_classifies_intent():
    """Steer is the first-class typed-interrupt: text + intent (quit/talkback)."""
    talk = Steer.from_line("hello there")
    assert talk.text == "hello there"
    assert talk.intent == "talkback"

    assert Steer.from_line("/quit").intent == "quit"
    assert Steer.from_line("  /quit  ").intent == "quit"  # surrounding space trimmed
    # a line that merely mentions /quit is an ordinary talkback, not a quit.
    assert Steer.from_line("what does /quit do").intent == "talkback"


def _make(*, lines: list[str] | None = None, play_delay: float = 0.0):
    cli = FakeCli(lines)
    brain = FakeBrain()
    voice = FakeVoice()
    player = FakePlayer(play_delay=play_delay)
    memory = InProcessMemoryStore()
    director = Director(
        config=replace(Config.default(), inter_segment_gap=0.0),
        persona="test-persona",
        brain=brain,
        voice=voice,
        player=player,
        memory=memory,
        cli_host=cli,
    )
    return director, cli, brain, player, memory


def test_autonomous_loop_produces_segments():
    """With no input, it speaks on its own up to max_segments (§1)."""

    async def go():
        director, cli, brain, player, memory = _make()
        await director.run(max_segments=3)
        assert cli.radio == ["talk-1", "talk-2", "talk-3"]
        assert player.played == ["fake:talk-1", "fake:talk-2", "fake:talk-3"]
        assert [t.text for t in memory.recent(10)] == ["talk-1", "talk-2", "talk-3"]
        assert cli.started is True

    asyncio.run(go())


def test_typed_line_interrupts_replies_and_resumes():
    """A typed line interrupts, gets an in-persona reply, then the program
    resumes with the next talk segment (§3)."""

    async def go():
        # One line interrupts; max_segments=2 so a second talk segment follows.
        director, cli, brain, player, memory = _make(lines=["hello"], play_delay=0.05)
        await director.run(max_segments=2)
        assert brain.responded_to == ["hello"]
        assert cli.user == ["hello"]
        # talk-1 (interrupted) -> reply -> talk-2 (resumed)
        assert cli.radio == ["talk-1", "reply:hello", "talk-2"]
        assert [t.role for t in memory.recent(10)] == [
            "radio",
            "user",
            "radio",
            "radio",
        ]
        assert [t.text for t in memory.recent(10)] == [
            "talk-1",
            "hello",
            "reply:hello",
            "talk-2",
        ]
        assert player.stops >= 1  # playback was stopped for the interjection

    asyncio.run(go())


def test_quit_command_stops_cleanly():
    """A typed /quit ends the program (§4)."""

    async def go():
        director, cli, brain, player, memory = _make(lines=["/quit"], play_delay=0.05)
        await director.run(max_segments=None)  # would loop forever without /quit
        # /quit is not echoed as a user turn and gets no reply.
        assert brain.responded_to == []
        assert cli.user == []
        assert [t.text for t in memory.recent(10)] == ["talk-1"]

    asyncio.run(go())


def test_talk_synthesis_failure_skips_the_segment_not_the_radio():
    """A TTS failure degrades to a skipped segment (info line, nothing aired
    or recorded); the loop keeps broadcasting. Found live: one bad utterance
    killed the whole radio."""

    async def go():
        cli = FakeCli()
        brain = FakeBrain()
        voice = FakeVoice(fail_on=["talk-2"])  # the second segment's text
        player = FakePlayer()
        memory = InProcessMemoryStore()
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=brain,
            voice=voice,
            player=player,
            memory=memory,
            cli_host=cli,
        )
        await director.run(max_segments=3)
        # talk-2 was never aired: not printed, not played, not recorded.
        assert cli.radio == ["talk-1", "talk-3"]
        assert player.played == ["fake:talk-1", "fake:talk-3"]
        assert [t.text for t in memory.recent(10)] == ["talk-1", "talk-3"]
        assert any("synthesis failed" in m for m in cli.infos)

    asyncio.run(go())


def test_reply_synthesis_failure_degrades_and_resumes():
    """A failed reply synthesis is skipped (the user turn is still recorded);
    the program resumes instead of crashing."""

    async def go():
        cli = FakeCli(["hello"])
        brain = FakeBrain()
        voice = FakeVoice(fail_on=["reply:hello"])
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=brain,
            voice=voice,
            player=FakePlayer(play_delay=0.05),
            memory=InProcessMemoryStore(),
            cli_host=cli,
        )
        await director.run(max_segments=2)
        assert brain.responded_to == ["hello"]
        assert cli.radio == ["talk-1", "talk-2"]  # the reply never aired
        assert any("synthesis failed" in m for m in cli.infos)

    asyncio.run(go())


def test_interjection_prepares_reply_before_barging_in():
    """Deferred barge-in (spec 01 §3.3): the current clip keeps playing until
    the reply is synthesized; only then is it cut — no dead-air gap."""

    async def go():
        events: list[tuple[str, str]] = []
        cli = FakeCli(["hello"])
        brain = FakeBrain()
        voice = FakeVoice(events=events)
        player = FakePlayer(play_delay=0.2, events=events)
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=brain,
            voice=voice,
            player=player,
            memory=InProcessMemoryStore(),
            cli_host=cli,
        )
        await director.run(max_segments=1)
        # The current clip aired, the reply was synthesized, then a stop cut over.
        assert ("play", "fake:talk-1") in events
        assert ("synth", "reply:hello") in events
        assert ("stop", "") in events
        # The key ordering: reply ready BEFORE the barge-in stop (not after).
        assert events.index(("synth", "reply:hello")) < events.index(("stop", ""))

    asyncio.run(go())


def test_lines_before_reply_ready_merge_into_one():
    """A line that lands while the Brain is still composing merges into one
    combined reply (spec 01 §3.3) — not a second queued turn."""

    async def go():
        cli = FakeCli(["first", "second"])
        brain = FakeBrain(respond_delay=0.05)  # stays composing so "second" merges
        voice = FakeVoice()
        player = FakePlayer(play_delay=0.3)  # talk-1 stays on air through the merge
        memory = InProcessMemoryStore()
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=brain,
            voice=voice,
            player=player,
            memory=memory,
            cli_host=cli,
        )
        await director.run(max_segments=1)
        # One reply over both lines, not two separate replies.
        assert brain.responded_to == ["first\nsecond"]
        assert cli.user == ["first", "second"]
        assert cli.radio == ["talk-1", "reply:first\nsecond"]
        assert [t.text for t in memory.recent(10)] == [
            "talk-1",
            "first",
            "second",
            "reply:first\nsecond",
        ]

    asyncio.run(go())


def test_line_during_synthesis_also_merges_no_stale_reply_airs():
    """The merge window runs until the reply CLIP is ready, not just until the
    Brain finishes composing: a line landing during synthesis still merges, so
    a now-stale reply is never briefly aired then cut (spec 01 §3.3)."""

    async def go():
        cli = FakeCli(["first", "second"])
        brain = FakeBrain()  # compose is instant; the merge lands during synth
        voice = FakeVoice(synth_delay=0.1)  # reply stays "rendering" so 2nd merges
        player = FakePlayer(play_delay=0.5)  # talk-1 on air throughout
        memory = InProcessMemoryStore()
        director = Director(
            config=replace(Config.default(), inter_segment_gap=0.0),
            persona="p",
            brain=brain,
            voice=voice,
            player=player,
            memory=memory,
            cli_host=cli,
        )
        await director.run(max_segments=1)
        # The stale "reply:first" clip was discarded, never aired.
        assert "reply:first" not in cli.radio
        assert cli.radio == ["talk-1", "reply:first\nsecond"]
        assert brain.responded_to[-1] == "first\nsecond"
        assert cli.user == ["first", "second"]

    asyncio.run(go())
