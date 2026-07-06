"""Talk-vs-music scheduling policies (spec 03-02 §2.3).

The Director consults a ``CadencePolicy`` at each segment boundary and never
knows which mode is behind the seam. ``EveryNCadence`` (default) and
``RandomCadence`` are pure local policy — 0 tokens (master §7 pillar 1).
``BrainCadence`` is the opt-in exception: a one-shot cheap-model judgment that
hard-falls-back to a local policy on any failure, timeout, or nonsense answer,
so the radio never stalls on the network.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

from .harness import BrainTool, Harness
from .prompts import CADENCE_INSTRUCTION, CADENCE_STATE_HEADER

TALK = "talk"
MUSIC = "music"

_DEFAULT_EVERY_N = 2
_DEFAULT_TIMEOUT_S = 8.0


@dataclass(frozen=True)
class CadenceState:
    """Local signals a policy may consult; extended as later specs add
    sources (activity/pacing in 07, ledger in 05). ``situation`` is a rendered
    text block (recent turns etc.) that only ``BrainCadence`` reads."""

    talks_since_music: int
    situation: str = ""


@runtime_checkable
class CadencePolicy(Protocol):
    """The scheduling seam the Director consumes (spec 03-02 §2.3): it never
    knows which mode is behind it. Tests inject scripted fakes."""

    async def next_kind(self, state: CadenceState) -> str: ...


class EveryNCadence:
    """Default: a song after every N talk segments. Deterministic, 0 tokens."""

    def __init__(self, n: int = _DEFAULT_EVERY_N) -> None:
        self._n = max(1, n)

    async def next_kind(self, state: CadenceState) -> str:
        return MUSIC if state.talks_since_music >= self._n else TALK


class RandomCadence:
    """Probability ``p`` per boundary, guarded: never before ``min_gap`` talks,
    always by ``max_gap`` (no wall-to-wall music, no endless talk). The RNG is
    injectable so tests are deterministic."""

    def __init__(
        self,
        p: float = 0.35,
        *,
        min_gap: int = 1,
        max_gap: int = 6,
        rng: random.Random | None = None,
    ) -> None:
        self._p = p
        self._min_gap = max(0, min_gap)
        self._max_gap = max(self._min_gap, max_gap)
        self._rng = rng if rng is not None else random.Random()

    async def next_kind(self, state: CadenceState) -> str:
        talks = state.talks_since_music
        if talks < self._min_gap:
            return TALK
        if talks >= self._max_gap:
            return MUSIC
        return MUSIC if self._rng.random() < self._p else TALK


class _ChooseResult(TypedDict):
    ok: Literal[True]
    kind: str


class _ChooseSegmentTool:
    """Terminal tool: the model commits to talk or music (spec 03-01 §2.1
    termination rule — structured output via the terminal tool's schema)."""

    name = "choose_segment"
    description = "Commit to the next segment kind. Call exactly once."
    input_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": [TALK, MUSIC],
                "description": "what plays next",
            }
        },
        "required": ["kind"],
    }
    terminal = True

    async def run(self, args: Mapping[str, object]) -> _ChooseResult:
        raw = args.get("kind")
        return _ChooseResult(ok=True, kind=raw if isinstance(raw, str) else "")


class BrainCadence:
    """Opt-in: ask a cheap model to pace by feel (the sanctioned master §7
    pillar-1 exception). Any failure — exception, timeout, no terminal call,
    invalid kind — falls back to a local policy; the stream never stalls."""

    def __init__(
        self,
        brain: Harness,
        *,
        model: str,
        fallback: EveryNCadence | RandomCadence | None = None,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        self._brain = brain
        self._model = model
        self._fallback = fallback if fallback is not None else EveryNCadence()
        self._timeout_s = timeout_s
        self._tools: list[BrainTool] = [_ChooseSegmentTool()]

    async def next_kind(self, state: CadenceState) -> str:
        prompt = (
            f"{CADENCE_INSTRUCTION}\n"
            f"{CADENCE_STATE_HEADER}"
            f"- talk segments since the last song: {state.talks_since_music}\n"
            f"{state.situation}"
        )
        try:
            result = await asyncio.wait_for(
                self._brain.run_task(
                    "",
                    prompt,
                    tools=self._tools,
                    model=self._model,
                    max_turns=2,
                ),
                self._timeout_s,
            )
        except Exception:
            return await self._fallback.next_kind(state)
        kind = result.get("kind") if result else None
        if kind in (TALK, MUSIC):
            return str(kind)
        return await self._fallback.next_kind(state)


def build_cadence(
    mode: str,
    *,
    every_n: int,
    brain: Harness | None = None,
    model: str = "",
) -> CadencePolicy:
    """Construct the configured cadence mode (spec 03-02 §2.3)."""
    if mode == "every_n":
        return EveryNCadence(every_n)
    if mode == "random":
        return RandomCadence()
    if mode == "brain":
        if brain is None:
            raise ValueError("brain cadence requires a Harness-capable brain")
        return BrainCadence(brain, model=model, fallback=EveryNCadence(every_n))
    raise ValueError(
        f"unknown cadence_mode {mode!r}; expected 'every_n', 'random', or 'brain'"
    )
