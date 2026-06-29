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

# Canned segments mimic the Chinese-speaking radio so the loop looks realistic.
# This is fake Brain *output* (string literals), not prompt text.
_STUB_SEGMENTS = (
    "夜深了,空气里只剩我和你。今天就先随便聊聊吧。",
    "刚才路过一个念头——人是不是越长大,越习惯把话咽回去。",
    "放首歌的心情都有了,可惜音乐还得再等等。先用声音陪你。",
    "窗外没什么动静,这种安静其实挺好的,像被世界轻轻放下。",
    "我在想,所谓陪伴,大概就是有个声音一直在,不催你、不问你。",
)


class StubBrain:
    """Deterministic, dependency-free Brain. Satisfies the ``Brain`` Protocol.

    The fake for the fast test layer and the step-1 loop — proves the seam with
    no ``claude-agent-sdk`` and no network.
    """

    def __init__(self) -> None:
        self._segments = cycle(_STUB_SEGMENTS)

    async def next_talk(self, ctx: ContextPack) -> str:
        return next(self._segments)

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        return f"嗯,你说「{user_text}」——我听到了。我们顺着这个再聊聊。"


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
        self._model = model

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

        options = ClaudeAgentOptions(
            system_prompt=persona,
            model=self._model,
            allowed_tools=[],       # pure text generation; no agentic tools
            setting_sources=[],     # do not inherit CLAUDE.md / project settings
            max_turns=1,            # a single assistant turn, no tool loops
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
