"""JSON-lines IPC framing + SynthesisRequest serialization (spec 02 §3.2/§3.5).

The stdio channel carries one JSON object per line. The radio speaks non-English
at runtime, so the framing must keep a non-ascii payload on a single clean line
(escaped) and round-trip it losslessly. No CJK literals in source (DESIGN §0):
non-ascii test strings are built from codepoints.
"""

from __future__ import annotations

import json

import pytest

from murmur.voice.backend import SynthesisRequest
from murmur.voice.protocol import ProtocolError, decode, encode


def test_encode_is_single_newline_terminated_json_line():
    line = encode({"op": "health"})
    assert line.endswith("\n")
    assert "\n" not in line[:-1]  # exactly one line
    assert json.loads(line) == {"op": "health"}


def test_decode_round_trips():
    obj = {"op": "synthesize", "request": {"text": "hi"}}
    assert decode(encode(obj)) == obj


def test_decode_rejects_malformed_json():
    with pytest.raises(ProtocolError):
        decode("{not json")


def test_decode_rejects_non_object():
    with pytest.raises(ProtocolError):
        decode("[1, 2, 3]")


def test_encode_keeps_non_ascii_text_on_one_ascii_line():
    text = "a" + chr(0x00E9) + chr(0x4E2D)  # an accented latin char + a CJK codepoint
    line = encode({"op": "synthesize", "request": {"text": text}})
    assert line.isascii()  # escaped -> the stdio channel stays pure ascii
    assert decode(line)["request"]["text"] == text  # but round-trips losslessly


def test_synthesis_request_round_trips_through_dict():
    req = SynthesisRequest(
        text="hi",
        voice="warm",
        language="en",
        reference_audio="/ref.wav",
        reference_text="reference",
        style="gentle",
        params={"speed": 1.1},
    )
    assert SynthesisRequest.from_dict(req.to_dict()) == req


def test_synthesis_request_defaults_are_minimal():
    req = SynthesisRequest(text="hi")
    assert req.voice is None and req.reference_audio is None
    assert req.params == {}


def test_synthesis_request_requires_text():
    with pytest.raises(ValueError):
        SynthesisRequest.from_dict({})


def test_synthesis_request_ignores_unknown_fields():
    # Forward-compat: a backend that does not know a newer field just skips it,
    # so adding a model never breaks an older sidecar (spec 02 §3.5).
    req = SynthesisRequest.from_dict({"text": "hi", "future_knob": 7})
    assert req.text == "hi"
