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


# --- time-of-day scene (spec 04 §3.4) ------------------------------------- #


def test_next_talks_prompt_threads_scene_guidance_when_set():
    ctx = ContextPack(persona="persona", recent=[], scene="late-night")
    prompt = build_next_talks_prompt(ctx, count=2)
    assert "late at night" in prompt  # the late-night scene guidance is present


def test_next_talk_prompt_threads_scene_guidance_when_set():
    ctx = ContextPack(persona="persona", recent=[], scene="morning")
    prompt = build_next_talk_prompt(ctx)
    assert "morning" in prompt  # the morning scene guidance is present


def test_prompts_omit_scene_guidance_when_absent():
    # scene defaults to None -> no time-of-day sentence leaks into the prompt.
    assert "late at night" not in build_next_talk_prompt(_ctx([]))
    assert "late at night" not in build_next_talks_prompt(_ctx([]), count=2)


def test_unknown_scene_is_ignored_not_crashed():
    # A label with no guidance mapping degrades to no scene line (never raises).
    ctx = ContextPack(persona="persona", recent=[], scene="zzz-unknown")
    assert "zzz-unknown" not in build_next_talk_prompt(ctx)


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
