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

from .contracts import TalkBeat

# A wire beat is a plain JSON dict {"text": ..., "topic"?: ...} — kept as dict
# (not a dataclass) because the harness serializes the tool result back to the
# model. ``dict[str, str]`` over a TypedDict here: the shape is trivial and the
# key set is dynamic (topic present only when tagged).
_WireBeat = dict[str, str]


class TalkBeats(TypedDict):
    ok: Literal[True]
    beats: list[_WireBeat]


def _clean_wire(raw: object) -> list[_WireBeat]:
    """Validate an untrusted beats array into plain JSON dicts ``{text, topic?}``.
    Each item is an object ``{text, topic?}``; a bare string is tolerated
    (topic-less) so a model returning the older shape still airs. The result stays
    **wire-shaped** (JSON-serializable) because the harness hands it back to the
    model as the tool result — TalkBeat objects would fail to serialize (and be
    dropped on the way back). Conversion to ``TalkBeat`` happens only at the
    parser boundary. ``topic`` is optional (spec 05 §3.9)."""
    if not isinstance(raw, list):
        return []
    items = cast("list[object]", raw)
    beats: list[_WireBeat] = []
    for item in items:
        if isinstance(item, str):
            text, topic = item.strip(), None
        elif isinstance(item, Mapping):
            entry = cast("Mapping[str, object]", item)
            raw_text, raw_topic = entry.get("text"), entry.get("topic")
            text = raw_text.strip() if isinstance(raw_text, str) else ""
            topic = raw_topic.strip() or None if isinstance(raw_topic, str) else None
        else:
            continue
        if text:
            beat: _WireBeat = {"text": text}
            if topic:
                beat["topic"] = topic
            beats.append(beat)
    return beats


def parse_talk_beats(result: Mapping[str, object] | None) -> list[TalkBeat]:
    """Validate the terminal-tool result into the ordered spoken beats — empty if
    the model never called the tool (``None``), the call wasn't a success, or the
    shape drifted. The one place the ``emit_talk_beats`` wire shape is trusted;
    converts the wire dicts into ``TalkBeat`` objects for the Director."""
    if not result or result.get("ok") is not True:
        return []
    return [
        TalkBeat(text=b["text"], topic=b.get("topic"))
        for b in _clean_wire(result.get("beats"))
    ]


class EmitTalkBeatsTool:
    """Terminal: the model returns its next ``count`` spoken beats by calling this.
    The call IS the task result (spec 03-01 §2.1 termination) — no free-text JSON."""

    name = "emit_talk_beats"
    description = (
        "Return your next spoken radio beats as an array, in order — each beat is "
        "an object with `text` (a few sentences of clean spoken text: no markup, "
        "speaker labels, quotation marks, or stage directions) and an optional "
        "`topic` (a 2-5 word key naming what the beat is about, for anti-repeat). "
        "Calling this ends the task."
    )
    terminal = True

    def __init__(self, count: int) -> None:
        self._count = count
        self.input_schema: dict[str, Any] = {
            "type": "object",
            "properties": {
                "beats": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {
                                "type": "string",
                                "description": "the spoken beat, a few sentences",
                            },
                            "topic": {
                                "type": "string",
                                "description": "optional 2-5 word key for anti-repeat",
                            },
                        },
                        "required": ["text"],
                    },
                    "minItems": 1,
                    "maxItems": count,
                    "description": "the next spoken beats, in order",
                }
            },
            "required": ["beats"],
        }

    async def run(self, args: Mapping[str, object]) -> TalkBeats:
        # args is the model's tool call, already parsed by the SDK. Clean + cap to
        # count (a model that over-produces must not inflate the look-ahead
        # buffer). The result is wire-shaped (JSON dicts) — the harness serializes
        # it back to the model, so it must not carry TalkBeat objects.
        return TalkBeats(ok=True, beats=_clean_wire(args.get("beats"))[: self._count])
