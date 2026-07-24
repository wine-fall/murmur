"""Compaction prompt (spec 05 §3.6).

The periodic fold of recent history into the long-term profile. Centralized
here (DESIGN §0): English scaffolding; the profile text itself is whatever the
model writes in the persona's language. The hard size cap keeps the profile a
compact stable-prefix block (master §7 pillar 4).
"""

from __future__ import annotations

from ..contracts import Turn

# Hard cap on the profile the model returns (spec 05 §3.6) — keeps the pack's
# stable prefix small. By-feel tunable (spec 05 §6).
PROFILE_CHAR_CAP = 1500

_COMPACTION_INSTRUCTION = f"""\
You maintain a long-term listener profile for a personal companion radio. Fold
the durable facts from the recent transcript into the existing profile.

Keep: identity, stable preferences, recurring topics and interests, standing
context worth remembering across sessions. Drop: ephemera, one-off small talk,
anything transient. Merge — do not simply append; rewrite the profile so it
stays coherent and non-repetitive.

Return ONLY the updated profile text, in the listener's own language, under
{PROFILE_CHAR_CAP} characters. No preamble, headings, or commentary.
"""


def build_compaction_prompt(profile: str, transcript: list[Turn]) -> str:
    """The compaction turn: current profile + the recent transcript to fold."""
    current = profile.strip() or "(no profile yet)"
    lines = "\n".join(f"{t.role}: {t.text}" for t in transcript) or "(nothing)"
    return (
        f"{_COMPACTION_INSTRUCTION}\n"
        f"(Current profile)\n{current}\n\n"
        f"(Recent transcript to fold in)\n{lines}"
    )
