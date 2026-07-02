"""The brain-harness: murmur-owned tools the brain may call (spec 03-01 §2.1).

The harness is the general seam that turns the isolated `Brain` into a
tool-using agent (master §3.2). A ``BrainTool`` is murmur-owned and in-process;
``Brain.run_task`` runs a bounded loop over a supplied tool set and returns the
result of the **terminal** tool (the one that ends the task). This module holds
only the tool vocabulary — ``run_task`` itself lives on the ``Brain`` (brain.py),
and music is only the first capability to ride the seam (spec 03-01).
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class BrainTool(Protocol):
    """A murmur-owned tool the harnessed brain may call during ``run_task``.

    Exactly one tool per task carries ``terminal=True``: when the model calls it
    with a successful result (``ok == True``), the task ends and that result is
    what ``run_task`` returns (spec 03-01 §2.1 termination rule).
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    terminal: bool

    async def run(self, args: dict[str, Any]) -> dict[str, Any]:
        """Execute the tool. ``args`` are validated against ``input_schema`` by
        the harness before this is called. Returns a JSON-serializable dict
        handed back to the model as the tool result."""
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
    ) -> dict[str, Any] | None:
        """Run the loop until the terminal tool returns ``ok == True`` (that
        result is returned), or ``max_turns`` is hit (returns None). ``tools`` is
        the only tool surface exposed. Content-agnostic: prompt text is already
        rendered (spec 03-01 §2.1/§2.5 termination rule)."""
        ...
