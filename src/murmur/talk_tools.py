"""Harness tool for batched talk generation (spec 04 §3.2).

``next_talks`` needs the model to return N spoken beats as *structured data*, not
free text. The ``claude-agent-sdk`` ``query`` has no output schema, so — as with
music discovery (spec 03-01) — we use the harness tool seam: one terminal
``BrainTool`` whose ``input_schema`` fixes the shape. The model returns its beats
by *calling* the tool; the SDK delivers the call as a parsed ``args`` mapping, so
there is no JSON text to scrape. The wire shape is defined here (producer) and
trusted in one place (``parse_talk_beats``, the consumer).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypedDict, cast


class TalkBeats(TypedDict):
    ok: Literal[True]
    beats: list[str]


def _clean(raw: object) -> list[str]:
    """Keep the non-empty string items of an untrusted array; drop the rest."""
    if not isinstance(raw, list):
        return []
    items = cast("list[object]", raw)
    return [b.strip() for b in items if isinstance(b, str) and b.strip()]


def parse_talk_beats(result: Mapping[str, object] | None) -> list[str]:
    """Validate the terminal-tool result into the ordered spoken beats — empty if
    the model never called the tool (``None``), the call wasn't a success, or the
    shape drifted. The one place the ``emit_talk_beats`` wire shape is trusted."""
    if not result or result.get("ok") is not True:
        return []
    return _clean(result.get("beats"))


class EmitTalkBeatsTool:
    """Terminal: the model returns its next ``count`` spoken beats by calling this.
    The call IS the task result (spec 03-01 §2.1 termination) — no free-text JSON."""

    name = "emit_talk_beats"
    description = (
        "Return your next spoken radio beats as an array of strings, in order — "
        "each string is one beat (a few sentences of clean spoken text: no markup, "
        "speaker labels, quotation marks, or stage directions). Calling this ends "
        "the task."
    )
    terminal = True

    def __init__(self, count: int) -> None:
        self._count = count
        self.input_schema: dict[str, Any] = {
            "type": "object",
            "properties": {
                "beats": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": count,
                    "description": "the next spoken beats, in order, one string each",
                }
            },
            "required": ["beats"],
        }

    async def run(self, args: Mapping[str, object]) -> TalkBeats:
        # args is the model's tool call, already parsed by the SDK. Clean + cap to
        # count (a model that over-produces must not inflate the look-ahead buffer).
        return TalkBeats(ok=True, beats=_clean(args.get("beats"))[: self._count])
