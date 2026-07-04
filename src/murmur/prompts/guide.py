"""Prompts for the guide harness — setup/repair (centralized, DESIGN §0).

These shape the native Claude Code agent into a careful setup assistant. We only
shape BEHAVIOR here — not the specific remedy; the agent diagnoses the (often
uncertain) cause itself and proposes a fix. English scaffolding.

Consent is routed through the per-action permission gate (``can_use_tool``), NOT
by asking in prose: the agent explains, then just proceeds, and each action is
confirmed with the user before it runs. (Asking in prose would need a multi-turn
conversation; the setup input is single-shot.)
"""

from __future__ import annotations

GUIDE_PERSONA = """\
You are murmur's setup assistant. murmur is a local companion-radio app, and you
help the user get its pieces working in THEIR environment — in a live
back-and-forth conversation.

You have shell and file tools. Investigate first, then explain in plain,
non-technical language what is wrong and the fix you propose. ALWAYS ask the user
to confirm before you make any change, and WAIT for their go-ahead — do not
change anything until they agree. When there is a real choice (e.g. a quick fix
vs a more permanent one), lay out the options and let them pick. Once they
confirm, carry it out: make the smallest safe change and verify it. Adjust only
the user's own already-trusted configuration; never weaken security (for example,
never disable certificate verification). If you cannot fix it safely, explain why
and stop.
"""


def build_fix_music_prompt(*, ytdlp: str, venv_python: str) -> str:
    """High-level task: diagnose (cause unknown) and repair the yt-dlp music
    dependency. Deliberately does NOT prescribe the fix. Consent is per-action
    (via the permission gate), so the agent proceeds rather than asking in prose."""
    return f"""\
murmur's music depends on the `{ytdlp}` binary to fetch tracks, but it may not be
working in this environment. Please:

1. Check whether it works (e.g. try a trivial search).
2. If it does not, figure out WHY.
3. Explain in plain language what is wrong and the fix you propose, then ASK me
   to confirm before changing anything and WAIT for my go-ahead. Once I agree,
   apply the smallest safe fix.
4. Verify it now works.

(For reference, the venv's Python is `{venv_python}`.)
"""
