"""The thin generic MLX TTS backend + the profile registry (spec 02 §3.3/§3.5).

The L0 voices (Spark, Qwen3-TTS, Chatterbox, Dia) plus the added VoxCPM2 candidate
all run on Apple Silicon via ``mlx-audio`` through the same
``load_model(repo) -> model.generate(text, ...)`` API, so they are ONE backend,
not a class per model: ``MlxAudioBackend`` + a per-model
``MlxProfile`` (repo + defaults). Adding a model = adding a row to ``PROFILES``.

This is the heavy real-model path (DESIGN §11.3): the deterministic middle-layer
logic (``_build_generate_kwargs``, profile merge, selection) is unit-tested; the
model load/synth is a tagged integration test + hands-on human acceptance.
mlx-audio is an OPTIONAL ``tts-mlx`` extra, imported lazily so the unit suite
never pulls in MLX.
"""

from __future__ import annotations

import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from .backend import SynthesisRequest

if TYPE_CHECKING:
    # Type-only import of mlx-audio's real result type. Guarded so importing this
    # module never pulls in MLX at runtime (with `from __future__ import
    # annotations` the reference below stays a lazy string).
    from mlx_audio.tts.models.base import (  # pyright: ignore[reportMissingTypeStubs]
        GenerationResult,
    )


class TtsModel(Protocol):
    """The slice of an mlx-audio model that this backend uses. mlx-audio has no
    shared model base class — its ~40 model classes (Spark/Qwen/Kokoro/…) expose
    ``generate()`` + ``sample_rate`` only by convention — so we declare that
    convention as a Protocol (typed with mlx-audio's own ``GenerationResult``).
    This gives pyright teeth on our usage instead of a blanket ``Any``."""

    sample_rate: int

    def generate(self, text: str, **kwargs: Any) -> Iterable[GenerationResult]: ...


@dataclass(frozen=True)
class MlxProfile:
    """One model's config: HF repo + the defaults used to build a request."""

    repo: str
    voice: str | None = None
    language: str | None = None
    default_params: dict[str, object] = field(default_factory=dict[str, object])


# The L0 backends (spec 02 §3.3). Spark is primary (best Chinese by ear so far).
# VoxCPM2 (OpenBMB) was added post-L0 as a fifth blind-A/B candidate — 8bit is the
# quality reference for the A/B (swap to VoxCPM2-4bit if real-time RTF forces it).
# Repo ids are defaults, confirmed/tuned on the first hands-on run (§6).
PROFILES: dict[str, MlxProfile] = {
    "spark": MlxProfile("mlx-community/Spark-TTS-0.5B-bf16"),
    "qwen3": MlxProfile("mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16", voice="Chelsie"),
    "chatterbox": MlxProfile("mlx-community/chatterbox-fp16"),
    "dia": MlxProfile("mlx-community/Dia-1.6B-fp16"),
    "voxcpm2": MlxProfile("mlx-community/VoxCPM2-8bit"),
}


class MlxAudioBackend:
    """A generic ``TtsBackend`` over mlx-audio; a profile selects the model."""

    def __init__(self, profile: MlxProfile) -> None:
        self._profile = profile
        self._model: TtsModel | None = None
        self._dir: Path | None = None
        self._counter = 0

    def load(self) -> None:
        from mlx_audio.tts.utils import (  # pyright: ignore[reportMissingTypeStubs]
            load_model,
        )

        # mlx-audio types model_path as Path but accepts a HF repo-id str, and its
        # loaded model is untyped; we treat it as our TtsModel slice (§ above).
        self._model = load_model(self._profile.repo)  # type: ignore[arg-type,assignment]
        self._dir = Path(tempfile.mkdtemp(prefix="murmur-mlx-"))

    def warm(self) -> None:
        # One throwaway synth so the first real call is fast (master §3.5).
        assert self._dir is not None
        self._render(SynthesisRequest(text="Warming up."), self._dir / "warmup.wav")

    def synthesize(self, req: SynthesisRequest) -> str:
        assert self._dir is not None, "load() must run before synthesize()"
        self._counter += 1
        path = self._dir / f"clip-{self._counter:04d}.wav"
        self._render(req, path)
        return str(path)

    def _build_generate_kwargs(self, req: SynthesisRequest) -> dict[str, object]:
        """Merge profile defaults with the request (request wins) and map to
        mlx-audio ``generate()`` kwargs. ``text`` is passed positionally, not here.
        """
        kwargs: dict[str, object] = {}
        voice = req.voice or self._profile.voice
        if voice:
            kwargs["voice"] = voice
        language = req.language or self._profile.language
        if language:
            kwargs["lang_code"] = language
        if req.reference_audio:
            kwargs["ref_audio"] = req.reference_audio
        if req.reference_text:
            kwargs["ref_text"] = req.reference_text
        # Profile defaults first, then request params override them.
        kwargs.update({**self._profile.default_params, **req.params})
        return kwargs

    def _render(self, req: SynthesisRequest, path: Path) -> None:
        import mlx.core as mx
        from mlx_audio.audio_io import (  # pyright: ignore[reportMissingTypeStubs]
            write as audio_write,
        )

        assert self._model is not None, "load() must run before _render()"
        kwargs = self._build_generate_kwargs(req)
        chunks = [result.audio for result in self._model.generate(req.text, **kwargs)]
        if not chunks:
            raise RuntimeError(f"{self._profile.repo} produced no audio")
        # L0 renders the whole clip (§3.4): join all segments into one wav.
        audio = chunks[0] if len(chunks) == 1 else mx.concatenate(chunks, axis=0)
        # audio is an mlx array (not np.ndarray); audio_write handles it at runtime.
        audio_write(str(path), audio, self._model.sample_rate, format="wav")  # type: ignore[arg-type]
