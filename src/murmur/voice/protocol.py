"""JSON-lines IPC framing for the TTS sidecar (spec 02 §3.2).

One JSON object per line. The core writes a request line to the sidecar's stdin
and reads a response line from its stdout; the model and all sidecar logging go
to stderr so this channel stays clean. ``ensure_ascii`` keeps a line pure-ascii
even when the text is non-English (the radio speaks non-English at runtime),
which avoids any pipe-encoding surprises while round-tripping losslessly.
"""

from __future__ import annotations

import json
from typing import Any

# Wire-protocol op names (the "op" field of a request line).
OP_HEALTH = "health"
OP_SYNTHESIZE = "synthesize"


class ProtocolError(Exception):
    """A line could not be parsed as a single JSON object."""


def encode(obj: dict[str, Any]) -> str:
    """Serialize one object to a single newline-terminated JSON line."""
    return json.dumps(obj, ensure_ascii=True) + "\n"


def decode(line: str) -> dict[str, Any]:
    """Parse one line into a JSON object, or raise ``ProtocolError``."""
    line = line.strip()
    if not line:
        raise ProtocolError("empty line")
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ProtocolError(f"expected a JSON object, got {type(obj).__name__}")
    return obj
