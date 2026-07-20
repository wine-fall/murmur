"""Time-of-day scene bucketing (spec 04 §3.4).

Deterministic — the clock is injected (fixed ``datetime`` values), never
``datetime.now()``, so the bucket boundaries are pinned regardless of when the
suite runs.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from murmur.scene import current_scene, scene_for


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


# --- MURMUR_SCENE override (by-ear / testing knob) ------------------------ #

# 15:00 would derive "afternoon" from the clock — a distinct value, so an
# override test proves the env won, not a coincidental match.
_CLOCK = _at(15, 0)


def test_valid_override_wins_over_the_clock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MURMUR_SCENE", "late-night")
    assert current_scene(_CLOCK) == "late-night"  # not the clock's "afternoon"


def test_no_override_falls_back_to_the_clock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MURMUR_SCENE", raising=False)
    assert current_scene(_CLOCK) == scene_for(_CLOCK) == "afternoon"


def test_blank_or_invalid_override_falls_back_to_the_clock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A typo / empty value must never break the radio — it degrades to the clock.
    for bad in ("", "   ", "mornin", "noon"):
        monkeypatch.setenv("MURMUR_SCENE", bad)
        assert current_scene(_CLOCK) == "afternoon"
