"""Qwen3-TTS backend — the first real adapter (spec 02 §3.3).

Runs Qwen3-TTS on Apple Silicon via mlx-audio inside the sidecar process, so the
model loads once and stays warm. This is the heavy, real-model path: it is NOT
exercised by the fast unit layer (DESIGN §11.3) — only by the tagged integration
test (``pytest -m integration``, needs the ``tts-qwen3`` extra) and by hands-on
human voice acceptance (criteria §5.1 "sounds clearly human", §5.2 "warm").

mlx-audio is an OPTIONAL dependency, imported lazily here, so installing murmur
and running the unit suite never pulls in MLX. Written against mlx-audio's
documented Python API (``load_model`` → ``model.generate`` yielding
``result.audio`` / ``result.sample_rate``; ``mlx_audio.audio_io.write``). The
exact model variant and voice/preset (incl. Chinese/English voice mapping) are
tuned on the first hands-on run — spec 02 §6 open question.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from .backend import SynthesisRequest

# Defaults are tunable (spec 02 §6). The 0.6B Base variant is the lightest
# real-time-on-Mac option (the reason Qwen3-TTS is L0's pick, master §3.5);
# switch to a 1.7B variant for more warmth if it sounds thin. Base variants use
# preset voices (e.g. "Chelsie"), which fits L0's one-voice, no-cloning model.
DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
DEFAULT_VOICE = "Chelsie"


class Qwen3Backend:
    """``TtsBackend`` running Qwen3-TTS via mlx-audio. Satisfies the Protocol."""

    def __init__(
        self, model_path: str = DEFAULT_MODEL, voice: str = DEFAULT_VOICE
    ) -> None:
        self._model_path = model_path
        self._default_voice = voice
        self._model = None
        self._dir: Path | None = None
        self._counter = 0

    def load(self) -> None:
        from mlx_audio.tts.utils import load_model

        self._model = load_model(self._model_path)
        self._dir = Path(tempfile.mkdtemp(prefix="murmur-qwen3-"))

    def warm(self) -> None:
        # One throwaway synthesis so the first real call is fast (master §3.5).
        assert self._dir is not None
        self._render(SynthesisRequest(text="Warming up."), self._dir / "warmup.wav")

    def synthesize(self, req: SynthesisRequest) -> str:
        assert self._dir is not None, "load() must run before synthesize()"
        self._counter += 1
        path = self._dir / f"clip-{self._counter:04d}.wav"
        self._render(req, path)
        return str(path)

    def _render(self, req: SynthesisRequest, path: Path) -> None:
        import mlx.core as mx
        from mlx_audio.audio_io import write as audio_write

        # Map the standardized request onto mlx-audio's generate() kwargs. Only
        # non-None known fields are passed; params is the escape hatch for
        # model-specific knobs (speed, temperature, ...) and must hold valid
        # generate() kwargs. `style` is not wired for Base variants.
        kwargs: dict = {"voice": req.voice or self._default_voice}
        if req.language:
            kwargs["lang_code"] = req.language
        if req.reference_audio:
            kwargs["ref_audio"] = req.reference_audio
        if req.reference_text:
            kwargs["ref_text"] = req.reference_text
        kwargs.update(req.params)

        chunks = [result.audio for result in self._model.generate(req.text, **kwargs)]
        if not chunks:
            raise RuntimeError("Qwen3-TTS produced no audio")
        # L0 renders the whole clip (spec 02 §3.4): join all segments into one wav.
        audio = chunks[0] if len(chunks) == 1 else mx.concatenate(chunks, axis=0)
        audio_write(str(path), audio, self._model.sample_rate, format="wav")
