"""Harness isolation invariant (spec 03-01 §2.1 / acceptance #1).

The isolation-options test needs no network — it builds the ClaudeAgentOptions
and asserts the invariant. The live end-to-end loop is a tagged smoke that needs
a Claude login (run on demand), and it uses a FAKE provider so no yt-dlp/network
is involved — it verifies only that the real model drives the tools.
"""

from __future__ import annotations

import pytest

from murmur.brain import _build_agentic_options


def _dummy_server():
    from claude_agent_sdk import create_sdk_mcp_server

    return create_sdk_mcp_server(name="murmur", tools=[])


def test_tool_results_are_wrapped_in_mcp_content_shape():
    # Regression: the SDK drops a tool result that lacks a `content` list and
    # feeds the model an EMPTY result. run_task must wrap every tool result.
    import json

    from murmur.brain import _to_mcp_result

    wrapped = _to_mcp_result({"ok": True, "source": "stream:x", "kind": "music"})
    block = wrapped["content"][0]
    assert block["type"] == "text"
    assert json.loads(block["text"]) == {
        "ok": True,
        "source": "stream:x",
        "kind": "music",
    }


def test_agentic_options_are_isolated_with_a_tool_allowlist():
    names = ["mcp__murmur__search_music", "mcp__murmur__submit_pick"]
    opts = _build_agentic_options(
        "PERSONA", "claude-haiku-4-5-20251001", names, _dummy_server(), max_turns=6
    )
    # No user environment leaks in (spec 01 §3.2 isolation must not regress).
    assert opts.setting_sources == []
    assert opts.skills == []
    assert opts.extra_args == {"disable-slash-commands": None}
    # strict_mcp_config: ignore inherited/discovered MCP (verified live — without
    # it the enclosing environment's MCP servers leak into the subprocess).
    assert opts.strict_mcp_config is True
    # tools=[]: no built-in tools (Read/Write/Bash/...); only murmur's mcp tools.
    assert opts.tools == []
    # Tools are ALLOWED now — but the allowlist is EXACTLY murmur's own, nothing else.
    assert opts.allowed_tools == names
    assert isinstance(opts.mcp_servers, dict)
    assert set(opts.mcp_servers) == {"murmur"}
    # Task model + persona prefix carried through.
    assert opts.model == "claude-haiku-4-5-20251001"
    assert opts.system_prompt == "PERSONA"


@pytest.mark.integration
def test_claude_run_task_finds_a_track_end_to_end():
    """Live smoke (needs a Claude login): the harnessed model calls search_music
    then submit_pick over a FAKE provider (no yt-dlp), and we capture a clip."""
    import asyncio

    from fakes import FakeMusicProvider

    from murmur.brain import ClaudeBrain
    from murmur.contracts import TrackCandidate
    from murmur.music.context import MusicContext
    from murmur.music.programmer import MusicProgrammer

    model = "claude-haiku-4-5-20251001"
    provider = FakeMusicProvider(
        candidates=[
            TrackCandidate(
                ref="r1", title="Clair de Lune", uploader="DG", duration_s=300
            )
        ],
        resolvable={"r1"},
    )
    prog = MusicProgrammer(brain=ClaudeBrain(model), provider=provider, model=model)

    async def go():
        clip = await prog.next_track(
            MusicContext(
                persona="You are a calm classical-music radio host.",
                situation="A quiet evening; the listener likes solo piano.",
            )
        )
        assert clip is not None and clip.kind == "music"
        assert clip.source == "stream:r1"
        assert provider.searched  # the model actually searched
        assert "r1" in provider.resolved  # and submitted a pick that resolved

    asyncio.run(go())
