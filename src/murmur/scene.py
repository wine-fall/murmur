"""Time-of-day scene derivation (spec 04 §3.4).

Reads the local wall clock into a coarse scene bucket so the host's talk can
speak to the current time of day. Pure and clock-free: the bucketing is a
function of a passed-in ``datetime`` — the Director supplies the real local
clock at runtime, tests inject fixed values — so the boundaries are unit-testable
without ever calling ``datetime.now()``.
"""

from __future__ import annotations

from datetime import datetime


def scene_for(now: datetime) -> str:
    """Map a local ``datetime`` to a coarse scene bucket.

    Boundaries (local hours): morning 05:00–11:59, afternoon 12:00–17:59,
    evening 18:00–22:59, late-night 23:00–04:59 (wraps past midnight).
    """
    hour = now.hour
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 18:
        return "afternoon"
    if 18 <= hour < 23:
        return "evening"
    return "late-night"
