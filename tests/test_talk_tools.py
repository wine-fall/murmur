"""Harness tool for batched talk generation (spec 04 §3.2).

Structured output via the tool seam (like music's submit_pick): the model returns
its beats by calling ``emit_talk_beats``; the SDK hands them back as a parsed dict,
so there is no free-text JSON to scrape. These pin the deterministic halves — the
tool's ``run`` validation and the consumer-side ``parse_talk_beats``.
"""

from __future__ import annotations

import asyncio

from murmur.contracts import TalkBeat
from murmur.talk_tools import EmitTalkBeatsTool, parse_talk_beats


def test_tool_advertises_a_terminal_beats_schema():
    tool = EmitTalkBeatsTool(count=2)
    assert tool.name == "emit_talk_beats"
    assert tool.terminal is True
    props = tool.input_schema["properties"]
    assert props["beats"]["type"] == "array"
    # Each beat is now an object {text, topic?} (spec 05 §3.9): text required,
    # topic optional.
    item = props["beats"]["items"]
    assert item["type"] == "object"
    assert item["required"] == ["text"]
    assert "topic" in item["properties"]
    assert props["beats"]["maxItems"] == 2
    assert "beats" in tool.input_schema["required"]


def test_run_returns_clean_beats_capped_to_count():
    async def go():
        tool = EmitTalkBeatsTool(count=2)
        # junk items dropped; capped to count; topics carried when present.
        out = await tool.run(
            {
                "beats": [
                    {"text": "one", "topic": "t1"},
                    {"text": "  "},  # empty text dropped
                    {"text": "two"},  # topic-less
                    {"text": "three"},
                ]
            }
        )
        # Wire-shaped dicts (NOT TalkBeat objects): the harness serializes this
        # back to the model, so it must stay JSON.
        assert out == {"ok": True, "beats": [{"text": "one", "topic": "t1"}, {"text": "two"}]}

    asyncio.run(go())


def test_run_result_is_json_serializable():
    # Regression (the harness json-serializes the tool result back to the model):
    # a TalkBeat dataclass here would crash the real next_talks path.
    import json

    async def go():
        tool = EmitTalkBeatsTool(count=2)
        out = await tool.run({"beats": [{"text": "one", "topic": "t1"}]})
        json.dumps(out)  # must not raise

    asyncio.run(go())


def test_run_tolerates_missing_or_misshaped_beats():
    async def go():
        tool = EmitTalkBeatsTool(count=2)
        assert (await tool.run({}))["beats"] == []
        assert (await tool.run({"beats": "not a list"}))["beats"] == []

    asyncio.run(go())


def test_parse_talk_beats_reads_a_successful_call():
    assert parse_talk_beats(
        {"ok": True, "beats": [{"text": "a", "topic": "x"}, {"text": "b"}]}
    ) == [TalkBeat("a", "x"), TalkBeat("b", None)]


def test_parse_talk_beats_tolerates_bare_strings():
    # A model emitting the older string shape still airs (topic-less).
    assert parse_talk_beats({"ok": True, "beats": ["a", "b"]}) == [
        TalkBeat("a", None),
        TalkBeat("b", None),
    ]


def test_parse_talk_beats_rejects_non_success():
    assert parse_talk_beats(None) == []  # model never called the tool
    assert parse_talk_beats({"ok": False}) == []
    assert parse_talk_beats({"ok": True, "beats": "nope"}) == []  # shape drifted
    # strips junk defensively even if run() didn't
    assert parse_talk_beats(
        {"ok": True, "beats": [{"text": "a"}, {"text": ""}, 7, {"text": "b"}]}
    ) == [TalkBeat("a", None), TalkBeat("b", None)]
