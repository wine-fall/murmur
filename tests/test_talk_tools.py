"""Harness tool for batched talk generation (spec 04 §3.2).

Structured output via the tool seam (like music's submit_pick): the model returns
its beats by calling ``emit_talk_beats``; the SDK hands them back as a parsed dict,
so there is no free-text JSON to scrape. These pin the deterministic halves — the
tool's ``run`` validation and the consumer-side ``parse_talk_beats``.
"""

from __future__ import annotations

import asyncio

from murmur.talk_tools import EmitTalkBeatsTool, parse_talk_beats


def test_tool_advertises_a_terminal_beats_schema():
    tool = EmitTalkBeatsTool(count=2)
    assert tool.name == "emit_talk_beats"
    assert tool.terminal is True
    props = tool.input_schema["properties"]
    assert props["beats"]["type"] == "array"
    assert props["beats"]["items"]["type"] == "string"
    assert props["beats"]["maxItems"] == 2
    assert "beats" in tool.input_schema["required"]


def test_run_returns_clean_beats_capped_to_count():
    async def go():
        tool = EmitTalkBeatsTool(count=2)
        # junk items dropped; capped to count; result is a dict (no JSON parsing).
        out = await tool.run({"beats": ["one", "", "  ", 42, "two", "three"]})
        assert out == {"ok": True, "beats": ["one", "two"]}

    asyncio.run(go())


def test_run_tolerates_missing_or_misshaped_beats():
    async def go():
        tool = EmitTalkBeatsTool(count=2)
        assert (await tool.run({}))["beats"] == []
        assert (await tool.run({"beats": "not a list"}))["beats"] == []

    asyncio.run(go())


def test_parse_talk_beats_reads_a_successful_call():
    assert parse_talk_beats({"ok": True, "beats": ["a", "b"]}) == ["a", "b"]


def test_parse_talk_beats_rejects_non_success():
    assert parse_talk_beats(None) == []  # model never called the tool
    assert parse_talk_beats({"ok": False}) == []
    assert parse_talk_beats({"ok": True, "beats": "nope"}) == []  # shape drifted
    # strips junk defensively even if run() didn't
    assert parse_talk_beats({"ok": True, "beats": ["a", "", 7, "b"]}) == ["a", "b"]
