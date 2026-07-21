"""Time-of-day scene derivation (spec 04 §3.4).

Reads the local wall clock into a coarse scene bucket so the host's talk can
speak to the current time of day. ``scene_for`` is pure and clock-free — a
function of a passed-in ``datetime`` — so the boundaries are unit-testable
without ever calling ``datetime.now()``. ``current_scene`` is the runtime entry
the Director uses: it honors a ``MURMUR_SCENE`` override (by-ear / testing) and
otherwise derives from the supplied clock.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime

# The valid scene buckets, in day order. The single source of truth for both the
# clock derivation and what ``MURMUR_SCENE`` will accept.
SCENES = ("morning", "afternoon", "evening", "late-night")


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


def current_scene(now: datetime) -> str:
    """The scene to use at runtime: a ``MURMUR_SCENE`` override when set to a
    valid bucket (so a scene can be forced for by-ear testing without waiting for
    the hour), else derived from ``now`` via ``scene_for``.

    An empty/unset override just derives from the clock; a *non-empty but
    invalid* value warns and degrades to the clock — a typo must never break the
    radio (same posture as the ``Config`` env knobs)."""
    override = os.environ.get("MURMUR_SCENE", "").strip()
    if override:
        if override in SCENES:
            return override
        print(
            f"warning: ignoring invalid MURMUR_SCENE={override!r} "
            f"(expected one of {', '.join(SCENES)})",
            file=sys.stderr,
        )
    return scene_for(now)
