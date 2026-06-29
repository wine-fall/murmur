"""L0 in-process MemoryStore (spec 01 §2.4, §3.1 ``memory``).

A session-only history: an in-memory list bounded to the last N turns. Spec 05
adds the persistent three-tier store (profile / history / ledger) behind the
same ``MemoryStore`` Protocol.
"""

from __future__ import annotations

from collections import deque

from .contracts import Turn


class InProcessMemoryStore:
    """Bounded, in-memory turn log. Satisfies the ``MemoryStore`` Protocol.

    ``maxlen`` caps how much history is retained this session; ``recent(n)``
    returns at most the last ``n`` turns (oldest-first), which the Director
    packs into the ``ContextPack`` for each Brain call.
    """

    def __init__(self, maxlen: int = 256) -> None:
        self._turns: deque[Turn] = deque(maxlen=maxlen)

    def record(self, turn: Turn) -> None:
        self._turns.append(turn)

    def recent(self, n: int) -> list[Turn]:
        if n <= 0:
            return []
        # deque has no negative slicing; take the last n in order.
        size = len(self._turns)
        start = max(0, size - n)
        return [self._turns[i] for i in range(start, size)]
