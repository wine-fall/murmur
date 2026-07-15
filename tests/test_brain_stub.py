"""StubBrain behavior (the fake, no network)."""

from __future__ import annotations

import asyncio

from murmur.brain import StubBrain
from murmur.contracts import ContextPack

_CTX = ContextPack(persona="p", recent=[])


def test_next_talk_cycles_segments():
    async def go():
        b = StubBrain()
        first = [await b.next_talk(_CTX) for _ in range(5)]
        # 5 distinct canned segments, then it cycles back to the first.
        assert len(set(first)) == 5
        assert await b.next_talk(_CTX) == first[0]

    asyncio.run(go())


def test_next_talks_returns_count_consecutive_beats():
    async def go():
        b = StubBrain()
        beats = await b.next_talks(_CTX, count=2)
        assert len(beats) == 2
        assert all(isinstance(x, str) and x for x in beats)
        assert beats[0] != beats[1]  # consecutive, distinct canned segments
        # default count is 2
        assert len(await b.next_talks(_CTX)) == 2

    asyncio.run(go())


def test_respond_echoes_user_text():
    async def go():
        b = StubBrain()
        reply = await b.respond("are you there", _CTX)
        assert "are you there" in reply

    asyncio.run(go())
