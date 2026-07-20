"""Time-of-day scene bucketing (spec 04 §3.4).

Deterministic — the clock is injected (fixed ``datetime`` values), never
``datetime.now()``, so the bucket boundaries are pinned regardless of when the
suite runs.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from murmur.scene import scene_for


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 20, hour, minute)


@pytest.mark.parametrize(
    ("hour", "minute", "expected"),
    [
        (5, 0, "morning"),  # morning opens at 05:00
        (8, 30, "morning"),
        (11, 59, "morning"),  # last minute of morning
        (12, 0, "afternoon"),  # afternoon opens at noon
        (15, 0, "afternoon"),
        (17, 59, "afternoon"),
        (18, 0, "evening"),  # evening opens at 18:00
        (20, 0, "evening"),
        (22, 59, "evening"),
        (23, 0, "late-night"),  # late-night opens at 23:00
        (0, 0, "late-night"),  # midnight
        (3, 30, "late-night"),
        (4, 59, "late-night"),  # last minute before morning
    ],
)
def test_scene_boundaries(hour: int, minute: int, expected: str) -> None:
    assert scene_for(_at(hour, minute)) == expected
