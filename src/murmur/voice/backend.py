"""The sidecar's adapter boundary: ``SynthesisRequest`` + ``TtsBackend`` + the
no-model ``FakeBackend`` (spec 02 §3.5).

The boundary is standardized **once** to fit the whole candidate pool (Qwen3-TTS
now; CosyVoice2 / Chatterbox / Fish-Audio = OpenAudio S1 later), so adding a
model is "write one ``TtsBackend``" — no protocol or core change. The single
input is ``SynthesisRequest``: cross-model common axes as first-class fields, a
``params`` dict as the escape hatch for model-specific knobs. The single output
is a path to a complete mono wav on local disk.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Protocol, cast, runtime_checkable

from ._wav import SilentClipWriter


def _opt_str(value: object) -> str | None:
    """Coerce an untrusted JSON value to ``str | None`` (non-strings → None)."""
    return value if isinstance(value, str) else None


def _str_dict(value: object) -> dict[str, object]:
    """Coerce an untrusted JSON value to a ``dict`` (non-dicts → empty)."""
    return cast("dict[str, object]", value) if isinstance(value, dict) else {}


@dataclass(frozen=True)
class SynthesisRequest:
    """Standardized, backend-agnostic synthesis input (spec 02 §3.5).

    The core only ever sets ``text`` (it calls ``synthesize(text, scenario=...)``);
    the ``SidecarVoiceProvider`` fills the rest from per-backend config. Each
    ``TtsBackend`` reads the fields it supports and ignores the rest.
    """

    text: str  # required — what to speak
    voice: str | None = None  # preset timbre / speaker id
    language: str | None = None  # language tag
    reference_audio: str | None = None  # reference clip path for zero-shot cloning
    reference_text: str | None = None  # transcript of the reference clip
    style: str | None = None  # natural-language emotion / instruction
    params: dict[str, object] = field(default_factory=dict[str, object])  # knobs

    def to_dict(self) -> dict[str, object]:
        return cast("dict[str, object]", asdict(self))

    @classmethod
    def from_dict(cls, data: object) -> "SynthesisRequest":
        if not isinstance(data, dict):
            raise ValueError("SynthesisRequest payload must be a JSON object")
        obj = cast("dict[str, object]", data)
        text = obj.get("text")
        if not isinstance(text, str):
            raise ValueError("SynthesisRequest requires 'text' (str)")
        # Read only known fields (unknown keys ignored — forward-compat), coercing
        # each to its declared type: this is untrusted JSON, so validate shapes.
        return cls(
            text=text,
            voice=_opt_str(obj.get("voice")),
            language=_opt_str(obj.get("language")),
            reference_audio=_opt_str(obj.get("reference_audio")),
            reference_text=_opt_str(obj.get("reference_text")),
            style=_opt_str(obj.get("style")),
            params=_str_dict(obj.get("params")),
        )


@runtime_checkable
class TtsBackend(Protocol):
    """One TTS model behind the sidecar. Synchronous — the sidecar is a
    single-purpose process, so blocking model calls are fine here."""

    def load(self) -> None:
        """Load the model into memory (slow; once per process)."""
        ...

    def warm(self) -> None:
        """Throwaway synthesis so the first real call is fast (master §3.5)."""
        ...

    def synthesize(self, req: SynthesisRequest) -> str:
        """Render ``req`` to a complete mono wav; return its local file path."""
        ...

    def memory_stats(self) -> dict[str, int]:
        """Live memory in bytes (empty if not model-backed): ``active`` working
        set, ``cache`` the reclaimable Metal buffer pool, ``peak`` since the last
        synth. Reported so the parent can log where the footprint actually goes."""
        ...


class FakeBackend:
    """No-model ``TtsBackend``: writes a silent wav whose length scales with the
    text. The sidecar's test/dev backend — exercises the full two-process path
    (start / supervise / restart, and acceptance §3-§4) without any heavy model.
    """

    def __init__(self) -> None:
        self._clips = SilentClipWriter(prefix="murmur-sidecar-")

    def load(self) -> None:
        self._clips.start()

    def warm(self) -> None:
        # No model to warm; real backends do a throwaway synth here.
        pass

    def synthesize(self, req: SynthesisRequest) -> str:
        return self._clips.write(req.text)

    def memory_stats(self) -> dict[str, int]:
        return {}  # no model, no MLX memory to report
