"""PersistentMemoryStore (spec 05 §3.1–§3.4, §3.6, §3.8).

All tests run on tmp_path with an injected clock — pure file I/O, model-free
(acceptance §5.1/5.2/5.3/5.5-partial/5.6). The Compactor's scheduling is
tested separately; here we pin the store's own surface.
"""

from __future__ import annotations

from pathlib import Path

from murmur.contracts import MemoryStore, Turn
from murmur.memory import _RECENT_MAX_AGE_H, PersistentMemoryStore

T0 = 1_000_000.0  # an arbitrary fixed epoch for injected clocks


def make(tmp_path: Path, *, now: float = T0, compact_every: int = 100) -> PersistentMemoryStore:
    return PersistentMemoryStore(
        tmp_path / "memory", now=lambda: now, compact_every=compact_every
    )


def test_satisfies_extended_protocol(tmp_path: Path) -> None:
    assert isinstance(make(tmp_path), MemoryStore)


def test_round_trip_across_instances(tmp_path: Path) -> None:
    a = make(tmp_path)
    a.record(Turn("radio", "one"))
    a.record(Turn("user", "two"))

    b = make(tmp_path)
    assert [t.text for t in b.recent(10)] == ["one", "two"]
    assert [t.role for t in b.recent(10)] == ["radio", "user"]
    b.record(Turn("radio", "three"))  # merges seamlessly after the primed tail
    assert [t.text for t in b.recent(10)] == ["one", "two", "three"]
    assert [t.text for t in b.recent(2)] == ["two", "three"]


def test_startup_prime_respects_freshness_cutoff(tmp_path: Path) -> None:
    old = make(tmp_path, now=T0)
    old.record(Turn("radio", "stale"))
    later = T0 + (_RECENT_MAX_AGE_H * 3600) + 1
    fresh = make(tmp_path, now=later)
    assert fresh.recent(10) == []  # stale turns are not primed...

    on_disk = (tmp_path / "memory" / "history.jsonl").read_text()
    assert "stale" in on_disk  # ...but never deleted (append-only, no GC)


def test_ledger_queries_across_instances_and_days(tmp_path: Path) -> None:
    a = make(tmp_path, now=T0)
    a.record_event("topic", "night walks")
    a.record_event("song", "Song A — Artist")

    # A cold boot days later still sees them (cross-day anti-repeat, issue #44).
    b = make(tmp_path, now=T0 + 3 * 86_400)
    b.record_event("topic", "coffee")
    assert b.recent_topics(10) == ["night walks", "coffee"]
    assert b.recent_songs(10) == ["Song A — Artist"]
    assert b.recent_topics(1) == ["coffee"]


def test_corrupt_trailing_lines_are_skipped(tmp_path: Path) -> None:
    a = make(tmp_path)
    a.record(Turn("radio", "good"))
    a.record_event("topic", "good-topic")
    (tmp_path / "memory" / "history.jsonl").open("a").write("{torn...")
    (tmp_path / "memory" / "ledger.jsonl").open("a").write("not json\n")

    b = make(tmp_path)  # boots despite the damage
    assert [t.text for t in b.recent(10)] == ["good"]
    assert b.recent_topics(10) == ["good-topic"]


def test_profile_round_trip_and_default(tmp_path: Path) -> None:
    a = make(tmp_path)
    assert a.profile() == ""
    a.apply_compaction("Likes night walks.", through_ts=T0)
    assert a.profile() == "Likes night walks."
    assert make(tmp_path).profile() == "Likes night walks."


def test_compaction_due_at_threshold_and_slice(tmp_path: Path) -> None:
    store = make(tmp_path, compact_every=3)
    assert store.compaction_due() is False
    for i in range(3):
        store.record(Turn("radio", f"t{i}"))
    assert store.compaction_due() is True

    profile, turns, through_ts = store.compaction_slice()
    assert profile == ""
    assert [t.text for t in turns] == ["t0", "t1", "t2"]
    assert through_ts > 0


def test_apply_compaction_advances_watermark_exactly(tmp_path: Path) -> None:
    # The §2.1/§3.6 race, pinned (acceptance §5.5): turns recorded after the
    # slice was taken stay in the next backlog.
    store = make(tmp_path, compact_every=2)
    store.record(Turn("radio", "a"))
    store.record(Turn("radio", "b"))
    _, _, through_ts = store.compaction_slice()
    store.record(Turn("user", "c"))  # lands while the fold is "in flight"

    store.apply_compaction("profile v2", through_ts=through_ts)
    assert store.compaction_due() is False  # backlog of 1 < threshold 2
    _, turns, _ = store.compaction_slice()
    assert [t.text for t in turns] == ["c"]  # c was never marked compacted

    # And the watermark survives a restart.
    reopened = make(tmp_path, compact_every=2)
    _, turns, _ = reopened.compaction_slice()
    assert [t.text for t in turns] == ["c"]
    assert reopened.profile() == "profile v2"


def test_unreadable_meta_means_never_compacted(tmp_path: Path) -> None:
    store = make(tmp_path, compact_every=1)
    store.record(Turn("radio", "a"))
    (tmp_path / "memory" / "meta.json").write_text("garbage")
    reopened = make(tmp_path, compact_every=1)
    assert reopened.compaction_due() is True
