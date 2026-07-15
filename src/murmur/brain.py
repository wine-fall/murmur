"""Brain contract + implementations (spec 01 §3.2).

The Brain produces talk-segment text and user responses from a ``ContextPack``.
Two implementations live here behind one two-method ``Brain`` Protocol:

- ``StubBrain``  — canned, dependency-free text. The fake for the fast test
  layer (DESIGN §11.1) and the step-1 loop. No network.
- ``ClaudeBrain`` — the real Brain on ``claude-agent-sdk`` (master §3.2):
  subscription-OAuth inherited from the local Claude Code login (no API key),
  model ``claude-opus-4-8``. Stateless — persona is the System Prompt and
  ``ctx.recent`` is re-sent as context on every call (§3.2, master §6).

All prompt text is centralized under ``murmur.prompts`` (DESIGN §0); this module
holds only Brain mechanics. ``build_brain`` selects by ``Config.brain_provider``
so the core never imports a concrete Brain directly.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from itertools import cycle
from typing import TYPE_CHECKING, Any, Protocol, cast, runtime_checkable

from .contracts import ContextPack
from .logging_setup import get_log
from .prompts import (
    build_next_talk_prompt,
    build_next_talks_prompt,
    build_respond_prompt,
)
from .talk_tools import EmitTalkBeatsTool, parse_talk_beats

if TYPE_CHECKING:
    from claude_agent_sdk import (
        CanUseTool,
        ClaudeAgentOptions,
        McpSdkServerConfig,
        PermissionMode,
    )

    from .harness import BrainTool

# Diagnostics stream to the dev logfile only when MURMUR_DEV_LOG is set (make
# dev / logging_setup). No handler otherwise, so these calls are ~free and the
# interactive UI is never touched. The harness firehose (every SDK message repr)
# is DEBUG — hidden from the default `make logs` view, on tap via --level DEBUG.
_log = get_log("harness")


@runtime_checkable
class Brain(Protocol):
    async def next_talk(self, ctx: ContextPack) -> str:
        """Generate the next short, self-contained talk-segment script: pick or
        continue a topic and chat, per the persona. Self-initiated — not a
        reply."""
        ...

    async def next_talks(self, ctx: ContextPack, count: int = 2) -> list[str]:
        """Generate the next ``count`` consecutive talk-segment scripts in one
        call — the look-ahead batch (spec 04 §3.2). A superset of ``next_talk``
        (``count=1``). May return fewer than ``count`` if the model's batch
        degrades; the caller airs what it gets."""
        ...

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        """Respond in-persona to a typed user line; then the program resumes."""
        ...


# --------------------------------------------------------------------------- #
# StubBrain — the fake (no SDK, no network)
# --------------------------------------------------------------------------- #

# Canned English fake output so the loop looks realistic with no network. The
# stub's language is irrelevant to the product: the real radio speaks Chinese
# only at runtime, produced by the model from the persona prompt — never from a
# hardcoded string. v1 sources contain no Chinese (DESIGN §0).
_STUB_SEGMENTS = (
    "It's late, and it's just you and me on the air tonight. Let's talk about nothing in particular.",
    "A thought drifted past just now -- the older we get, the more we swallow the things we meant to say.",
    "I'm half in the mood to drop a song here, but music's still a little ways off. Voice will keep you company for now.",
    "Nothing's stirring outside. This kind of quiet is actually nice -- like the world set you down gently.",
    "I keep thinking company is really just this: a voice that stays, that doesn't rush you or ask anything of you.",
)


class StubBrain:
    """Deterministic, dependency-free Brain. Satisfies the ``Brain`` Protocol.

    The fake for the fast test layer and the step-1 loop — proves the seam with
    no ``claude-agent-sdk`` and no network.
    """

    def __init__(self) -> None:
        self._segments: "cycle[str]" = cycle(_STUB_SEGMENTS)

    async def next_talk(self, ctx: ContextPack) -> str:
        return next(self._segments)

    async def next_talks(self, ctx: ContextPack, count: int = 2) -> list[str]:
        return [next(self._segments) for _ in range(count)]

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        return f'Mm -- you said "{user_text}". I heard you. Let\'s follow that thread a little.'


# --------------------------------------------------------------------------- #
# ClaudeBrain — the real Brain on claude-agent-sdk
# --------------------------------------------------------------------------- #


class ClaudeBrain:
    """Real Brain via ``claude-agent-sdk`` one-shot ``query`` (stateless).

    Each call builds fresh ``ClaudeAgentOptions`` with the persona as the
    System Prompt and re-sends the compact transcript (master §6). No tools
    (``allowed_tools=[]``) and no filesystem settings (``setting_sources=[]``)
    — this is pure persona-driven text generation, not a coding agent, so the
    user's CLAUDE.md / project config never leaks into the radio's voice.
    """

    def __init__(self, model: str) -> None:
        self._model: str = model

    async def next_talk(self, ctx: ContextPack) -> str:
        return await self._generate(ctx.persona, build_next_talk_prompt(ctx))

    async def next_talks(self, ctx: ContextPack, count: int = 2) -> list[str]:
        # Structured output via the harness tool seam (spec 04 §3.2): the model
        # returns its beats by calling emit_talk_beats, so the SDK hands them back
        # as a parsed mapping — no free-text JSON to scrape. An empty result (the
        # model never called the tool) degrades to a skipped segment upstream.
        result = await self.run_task(
            ctx.persona,
            build_next_talks_prompt(ctx, count),
            tools=[EmitTalkBeatsTool(count)],
            model=self._model,
            max_turns=2,
        )
        beats = parse_talk_beats(result)
        # Empty means the model never made the terminal call (or emitted no usable
        # beat). Fall back to a single plain-text beat rather than skip the segment
        # into dead air — the look-ahead is lost this round, the segment is not.
        return beats or [await self.next_talk(ctx)]

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        return await self._generate(ctx.persona, build_respond_prompt(user_text, ctx))

    async def _generate(self, persona: str, prompt: str) -> str:
        # Imported lazily so the stdlib-only stub path (tests) never imports the
        # SDK, and an install issue surfaces only when the real Brain is used.
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            TextBlock,
            query,
        )

        # Full isolation from the user's local Claude Code environment: the radio
        # must not be influenced by their CLAUDE.md, plugins/skills, MCP servers,
        # hooks, or subagents. The combination below was verified against the SDK
        # init payload (no user config, no tools, no skills, no MCP; subscription
        # OAuth preserved). Built-in agent *types* still appear in metadata but are
        # inert -- with no tools there is no Task tool to launch them.
        options = ClaudeAgentOptions(
            system_prompt=persona,  # custom prompt replaces the claude_code preset
            model=self._model,
            setting_sources=[],  # ignore user/project/local settings (CLAUDE.md, hooks, MCP, plugins)
            allowed_tools=[],  # no tool may be invoked
            tools=[],  # load zero tools (also trims context)
            skills=[],  # no skills
            mcp_servers={},  # no MCP servers
            max_turns=1,  # a single assistant turn, no tool loops
            extra_args={
                "disable-slash-commands": None
            },  # also disables built-in skills/commands
        )

        parts: list[str] = []
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text:
                        parts.append(block.text)

        text = "".join(parts).strip()
        if not text:
            raise RuntimeError(
                "ClaudeBrain produced no text (check Claude Code login / network)"
            )
        return text

    async def run_task(
        self,
        system_prompt: str,
        prompt: str,
        *,
        tools: list[BrainTool],
        model: str,
        max_turns: int,
    ) -> Mapping[str, object] | None:
        """Harness capability (spec 03-01 §2.1): run a bounded, isolated tool-use
        loop over murmur's OWN in-process tools, returning the terminal tool's
        successful result (or None if ``max_turns`` is hit with no success).

        Isolation (spec 01 §3.2) holds — but tools are now *allowed*: the
        allowlist is exactly murmur's own mcp tools, nothing else. No user
        CLAUDE.md / settings / skills / commands leak in; subscription OAuth is
        preserved. The loop stops as soon as the terminal tool succeeds.
        """
        from claude_agent_sdk import (  # lazy: keep the stub/test path SDK-free
            create_sdk_mcp_server,
            query,
            tool,
        )

        captured: Mapping[str, object] | None = None

        def wrap(bt: BrainTool):
            async def handler(args: dict[str, Any]) -> dict[str, Any]:
                nonlocal captured
                out = await bt.run(args)
                if bt.terminal and out.get("ok"):
                    captured = out
                # The SDK requires the MCP tool-result shape; a bare dict would
                # be fed to the model as an EMPTY result.
                return _to_mcp_result(out)

            return tool(bt.name, bt.description, bt.input_schema)(handler)

        server = create_sdk_mcp_server(name="murmur", tools=[wrap(t) for t in tools])
        tool_names = [f"mcp__murmur__{t.name}" for t in tools]
        options = _build_agentic_options(
            system_prompt, model, tool_names, server, max_turns
        )

        # Close the query generator on break so the CLI subprocess is torn down
        # deterministically (not only at eventual GC / loop shutdown).
        gen = query(prompt=prompt, options=options)
        try:
            async for _message in gen:
                if _log.debug_enabled:
                    _log.debug(f"task {type(_message).__name__}: {repr(_message)[:800]}")
                if captured is not None:
                    break
        finally:
            aclose = getattr(gen, "aclose", None)
            if aclose is not None:
                await aclose()
        return captured

    async def run_guide(
        self,
        system_prompt: str,
        prompt: str,
        *,
        model: str,
        max_turns: int,
        permission_mode: str = "default",
        can_use_tool: CanUseTool | None = None,
        on_text: Callable[[str], None] | None = None,
        next_user_input: Callable[[], Awaitable[str | None]] | None = None,
    ) -> str:
        """Harness the native Claude Code agent for an interactive setup/repair
        task: diagnose why something in the user's environment is broken and,
        with the user's consent, fix it — using Claude Code's **built-in** tools
        (Bash/Read/Write/…). Same isolation as run_task (no user CLAUDE.md /
        MCP), but real system tools are ENABLED — the bounded surface a repair
        task needs. Returns the final assistant text (plain-language explanation).

        Multi-turn: uses ``ClaudeSDKClient`` so the conversation stays open — the
        agent's text streams via ``on_text``; after each of its turns we pull the
        user's next natural-language reply via ``next_user_input`` and send it,
        until the user ends it (reply is None). ``can_use_tool`` still gates each
        concrete action (``permission_mode="default"``); we never
        ``bypassPermissions`` in a shipped build.
        """
        from claude_agent_sdk import (  # lazy: keep the stub/test path SDK-free
            AssistantMessage,
            ClaudeSDKClient,
            TextBlock,
        )

        options = _build_guide_options(
            system_prompt, model, max_turns, permission_mode, can_use_tool
        )
        parts: list[str] = []
        async with ClaudeSDKClient(options=options) as client:
            await client.query(prompt)
            while True:
                async for message in client.receive_response():
                    if _log.debug_enabled:
                        _log.debug(f"guide {type(message).__name__}: {repr(message)[:800]}")
                    if isinstance(message, AssistantMessage):
                        for block in message.content:
                            if isinstance(block, TextBlock) and block.text:
                                parts.append(block.text)
                                if on_text is not None:
                                    on_text(block.text)  # stream out as it arrives
                # The agent's turn ended. Pull the user's next reply (natural
                # language) and continue, or stop if there is no more input.
                if next_user_input is None:
                    break
                reply = await next_user_input()
                if reply is None:
                    break
                await client.query(reply)
        return "\n".join(parts).strip()


def _to_mcp_result(out: Mapping[str, object]) -> dict[str, Any]:
    """Wrap a ``BrainTool`` result in the MCP tool-result shape the SDK requires.

    The SDK's in-process tool handler only forwards a result that carries a
    ``content`` list; a bare dict is delivered to the model as an EMPTY result.
    So every tool's JSON result is serialized into a single text content block
    (spec 03-01 §2.3). The raw dict is captured separately for the terminal tool.
    """
    return {"content": [{"type": "text", "text": json.dumps(out)}]}


def _build_agentic_options(
    system_prompt: str,
    model: str,
    tool_names: list[str],
    server: McpSdkServerConfig,
    max_turns: int,
) -> ClaudeAgentOptions:
    """Build the isolated ``ClaudeAgentOptions`` for an agentic task (spec 03-01
    §2.1). Factored out so the isolation invariant is unit-testable without any
    network call. Isolation mirrors spec 01 §3.2 — except tools are ALLOWED, and
    the allowlist is exactly ``tool_names`` (murmur's own mcp tools), nothing else.
    """
    from claude_agent_sdk import ClaudeAgentOptions

    return ClaudeAgentOptions(
        system_prompt=system_prompt,
        model=model,
        setting_sources=[],  # ignore user CLAUDE.md / project / local settings
        strict_mcp_config=True,  # ONLY murmur's server; ignore inherited/discovered MCP
        tools=[],  # no built-in tools (Read/Write/Bash/...); only the mcp tools below
        allowed_tools=tool_names,  # allowlist: ONLY murmur's own mcp tools
        mcp_servers={"murmur": server},
        skills=[],  # no skills
        max_turns=max_turns,
        extra_args={"disable-slash-commands": None},  # no built-in slash commands
    )


# Built-in Claude Code tools the guide harness may use to diagnose + repair the
# environment. A curated set (no network fetch tools) — the bounded surface a
# setup/repair task needs, in contrast to the tool-less find-music task.
_GUIDE_BUILTINS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]


def _build_guide_options(
    system_prompt: str,
    model: str,
    max_turns: int,
    permission_mode: str,
    can_use_tool: CanUseTool | None = None,
) -> ClaudeAgentOptions:
    """Options for the guide harness (spec 03-03). Same isolation as
    the find-music task (setting_sources=[], strict_mcp_config=True, no user
    skills/MCP), but built-in system tools are ENABLED and allowlisted — the
    bounded surface a repair task legitimately needs. ``can_use_tool`` is the
    permission callback that routes each pre-action ask to the user."""
    from claude_agent_sdk import ClaudeAgentOptions

    return ClaudeAgentOptions(
        system_prompt=system_prompt,
        model=model,
        setting_sources=[],  # ignore user CLAUDE.md / project / local settings
        strict_mcp_config=True,  # ignore inherited/discovered MCP
        allowed_tools=list(_GUIDE_BUILTINS),  # curated built-ins; nothing else
        permission_mode=cast("PermissionMode", permission_mode),
        can_use_tool=can_use_tool,
        max_turns=max_turns,
        extra_args={"disable-slash-commands": None},
    )


# --------------------------------------------------------------------------- #
# Factory
# --------------------------------------------------------------------------- #


def build_brain(name: str, *, model: str) -> Brain:
    """Construct the configured Brain. ``"stub"`` (fake) or ``"claude"`` (real)."""
    if name == "stub":
        return StubBrain()
    if name == "claude":
        return ClaudeBrain(model)
    raise ValueError(f"unknown brain_provider {name!r}; expected 'stub' or 'claude'")
