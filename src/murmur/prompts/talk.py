"""Talk-segment and reply prompt builders (spec 01 §3.2).

English prompt scaffolding wrapped around the persona (System Prompt) and the
compact transcript of recent turns (master §6). The radio speaks Chinese
because the persona seed says so — these instructions stay in English.
"""

from __future__ import annotations

from ..contracts import ContextPack

# Output discipline appended to every Brain call: the result is fed straight to
# TTS, so it must be clean spoken text with no markup or stage directions.
_OUTPUT_RULES = (
    "Output only the words you say out loud — nothing else. Keep it short and "
    "spoken, one small beat of radio (a few sentences, not a monologue). No "
    "prefixes, speaker labels, quotation marks, or stage directions."
)


def _render_transcript(
    ctx: ContextPack, *, drop_trailing_user: str | None = None
) -> str:
    """Render recent turns as a transcript. The host's own prior lines are
    "You"; the listener's lines are "Listener"."""
    turns = list(ctx.recent)
    if drop_trailing_user is not None and turns:
        last = turns[-1]
        if last.role == "user" and last.text == drop_trailing_user:
            turns = turns[:-1]
    if not turns:
        return ""
    lines: list[str] = []
    for t in turns:
        speaker = "You" if t.role == "radio" else "Listener"
        lines.append(f"{speaker}: {t.text}")
    return "\n".join(lines)


def build_next_talk_prompt(ctx: ContextPack) -> str:
    """Prompt for a self-initiated next talk segment."""
    transcript = _render_transcript(ctx)
    if transcript:
        head = (
            f"(The program so far)\n{transcript}\n\nNow continue — say your next beat."
        )
    else:
        head = "The program is just starting. Open naturally with your first beat."
    return f"{head}\n{_OUTPUT_RULES}"


def build_next_talks_prompt(ctx: ContextPack, count: int) -> str:
    """Prompt for the next ``count`` self-initiated beats in one call (the
    look-ahead batch, spec 04 §3.2). Same head as the single builder; the beats
    are returned via the ``emit_talk_beats`` tool (structured output — see
    ``talk_tools``), so the shape lives in that tool's schema, not here."""
    transcript = _render_transcript(ctx)
    if transcript:
        head = (
            f"(The program so far)\n{transcript}\n\n"
            f"Now continue — say your next {count} beats."
        )
    else:
        head = (
            f"The program is just starting. Open naturally with your first "
            f"{count} beats."
        )
    return (
        f"{head}\nEach beat is one small stretch of radio (a few sentences, spoken "
        f"aloud — no markup, labels, or stage directions). Return all {count} beats "
        f"in order by calling the emit_talk_beats tool."
    )


def build_respond_prompt(user_text: str, ctx: ContextPack) -> str:
    """Prompt for an in-persona reply to a typed user line."""
    transcript = _render_transcript(ctx, drop_trailing_user=user_text)
    head = f"(The program so far)\n{transcript}\n\n" if transcript else ""
    return (
        f'{head}The listener just said to you: "{user_text}"\n'
        f"Respond in character, then ease back into the program.\n{_OUTPUT_RULES}"
    )
