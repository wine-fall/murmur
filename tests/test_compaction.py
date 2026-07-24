"""Compaction (spec 05 §2.4/§3.6): the Brain seam + the Compactor scheduler.

Deterministic scaffolding only (fakes) — the compaction *prompt quality* is an
eval-track concern (spec 05 §6), never a unit assertion on model text.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from murmur.brain import StubBrain
from murmur.compaction import Compactor
from murmur.contracts import Turn
from murmur.memory import PersistentMemoryStore
from murmur.prompts import build_compaction_prompt

T0 = 1_000_000.0


def make_store(tmp_path: Path, *, compact_every: int) -> PersistentMemoryStore:
    return PersistentMemoryStore(
        tmp_path / "memory", now=lambda: T0, compact_every=compact_every
    )


class FakeCompactBrain:
    """Records compact_profile calls; folds by appending a marker line. ``gate``,
    if set, holds the FIRST call at its await point until released — so a test can
    record more turns while a fold is genuinely in flight (its slice captured)."""

    def __init__(self, fail: bool = False, gate: asyncio.Event | None = None) -> None:
        self.calls: list[tuple[str, list[str]]] = []
        self._fail = fail
        self._gate = gate

    async def compact_profile(self, profile: str, transcript: list[Turn]) -> str:
        self.calls.append((profile, [t.text for t in transcript]))
        if self._gate is not None:
            gate, self._gate = self._gate, None  # only the first call waits
            await gate.wait()
        if self._fail:
            raise RuntimeError("brain unavailable")
        return f"{profile}|folded:{len(transcript)}".strip("|")


def test_prompt_mentions_profile_and_transcript() -> None:
    prompt = build_compaction_prompt("old profile", [Turn("user", "I love jazz")])
    assert "old profile" in prompt
    assert "I love jazz" in prompt


def test_stub_brain_compaction_is_noop() -> None:
    out = asyncio.run(StubBrain().compact_profile("keep me", [Turn("user", "x")]))
    assert out == "keep me"


def test_compactor_runs_at_threshold_and_applies(tmp_path: Path) -> None:
    store = make_store(tmp_path, compact_every=2)
    brain = FakeCompactBrain()
    compactor = Compactor(store, brain)

    async def go() -> None:
        store.record(Turn("radio", "a"))
        assert compactor.maybe_schedule() is False  # backlog 1 < 2
        store.record(Turn("radio", "b"))
        assert compactor.maybe_schedule() is True  # crossed threshold
        await compactor.drain()

    asyncio.run(go())
    assert len(brain.calls) == 1
    assert brain.calls[0] == ("", ["a", "b"])
    assert store.profile() == "folded:2"
    assert store.compaction_due() is False


def test_compactor_single_flight(tmp_path: Path) -> None:
    store = make_store(tmp_path, compact_every=1)
    brain = FakeCompactBrain()
    compactor = Compactor(store, brain)

    async def go() -> None:
        store.record(Turn("radio", "a"))
        assert compactor.maybe_schedule() is True
        # A second schedule while one is in flight is a no-op (single-flight).
        assert compactor.maybe_schedule() is False
        await compactor.drain()

    asyncio.run(go())
    assert len(brain.calls) == 1


def test_compactor_failure_leaves_profile_and_watermark(tmp_path: Path) -> None:
    store = make_store(tmp_path, compact_every=1)
    brain = FakeCompactBrain(fail=True)
    compactor = Compactor(store, brain)

    async def go() -> None:
        store.record(Turn("radio", "a"))
        compactor.maybe_schedule()
        await compactor.drain()

    asyncio.run(go())
    assert store.profile() == ""  # untouched
    assert store.compaction_due() is True  # watermark not advanced


def test_compactor_flush_runs_when_due(tmp_path: Path) -> None:
    store = make_store(tmp_path, compact_every=100)
    brain = FakeCompactBrain()
    compactor = Compactor(store, brain)

    async def go() -> None:
        store.record(Turn("radio", "a"))
        # Below threshold, but flush (shutdown / startup catch-up) forces it.
        await compactor.flush()

    asyncio.run(go())
    assert len(brain.calls) == 1
    assert store.profile() == "folded:1"


def test_flush_folds_tail_recorded_during_an_in_flight_compaction(tmp_path: Path) -> None:
    # Regression: flush() while a fold is genuinely in flight (slice already
    # captured, awaiting the brain) must drain it AND then fold the tail recorded
    # meanwhile — not leave it stranded until a future run.
    store = make_store(tmp_path, compact_every=2)

    async def go() -> FakeCompactBrain:
        gate = asyncio.Event()
        brain = FakeCompactBrain(gate=gate)
        compactor = Compactor(store, brain)
        store.record(Turn("radio", "a"))
        store.record(Turn("radio", "b"))
        assert compactor.maybe_schedule() is True
        await asyncio.sleep(0)  # let the fold start + capture its [a, b] slice
        store.record(Turn("user", "c"))  # tail, recorded mid-fold
        gate.set()  # release the in-flight fold
        await compactor.flush()
        return brain

    brain = asyncio.run(go())
    assert len(brain.calls) == 2  # the in-flight [a,b] fold, then the [c] tail
    assert brain.calls[0][1] == ["a", "b"]
    assert brain.calls[1][1] == ["c"]
    assert store.compaction_due() is False  # nothing stranded
