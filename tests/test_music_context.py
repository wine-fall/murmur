"""Unit tests for the context-insertion mechanism (spec 03-01 §2.5).

These pin the *mechanism*, not the context content (which is deferred): the
stable prefix (persona) must land in the cacheable system prompt, and the
volatile part (situation) must land in the per-call turn block — with no
leakage across the boundary (prompt-cache safety).
"""

from __future__ import annotations

from murmur.music.context import MusicContext, render_context


def test_persona_is_the_system_prompt_and_situation_is_the_turn_block() -> None:
    ctx = MusicContext(
        persona="You are a warm late-night radio host.",
        situation="We were just talking about rainy Tokyo nights.",
    )
    system_prompt, situation_block = render_context(ctx)

    # The stable, cacheable prefix is the persona (verbatim).
    assert system_prompt == "You are a warm late-night radio host."
    # The volatile block carries the situation.
    assert "rainy Tokyo nights" in situation_block


def test_cache_prefix_holds_no_volatile_context() -> None:
    # Prompt-cache safety: volatile context must not bleed into the stable
    # prefix (or every call busts the cache), and the persona must not be
    # duplicated into the volatile block.
    ctx = MusicContext(persona="PERSONA_MARKER", situation="VOLATILE_MARKER")
    system_prompt, situation_block = render_context(ctx)

    assert "VOLATILE_MARKER" not in system_prompt
    assert "PERSONA_MARKER" not in situation_block


def test_adding_situation_content_only_changes_the_volatile_block() -> None:
    # The mechanism is content-agnostic: whatever composes `situation`, the
    # split is invariant — persona -> system prompt, situation -> turn block.
    base = MusicContext(persona="P", situation="")
    richer = MusicContext(persona="P", situation="topic=jazz; time=late-night")

    base_system, _ = render_context(base)
    richer_system, richer_block = render_context(richer)

    assert base_system == richer_system == "P"
    assert "jazz" in richer_block and "late-night" in richer_block
