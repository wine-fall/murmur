"""Periodic profile compaction, off the live loop (spec 05 §3.6).

The Compactor watches the persistent store's backlog and folds it into the
long-term profile via the Brain seam — as a single-flight background task, so
it never blocks a segment. Failure is inert: the profile and watermark are left
untouched (the store only advances them on a successful apply), one dev-log
line, and the backlog is retried next time. A stub Brain makes the fold a
no-op (its ``compact_profile`` returns the profile unchanged), so an offline
run costs nothing.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

from .contracts import Turn
from .logging_setup import get_log

_log = get_log("memory")


class _CompactStore(Protocol):
    def compaction_due(self) -> bool: ...
    def compaction_slice(self) -> tuple[str, list[Turn], float]: ...
    def apply_compaction(self, new_profile: str, *, through_ts: float) -> None: ...


class _CompactBrain(Protocol):
    async def compact_profile(self, profile: str, transcript: list[Turn]) -> str: ...


class Compactor:
    """Single-flight scheduler around a store's compaction surface."""

    def __init__(self, store: _CompactStore, brain: _CompactBrain) -> None:
        self._store = store
        self._brain = brain
        self._task: asyncio.Task[None] | None = None

    def maybe_schedule(self) -> bool:
        """If the backlog crossed the threshold and nothing is in flight, launch
        one background compaction. Returns whether it launched one."""
        if not self._store.compaction_due():
            return False
        return self._launch()

    async def flush(self) -> None:
        """Force a compaction of any remaining backlog, regardless of the
        threshold (shutdown / startup catch-up). Drains a fold already in flight
        first — its slice predates the current tail — then folds what is left, so
        turns recorded during that in-flight fold are not stranded until a future
        run. Best-effort (the fold swallows its own errors); bounded to two
        rounds (the settled fold + the tail) so a persistently-failing fold can
        never spin here."""
        await self.drain()  # let an in-flight fold (older slice) finish first
        _, turns, _ = self._store.compaction_slice()
        if turns:
            self._launch()
            await self.drain()

    async def drain(self) -> None:
        """Await the in-flight compaction, if any (shutdown / tests)."""
        if self._task is not None:
            await self._task
            self._task = None

    def _launch(self) -> bool:
        if self._task is not None and not self._task.done():
            return False  # single-flight: one fold at a time
        self._task = asyncio.ensure_future(self._run())
        return True

    async def _run(self) -> None:
        profile, turns, through_ts = self._store.compaction_slice()
        if not turns:
            return
        try:
            updated = await self._brain.compact_profile(profile, turns)
        except Exception as exc:  # noqa: BLE001 - never let compaction crash the radio
            _log.warn("compaction failed; keeping profile + watermark", exc=exc)
            return
        self._store.apply_compaction(updated, through_ts=through_ts)
        _log.event("memory.compacted", turns=len(turns), profile_chars=len(updated))
