"""In-process MemoryStore (spec 01 §2.4; spec 05 §2.1 extensions).

A session-only store: an in-memory turn log bounded to the last N turns, plus
in-memory tier-①/③ equivalents (profile, ledger) so it satisfies the extended
Protocol. It is the unit-layer fake (DESIGN §11.1) and the store for stub runs
(spec 05 §3.7 — canned chatter never touches the real memory dir). The
persistent three-tier store lives beside it in this module.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from collections import deque
from collections.abc import Callable
from pathlib import Path

from .contracts import Turn
from .logging_setup import get_log

_log = get_log("memory")

# Startup-prime freshness cutoff (spec 05 §3.4): only turns younger than this
# join the recent window on boot. Older continuity flows through the profile.
# By-feel tunable (spec 05 §6).
_RECENT_MAX_AGE_H = 48

# In-memory ledger tail kept per kind — bounds boot memory, far above any
# realistic recent_topics/recent_songs(n).
_LEDGER_TAIL = 256


def _tail(items: list[str], n: int) -> list[str]:
    return items[-n:] if n > 0 else []


class InProcessMemoryStore:
    """Bounded, in-memory turn log. Satisfies the ``MemoryStore`` Protocol.

    ``maxlen`` caps how much history is retained this session; ``recent(n)``
    returns at most the last ``n`` turns (oldest-first), which the Director
    packs into the ``ContextPack`` for each Brain call.
    """

    def __init__(self, maxlen: int = 256) -> None:
        self._turns: deque[Turn] = deque(maxlen=maxlen)
        self._profile = ""
        self._topics: list[str] = []
        self._songs: list[str] = []

    def record(self, turn: Turn) -> None:
        self._turns.append(turn)

    def recent(self, n: int) -> list[Turn]:
        if n <= 0:
            return []
        # deque has no negative slicing; take the last n in order.
        size = len(self._turns)
        start = max(0, size - n)
        return [self._turns[i] for i in range(start, size)]

    def profile(self) -> str:
        return self._profile

    def record_event(self, kind: str, key: str) -> None:
        if kind == "topic":
            self._topics.append(key)
        elif kind == "song":
            self._songs.append(key)

    def recent_topics(self, n: int) -> list[str]:
        return _tail(self._topics, n)

    def recent_songs(self, n: int) -> list[str]:
        return _tail(self._songs, n)


def _atomic_write(path: Path, text: str) -> None:
    """Temp file + rename in the same directory — a reader never sees a torn
    profile/meta (spec 05 §3.1 write discipline)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    """Parse a JSONL file, skipping undecodable lines (the torn-tail crash case,
    spec 05 §3.8) — a damaged memory degrades, it never prevents boot."""
    if not path.exists():
        return []
    rows: list[dict[str, object]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            _log.warn(f"skipping corrupt line in {path.name}")
            continue
        if isinstance(parsed, dict):
            rows.append(parsed)  # pyright: ignore[reportUnknownArgumentType]
    return rows


class PersistentMemoryStore:
    """File-backed three-tier store under ``memory_dir`` (spec 05 §3.1):
    append-only ``history.jsonl`` / ``ledger.jsonl``, atomic ``profile.md`` /
    ``meta.json`` (the compaction watermark). Satisfies the extended
    ``MemoryStore`` Protocol; the compaction surface (§3.6) is impl-level.

    ``now`` is injectable so freshness/watermark behavior is testable without
    the wall clock. Row timestamps are made strictly increasing (``max(now,
    last + 1e-6)``) so the ``through_ts`` watermark always separates a
    compaction slice from turns recorded while the fold was in flight.
    """

    def __init__(
        self,
        memory_dir: Path,
        *,
        maxlen: int = 256,
        now: Callable[[], float] = time.time,
        compact_every: int = 100,
    ) -> None:
        self._dir = memory_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self._history = self._dir / "history.jsonl"
        self._ledger = self._dir / "ledger.jsonl"
        self._profile_path = self._dir / "profile.md"
        self._meta = self._dir / "meta.json"
        self._now = now
        self._compact_every = compact_every
        self._session = uuid.uuid4().hex[:8]
        self._last_ts = 0.0

        self._turns: deque[Turn] = deque(maxlen=maxlen)
        self._topics: list[str] = []
        self._songs: list[str] = []
        self._profile = ""
        self._watermark = 0.0
        # (ts, Turn) recorded past the watermark — the next compaction slice.
        self._backlog: list[tuple[float, Turn]] = []

        self._load()

    # --- MemoryStore Protocol ------------------------------------------------ #

    def record(self, turn: Turn) -> None:
        ts = self._stamp()
        self._append(
            self._history,
            {"ts": ts, "session": self._session, "role": turn.role, "text": turn.text},
        )
        self._turns.append(turn)
        self._backlog.append((ts, turn))

    def recent(self, n: int) -> list[Turn]:
        if n <= 0:
            return []
        size = len(self._turns)
        return [self._turns[i] for i in range(max(0, size - n), size)]

    def profile(self) -> str:
        return self._profile

    def record_event(self, kind: str, key: str) -> None:
        self._append(
            self._ledger,
            {"ts": self._stamp(), "session": self._session, "kind": kind, "key": key},
        )
        self._remember_event(kind, key)

    def recent_topics(self, n: int) -> list[str]:
        return _tail(self._topics, n)

    def recent_songs(self, n: int) -> list[str]:
        return _tail(self._songs, n)

    # --- compaction surface (spec 05 §3.6 — driven by the Compactor) --------- #

    def compaction_due(self) -> bool:
        return len(self._backlog) >= self._compact_every

    def compaction_slice(self) -> tuple[str, list[Turn], float]:
        """Current profile + the un-compacted turns + ``through_ts`` (the
        slice's last row timestamp). The watermark travels with the slice: the
        fold races ``record()``, so apply advances exactly to ``through_ts``."""
        turns = [t for _, t in self._backlog]
        through_ts = self._backlog[-1][0] if self._backlog else self._watermark
        return self._profile, turns, through_ts

    def apply_compaction(self, new_profile: str, *, through_ts: float) -> None:
        _atomic_write(self._profile_path, new_profile)
        _atomic_write(self._meta, json.dumps({"compacted_through": through_ts}))
        self._profile = new_profile
        self._watermark = through_ts
        self._backlog = [(ts, t) for ts, t in self._backlog if ts > through_ts]

    # --- internals ------------------------------------------------------------ #

    def _stamp(self) -> float:
        self._last_ts = max(self._now(), self._last_ts + 1e-6)
        return self._last_ts

    def _append(self, path: Path, row: dict[str, object]) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def _remember_event(self, kind: str, key: str) -> None:
        target = self._topics if kind == "topic" else self._songs if kind == "song" else None
        if target is not None:
            target.append(key)
            del target[:-_LEDGER_TAIL]

    def _load(self) -> None:
        if self._profile_path.exists():
            self._profile = self._profile_path.read_text(encoding="utf-8")

        meta = _read_jsonl(self._meta)  # single-object file; [] when unreadable
        if meta:
            raw = meta[0].get("compacted_through")
            self._watermark = float(raw) if isinstance(raw, (int, float)) else 0.0
        if self._watermark == 0.0 and self._meta.exists() and not meta:
            _log.warn("meta.json unreadable; treating as never compacted")

        cutoff = self._now() - _RECENT_MAX_AGE_H * 3600
        for row in _read_jsonl(self._history):
            ts, role, text = row.get("ts"), row.get("role"), row.get("text")
            if not (isinstance(ts, (int, float)) and isinstance(role, str) and isinstance(text, str)):
                _log.warn("skipping malformed history row")
                continue
            self._last_ts = max(self._last_ts, float(ts))
            turn = Turn(role, text)
            if ts >= cutoff:
                self._turns.append(turn)
            if ts > self._watermark:
                self._backlog.append((float(ts), turn))

        for row in _read_jsonl(self._ledger):
            kind, key = row.get("kind"), row.get("key")
            if isinstance(kind, str) and isinstance(key, str):
                self._remember_event(kind, key)
