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

from itertools import cycle
from typing import Protocol, runtime_checkable

from .contracts import ContextPack
from .prompts import build_next_talk_prompt, build_respond_prompt


@runtime_checkable
class Brain(Protocol):
    async def next_talk(self, ctx: ContextPack) -> str:
        """Generate the next short, self-contained talk-segment script: pick or
        continue a topic and chat, per the persona. Self-initiated — not a
        reply."""
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
