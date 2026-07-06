"""The brain-harness: murmur-owned tools the brain may call (spec 03-01 §2.1).

The harness is the general seam that turns the isolated `Brain` into a
tool-using agent (master §3.2). A ``BrainTool`` is murmur-owned and in-process;
``Brain.run_task`` runs a bounded loop over a supplied tool set and returns the
result of the **terminal** tool (the one that ends the task). This module holds
only the tool vocabulary — ``run_task`` itself lives on the ``Brain`` (brain.py),
and music is only the first capability to ride the seam (spec 03-01).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:
    from claude_agent_sdk import CanUseTool


@runtime_checkable
class BrainTool(Protocol):
    """A murmur-owned tool the harnessed brain may call during ``run_task``.

    Exactly one tool per task carries ``terminal=True``: when the model calls it
    with a successful result (``ok == True``), the task ends and that result is
    what ``run_task`` returns (spec 03-01 §2.1 termination rule).
    """

    name: str
    description: str
    input_schema: dict[str, Any]  # a JSON Schema document — genuinely open JSON
    terminal: bool

    async def run(self, args: Mapping[str, object]) -> Mapping[str, object]:
        """Execute the tool. ``args`` is the model's tool call — untrusted JSON;
        a tool narrows/validates it rather than assuming a shape. Returns a
        JSON-serializable mapping handed back to the model as the tool result
        (concrete tools return a ``TypedDict``; the seam stays shape-agnostic)."""
        ...


@runtime_checkable
class Harness(Protocol):
    """The agentic capability (spec 03-01 §2.1): run a bounded tool-use loop.

    A distinct Protocol from the tool-less ``Brain`` (brain.py) — the real
    ``ClaudeBrain`` implements both, while talk-only brains (stub / fakes) need
    not. Consumers (e.g. ``MusicProgrammer``) depend on this capability alone.
    """

    async def run_task(
        self,
        system_prompt: str,
        prompt: str,
        *,
        tools: list[BrainTool],
        model: str,
        max_turns: int,
    ) -> Mapping[str, object] | None:
        """Run the loop until the terminal tool returns ``ok == True`` (that
        result is returned), or ``max_turns`` is hit (returns None). ``tools`` is
        the only tool surface exposed. Content-agnostic: prompt text is already
        rendered (spec 03-01 §2.1/§2.5 termination rule)."""
        ...


@runtime_checkable
class GuideCapable(Protocol):
    """The setup/repair capability: harness the native Claude Code agent with
    its built-in tools (Bash/Read/Write/…) to diagnose and fix the user's
    environment. Distinct from ``Harness`` (find-music has no built-in tools) —
    the real ``ClaudeBrain`` implements both; each consumer depends on the one
    it needs (interface segregation)."""

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
        """Run a multi-turn diagnose-and-fix conversation and return the final
        plain-language explanation. Built-in system tools are enabled (the
        bounded surface a repair task needs); ``permission_mode="default"`` keeps
        the SDK's step-by-step confirmation on. ``can_use_tool`` gates each
        action; ``on_text`` streams the agent's text; ``next_user_input`` supplies
        the user's natural-language reply after each agent turn (None ends it)."""
        ...
