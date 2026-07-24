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


# --- profile + covered-topics (spec 05 §3.5) ------------------------------ #


def test_profile_renders_as_a_stable_block_before_transcript():
    ctx = ContextPack(
        persona="persona",
        recent=[Turn("radio", "a")],
        profile="Listener likes jazz and late walks.",
    )
    prompt = build_next_talk_prompt(ctx)
    assert "Listener likes jazz and late walks." in prompt
    # Stable prefix (master §7 pillar 4): the profile block precedes the
    # volatile program transcript.
    assert prompt.index("likes jazz") < prompt.index("You: a")


def test_covered_topics_render_a_dont_repeat_line():
    ctx = ContextPack(
        persona="persona",
        recent=[],
        covered_topics=("night walks", "old films"),
    )
    prompt = build_next_talk_prompt(ctx)
    assert "night walks" in prompt
    assert "old films" in prompt


def test_empty_profile_and_topics_render_nothing_extra():
    plain = build_next_talk_prompt(_ctx([]))
    # No stray headers when both are empty (degrade silently, like the scene cue).
    assert "profile" not in plain.lower()
    assert "don't repeat" not in plain.lower()


def test_next_talks_prompt_also_carries_profile_and_topics():
    ctx = ContextPack(
        persona="persona",
        recent=[],
        profile="Likes jazz.",
        covered_topics=("night walks",),
    )
    prompt = build_next_talks_prompt(ctx, count=2)
    assert "Likes jazz." in prompt
    assert "night walks" in prompt


def test_respond_prompt_carries_the_profile():
    # A direct reply is exactly where cross-session facts should shape the answer.
    ctx = ContextPack(persona="persona", recent=[], profile="Night-shift nurse.")
    prompt = build_respond_prompt("hey", ctx)
    assert "Night-shift nurse." in prompt
    assert 'said to you: "hey"' in prompt


# --- music avoid-list (spec 05 §3.5) -------------------------------------- #


def test_music_situation_carries_avoid_list():
    from murmur.prompts import build_music_situation

    prompt = build_music_situation(["radio: hi"], avoid=["Song A — X", "Song B — Y"])
    assert "Song A — X" in prompt
    assert "Song B — Y" in prompt


def test_music_situation_without_avoid_list_is_unchanged():
    from murmur.prompts import build_music_situation

    assert "avoid" not in build_music_situation(["radio: hi"]).lower()
