"""Talk-segment and reply prompt builders (spec 01 §3.2).

English prompt scaffolding wrapped around the persona (System Prompt) and the
compact transcript of recent turns (master §6). The radio speaks Chinese
because the persona seed says so — these instructions stay in English.
"""

from __future__ import annotations

import json
from typing import cast

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


# Batch output discipline (spec 04 §3.2 look-ahead): the SDK's plain query has no
# output-schema, so the batch shape is requested in the prompt as JSON. Each array
# item is still clean spoken text (fed straight to TTS).
_BATCH_OUTPUT_RULES = (
    "Output ONLY a JSON array of exactly {count} strings and nothing else — no "
    "prose, no code fences, no keys. Each string is one spoken beat of radio (a "
    "few sentences, clean spoken text: no markup, speaker labels, quotation "
    "marks, or stage directions). The beats run consecutively as one flowing "
    "stretch of the program."
)


def build_next_talks_prompt(ctx: ContextPack, count: int) -> str:
    """Prompt for the next ``count`` self-initiated beats in one call (the
    look-ahead batch, spec 04 §3.2). Same head as the single builder; the output
    rule asks for a JSON array so the beats can be split deterministically."""
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
    return f"{head}\n{_BATCH_OUTPUT_RULES.format(count=count)}"


def parse_talk_batch(text: str, count: int | None = None) -> list[str]:
    """Split the model's batch output into spoken beats.

    Expects a JSON array of strings (the shape ``build_next_talks_prompt`` asks
    for), tolerating surrounding prose / code fences by extracting the outermost
    ``[...]``. **Degrades gracefully** (spec 04 §3.2): malformed / non-array /
    no-string-items output falls back to a single beat (the raw text), so a bad
    batch costs the look-ahead that round but never the segment. Empty in ->
    empty out. ``count`` caps the result (a model that over-produces must not
    inflate the buffer beyond what was asked); ``None`` = no cap."""
    raw = text.strip()
    if not raw:
        return []
    start, end = raw.find("["), raw.rfind("]")
    candidate = raw[start : end + 1] if 0 <= start < end else raw
    try:
        data: object = json.loads(candidate)
    except (ValueError, TypeError):
        return [raw]
    if isinstance(data, list):
        items = cast("list[object]", data)
        beats = [b.strip() for b in items if isinstance(b, str) and b.strip()]
        if beats:
            return beats[:count]  # count=None -> whole list; int -> capped
    return [raw]


def build_respond_prompt(user_text: str, ctx: ContextPack) -> str:
    """Prompt for an in-persona reply to a typed user line."""
    transcript = _render_transcript(ctx, drop_trailing_user=user_text)
    head = f"(The program so far)\n{transcript}\n\n" if transcript else ""
    return (
        f'{head}The listener just said to you: "{user_text}"\n'
        f"Respond in character, then ease back into the program.\n{_OUTPUT_RULES}"
    )
