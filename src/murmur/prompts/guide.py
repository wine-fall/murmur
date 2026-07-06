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


def build_fix_music_prompt(
    *, ytdlp: str, ffmpeg: str, venv_python: str, reason: str = ""
) -> str:
    """High-level task: diagnose (cause unknown) and repair the music
    dependencies. Deliberately does NOT prescribe the fix. Consent is per-action
    (via the permission gate), so the agent proceeds rather than asking in prose.
    ``reason`` is the preflight's finding, handed over as evidence."""
    finding = (
        f"\nA quick automated check just reported:\n  {reason}\n" if reason else ""
    )
    return f"""\
murmur's music depends on TWO external binaries: `{ytdlp}` (fetches tracks) and
`{ffmpeg}` (decodes audio). One or both may be missing or broken in this
environment.
{finding}
Please:

1. Check each of them (e.g. a trivial `{ytdlp}` search; `{ffmpeg} -version`).
2. For whichever is not working, figure out WHY — "not installed at all" is a
   perfectly common cause.
3. Explain in plain language what is wrong and the fix you propose, then ASK me
   to confirm before changing anything and WAIT for my go-ahead. Once I agree,
   apply the smallest safe fix (installing via the user's own package manager,
   e.g. Homebrew on macOS, is a fine fix for a missing binary).
4. Verify BOTH now work.

(For reference, the venv's Python is `{venv_python}`.)
"""
