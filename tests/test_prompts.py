"""Prompt builder tests (spec 01 §3.2; prompts centralized in murmur.prompts)."""

from __future__ import annotations

from murmur.contracts import ContextPack, Turn
from murmur.prompts import (
    build_next_talk_prompt,
    build_next_talks_prompt,
    build_respond_prompt,
)


def _ctx(recent: list[Turn]) -> ContextPack:
    return ContextPack(persona="persona", recent=recent)


# --- batch look-ahead (spec 04 §3.2) -------------------------------------- #


def test_next_talks_prompt_asks_to_call_the_tool_for_count_beats():
    # Structured output is via the emit_talk_beats tool (talk_tools) — the prompt
    # points the model at it; the shape lives in the tool's schema, not here.
    prompt = build_next_talks_prompt(_ctx([]), count=2)
    assert "emit_talk_beats" in prompt
    assert "2" in prompt  # the count is stated
    assert "just starting" in prompt  # cold-open head, like the single builder


def test_next_talk_cold_open_has_no_transcript():
    prompt = build_next_talk_prompt(_ctx([]))
    assert "just starting" in prompt
    assert "You:" not in prompt and "Listener:" not in prompt


def test_next_talk_includes_transcript_with_speaker_labels():
    prompt = build_next_talk_prompt(_ctx([Turn("radio", "a"), Turn("user", "b")]))
    assert "You: a" in prompt
    assert "Listener: b" in prompt
    assert "continue" in prompt


def test_respond_includes_user_line_and_drops_trailing_duplicate():
    # recent ends with the same user line we are responding to -> not duplicated.
    ctx = _ctx([Turn("radio", "hi"), Turn("user", "yo")])
    prompt = build_respond_prompt("yo", ctx)
    assert 'said to you: "yo"' in prompt
    assert "You: hi" in prompt
    assert "Listener: yo" not in prompt  # trailing duplicate dropped


def test_respond_keeps_unrelated_listener_lines():
    ctx = _ctx([Turn("user", "earlier"), Turn("radio", "hi")])
    prompt = build_respond_prompt("now", ctx)
    assert "Listener: earlier" in prompt
    assert 'said to you: "now"' in prompt
