"""Instruction for the opt-in brain cadence mode (spec 03-02 §2.3).

The one sanctioned exception to master §7 pillar 1: the user explicitly trades
a cheap one-shot call per segment boundary for a by-feel talk/music decision.
"""

from __future__ import annotations

CADENCE_INSTRUCTION = """\
You are pacing a personal radio program. Decide what the NEXT segment should
be: more talk, or a piece of music.

Think like a radio host: talk builds connection, music gives the listener room
to breathe. Avoid long talk-only stretches and avoid wall-to-wall music.

Call choose_segment exactly once with your decision.
"""

CADENCE_STATE_HEADER = "Current program state:\n"
