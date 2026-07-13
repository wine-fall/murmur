"""RemoteVoiceProvider — an off-machine HTTP TTS backend (spec 02 §3.6).

The model runs on another machine; murmur calls it over HTTP. There is no local
model or subprocess, so this sits on the SAME ``VoiceProvider`` seam as the warm
sidecar (``start`` / ``synthesize`` / ``aclose`` → ``AudioClip``) — the core and
Director are unchanged. Selected by config (``voice_provider="remote"`` + the
``MURMUR_TTS_*`` env), never a code edit per swap.

Wire protocol: fish-speech native ``POST /v1/tts`` with a JSON body (the fish
server accepts ``application/json`` as well as msgpack, so no extra serialization
dependency — stdlib ``json`` + ``urllib``). The blocking request runs in a worker
thread so the seam stays async. Response body is the complete wav.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import time
import urllib.request
from pathlib import Path

from ..contracts import AudioClip
from ..logging_setup import get_log
from ._wav import wav_seconds
from .client import log_synth  # shared 'synth' timing log (chars/gen_s/audio_s/rtf)

_log = get_log("voice")
_SYNTH_TIMEOUT = 120.0
# A named UA: a Cloudflare-fronted fish-speech endpoint blocks urllib's default
# "Python-urllib/*" UA with a 403 bot rule; any non-bot UA passes.
_USER_AGENT = "murmur"


def build_tts_payload(
    text: str, *, reference_id: str | None, seed: int | None = None
) -> dict[str, object]:
    """The fish-speech ``/v1/tts`` request body (§3.6): a whole-clip, normalized
    wav. ``reference_id`` picks the server-side saved voice; omitted → the server
    default. ``seed`` pins the sampled timbre (fish-speech has no preset voices,
    so without it each call is a new voice). Sampling defaults mirror fish-speech's
    own client."""
    payload: dict[str, object] = {
        "text": text,
        "format": "wav",
        "streaming": False,  # whole clip, not chunked (spec 02 §3.4)
        "normalize": True,
        "chunk_length": 200,
        "max_new_tokens": 1024,
        "top_p": 0.8,
        "repetition_penalty": 1.1,
        "temperature": 0.8,
    }
    if reference_id:
        payload["reference_id"] = reference_id
    if seed is not None:
        payload["seed"] = seed
    return payload


class RemoteVoiceProvider:
    """VoiceProvider backed by a remote fish-speech HTTP server."""

    def __init__(
        self,
        base_url: str,
        *,
        reference_id: str | None = None,
        api_key: str | None = None,
        seed: int | None = None,
        model: str | None = None,
        timeout: float = _SYNTH_TIMEOUT,
    ) -> None:
        # strip() first: a .env value with trailing whitespace / CRLF would
        # otherwise survive into the host and corrupt the URL (rstrip('/') leaves \r).
        self._url = base_url.strip().rstrip("/") + "/v1/tts"
        self._reference_id = reference_id or None
        self._api_key = api_key or None
        self._seed = seed
        self._model = model or None
        self._timeout = timeout
        self._dir = Path(tempfile.mkdtemp(prefix="murmur-remote-"))
        self._counter = 0

    # --- VoiceProvider contract ------------------------------------------- #

    async def start(self) -> None:
        # The remote is already warm — nothing to load. We do NOT fake a health
        # probe (the fish server exposes no guaranteed one); a down/bad URL
        # surfaces as a clear error on the first synthesize.
        _log.event("voice.remote", url=self._url)

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        payload = build_tts_payload(
            text, reference_id=self._reference_id, seed=self._seed
        )
        start = time.monotonic()
        audio = await asyncio.to_thread(self._post, payload)
        gen_s = time.monotonic() - start
        self._counter += 1
        path = self._dir / f"clip-{self._counter:04d}.wav"
        path.write_bytes(audio)
        log_synth(len(text), {"gen_s": gen_s, "audio_s": wav_seconds(str(path))})
        return AudioClip(source=str(path), kind="talk")

    async def aclose(self) -> None:
        # No owned process/socket to release (each request is one-shot).
        return None

    # --- transport (the untested network boundary) ------------------------ #

    def _post(self, payload: dict[str, object]) -> bytes:
        body = json.dumps(payload).encode("utf-8")
        headers = {"content-type": "application/json", "user-agent": _USER_AGENT}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        if self._model:  # e.g. fish.audio 's2.1-pro-free'; self-hosted omits it
            headers["model"] = self._model
        req = urllib.request.Request(  # noqa: S310 - fixed http(s) TTS endpoint
            self._url, data=body, headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:  # noqa: S310
            return resp.read()
