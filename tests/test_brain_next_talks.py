"""ClaudeBrain.next_talks wiring (spec 04 §3.2) — the tool path + its fallback,
without touching the SDK. run_task is monkeypatched to stand in for the model's
terminal emit_talk_beats call (or its absence)."""

from __future__ import annotations

import asyncio

from murmur.brain import ClaudeBrain
from murmur.contracts import ContextPack

_CTX = ContextPack(persona="p", recent=[])


def test_next_talks_returns_the_tool_beats(monkeypatch):
    async def go():
        brain = ClaudeBrain("m")

        async def tool_result(*args, **kwargs):
            return {"ok": True, "beats": ["one", "two"]}  # the emit_talk_beats call

        monkeypatch.setattr(brain, "run_task", tool_result)
        assert await brain.next_talks(_CTX, count=2) == ["one", "two"]

    asyncio.run(go())


def test_next_talks_falls_back_to_one_beat_on_empty_batch(monkeypatch):
    # Model never made the terminal call -> run_task returns None. Degrade to a
    # single plain-text beat, not a skipped segment (no dead air).
    async def go():
        brain = ClaudeBrain("m")

        async def no_tool_call(*args, **kwargs):
            return None

        async def solo(ctx):
            return "solo beat"

        monkeypatch.setattr(brain, "run_task", no_tool_call)
        monkeypatch.setattr(brain, "next_talk", solo)
        assert await brain.next_talks(_CTX, count=2) == ["solo beat"]

    asyncio.run(go())
