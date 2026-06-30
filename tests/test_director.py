"""Director arbitration tests (spec 01 §3.3) — the core loop on fakes."""

from __future__ import annotations

import asyncio
from dataclasses import replace

from fakes import FakeBrain, FakeCli, FakePlayer, FakeVoice

from murmur.config import Config
from murmur.director import Director
from murmur.memory import InProcessMemoryStore


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


def test_chained_interjections():
    """A line arriving during a reply is handled before the program resumes."""

    async def go():
        director, cli, brain, player, memory = _make(
            lines=["first", "second"], play_delay=0.05
        )
        await director.run(max_segments=1)
        assert brain.responded_to == ["first", "second"]
        assert [t.text for t in memory.recent(10)] == [
            "talk-1",
            "first",
            "reply:first",
            "second",
            "reply:second",
        ]

    asyncio.run(go())
