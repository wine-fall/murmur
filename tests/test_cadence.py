"""CadencePolicy seam + the three switchable modes (spec 03-02 §2.3).

Acceptance #7: every_n is a deterministic sequence; random respects its
guardrails under a seeded RNG; brain returns the model's choice and
hard-falls-back to the local policy on any failure/timeout. All fakes —
no model, no network.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

from murmur.cadence import (
    BrainCadence,
    CadenceState,
    EveryNCadence,
    RandomCadence,
)


def _kind(policy: Any, talks: int, situation: str = "") -> str:
    return asyncio.run(
        policy.next_kind(CadenceState(talks_since_music=talks, situation=situation))
    )


def test_every_n_is_a_deterministic_sequence():
    policy = EveryNCadence(n=2)
    assert _kind(policy, 0) == "talk"
    assert _kind(policy, 1) == "talk"
    assert _kind(policy, 2) == "music"
    assert _kind(policy, 5) == "music"


def test_random_respects_min_and_max_gap_guardrails():
    # p=1.0: music as soon as min_gap allows — never before.
    eager = RandomCadence(p=1.0, min_gap=2, max_gap=6, rng=random.Random(7))
    assert _kind(eager, 0) == "talk"
    assert _kind(eager, 1) == "talk"
    assert _kind(eager, 2) == "music"
    # p=0.0: never by roll, but max_gap forces music eventually.
    reluctant = RandomCadence(p=0.0, min_gap=1, max_gap=4, rng=random.Random(7))
    assert _kind(reluctant, 3) == "talk"
    assert _kind(reluctant, 4) == "music"


def test_random_is_reproducible_with_a_seeded_rng():
    a = RandomCadence(p=0.5, min_gap=1, max_gap=10, rng=random.Random(42))
    b = RandomCadence(p=0.5, min_gap=1, max_gap=10, rng=random.Random(42))
    seq_a = [_kind(a, 3) for _ in range(20)]
    seq_b = [_kind(b, 3) for _ in range(20)]
    assert seq_a == seq_b
    assert "music" in seq_a and "talk" in seq_a  # p=0.5 actually rolls


class _ScriptedHarness:
    """run_task stand-in: calls the terminal tool per the script."""

    def __init__(
        self, kind: str | None = None, raise_exc: bool = False, delay_s: float = 0.0
    ) -> None:
        self._kind = kind
        self._raise = raise_exc
        self._delay = delay_s
        self.calls: list[dict[str, Any]] = []

    async def run_task(
        self,
        system_prompt: str,
        prompt: str,
        *,
        tools: list[Any],
        model: str,
        max_turns: int,
    ) -> dict[str, Any] | None:
        self.calls.append({"prompt": prompt, "model": model, "tools": tools})
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raise:
            raise RuntimeError("model unavailable")
        if self._kind is None:
            return None
        terminal = next(t for t in tools if t.terminal)
        return await terminal.run({"kind": self._kind})


def test_brain_cadence_returns_the_models_choice():
    harness = _ScriptedHarness(kind="music")
    policy = BrainCadence(harness, model="haiku-x")
    assert _kind(policy, 0, situation="rainy evening") == "music"
    call = harness.calls[-1]
    assert "rainy evening" in call["prompt"]
    assert call["model"] == "haiku-x"


def test_brain_cadence_falls_back_to_local_policy_on_error():
    fallback = EveryNCadence(n=2)
    policy = BrainCadence(
        _ScriptedHarness(raise_exc=True), model="m", fallback=fallback
    )
    assert _kind(policy, 2) == "music"  # every_n's answer, not a crash
    assert _kind(policy, 0) == "talk"


def test_brain_cadence_falls_back_on_none_and_invalid_kind():
    fallback = EveryNCadence(n=1)
    none_policy = BrainCadence(
        _ScriptedHarness(kind=None), model="m", fallback=fallback
    )
    assert _kind(none_policy, 1) == "music"
    bad_policy = BrainCadence(
        _ScriptedHarness(kind="jazz-hands"), model="m", fallback=fallback
    )
    assert _kind(bad_policy, 0) == "talk"


def test_brain_cadence_falls_back_on_timeout():
    fallback = EveryNCadence(n=1)
    policy = BrainCadence(
        _ScriptedHarness(kind="music", delay_s=0.2),
        model="m",
        fallback=fallback,
        timeout_s=0.01,
    )
    assert _kind(policy, 0) == "talk"  # fallback's answer, within the timeout


def test_build_cadence_maps_modes_and_rejects_unknown():
    import pytest

    from murmur.cadence import build_cadence

    assert isinstance(build_cadence("every_n", every_n=3), EveryNCadence)
    assert isinstance(build_cadence("random", every_n=3), RandomCadence)
    brain = _ScriptedHarness(kind="music")
    assert isinstance(
        build_cadence("brain", every_n=3, brain=brain, model="m"), BrainCadence
    )
    with pytest.raises(ValueError):
        build_cadence("brain", every_n=3)  # brain mode needs a brain
    with pytest.raises(ValueError):
        build_cadence("vibes", every_n=3)
