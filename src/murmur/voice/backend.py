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

from dataclasses import asdict, dataclass, field, fields
from typing import Any, Protocol, runtime_checkable

from ._wav import SilentClipWriter


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
    params: dict[str, Any] = field(default_factory=dict)  # model-specific knobs

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SynthesisRequest":
        if not isinstance(data, dict):
            raise ValueError("SynthesisRequest payload must be a JSON object")
        text = data.get("text")
        if not isinstance(text, str):
            raise ValueError("SynthesisRequest requires 'text' (str)")
        # Ignore unknown keys so a newer client never breaks an older sidecar
        # (forward-compat is the whole point of the standardized boundary).
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})


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
