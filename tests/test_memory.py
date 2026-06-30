"""InProcessMemoryStore tests (spec 01 §2.4)."""

from __future__ import annotations

from murmur.contracts import Turn
from murmur.memory import InProcessMemoryStore


def test_records_and_returns_recent_in_order():
    m = InProcessMemoryStore()
    for i in range(5):
        m.record(Turn("radio", f"t{i}"))
    assert [t.text for t in m.recent(3)] == ["t2", "t3", "t4"]


def test_recent_more_than_size_returns_all():
    m = InProcessMemoryStore()
    m.record(Turn("user", "a"))
    m.record(Turn("radio", "b"))
    assert [t.text for t in m.recent(10)] == ["a", "b"]


def test_recent_non_positive_is_empty():
    m = InProcessMemoryStore()
    m.record(Turn("radio", "a"))
    assert m.recent(0) == []
    assert m.recent(-1) == []


def test_bounded_to_maxlen():
    m = InProcessMemoryStore(maxlen=3)
    for i in range(6):
        m.record(Turn("radio", f"t{i}"))
    assert [t.text for t in m.recent(100)] == ["t3", "t4", "t5"]
