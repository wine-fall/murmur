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
import io
import json
import random
import re
import tempfile
import time
import urllib.request
import wave
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

# spec 02 §3.6: fish TTS runs sentences straight into the next with too little
# gap — it reads as "AI". fish.audio's own inline pause hints ([pause]) proved
# INERT on s2.1-pro-free (the server strips them; verified by a real-boundary
# smoke), so we add the silence ourselves: split a beat at sentence-enders,
# synthesize each sentence, and concatenate with a fixed silence pad between.
# Enders (written as escapes to keep the source CJK-free per the language gate):
# U+3002 ideographic full stop, U+FF01 fullwidth !, U+FF1F fullwidth ?, U+2026
# ellipsis, plus ASCII ! and ?. ASCII '.' is deliberately excluded — it collides
# with decimals (3.5) and abbreviations (U.S.); the persona speaks Chinese, where
# the fullwidth marks are the real enders. A run of enders stays with its sentence.
# Built from codepoints so the source stays ASCII: U+3002 ideographic full stop,
# U+FF01 fullwidth !, U+FF1F fullwidth ?, U+2026 ellipsis, plus ASCII ! and ?.
_ENDERS = "".join(map(chr, (0x3002, 0xFF01, 0xFF1F, 0x2026))) + "!?"
_SENTENCE_RE = re.compile("[^%(e)s]*[%(e)s]+|[^%(e)s]+" % {"e": _ENDERS})
# Default inter-sentence gap. A clear breath without dragging; by-ear tunable live
# via MURMUR_TTS_SENTENCE_PAD_S (Config.tts_sentence_pad_s). 0 disables splitting.
_SENTENCE_PAD_S = 0.6


def split_sentences(text: str) -> list[str]:
    """Split ``text`` into sentences at enders (see ``_SENTENCE_RE``). Each
    ender-run stays with its sentence; trailing text without an ender is its own
    sentence; surrounding whitespace is trimmed and blanks dropped. A single
    sentence (or no ender) returns one item — the caller then does one plain
    synth, so single-sentence beats keep the pre-split behavior exactly."""
    return [s.strip() for s in _SENTENCE_RE.findall(text) if s.strip()]


def concat_wav_with_silence(wavs: list[bytes], pad_s: float) -> bytes:
    """Concatenate same-format PCM wavs with ``pad_s`` of silence **between** each
    (none leading/trailing). Every part is the same fish voice/model, so the
    audio params are taken from the first and reused for the joined output."""
    frames: list[bytes] = []
    params = None
    for w in wavs:
        with wave.open(io.BytesIO(w), "rb") as r:
            if params is None:
                params = r.getparams()
            frames.append(r.readframes(r.getnframes()))
    assert params is not None  # caller only splits when there are >= 2 sentences
    pad = b"\x00" * (int(params.framerate * pad_s) * params.sampwidth * params.nchannels)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams(params)
        w.writeframes(pad.join(frames))
    return out.getvalue()


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
        sentence_pad_s: float | None = None,
        timeout: float = _SYNTH_TIMEOUT,
    ) -> None:
        # strip() first: a .env value with trailing whitespace / CRLF would
        # otherwise survive into the host and corrupt the URL (rstrip('/') leaves \r).
        self._url = base_url.strip().rstrip("/") + "/v1/tts"
        self._reference_id = reference_id or None
        self._api_key = api_key or None
        self._seed = seed
        self._model = model or None
        self._pad_s = _SENTENCE_PAD_S if sentence_pad_s is None else sentence_pad_s
        self._timeout = timeout
        self._dir = Path(tempfile.mkdtemp(prefix="murmur-remote-"))
        self._counter = 0

    def _payload(self, text: str, seed: int | None) -> dict[str, object]:
        return build_tts_payload(text, reference_id=self._reference_id, seed=seed)

    # --- VoiceProvider contract ------------------------------------------- #

    async def start(self) -> None:
        # The remote is already warm — nothing to load. We do NOT fake a health
        # probe (the fish server exposes no guaranteed one); a down/bad URL
        # surfaces as a clear error on the first synthesize.
        _log.event("voice.remote", url=self._url)

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        # Split a multi-sentence beat and pad the joins with real silence (§3.6):
        # the model itself won't pause enough. A single sentence — or a zero/negative
        # pad (splitting disabled via config) — takes the plain one-shot path (no
        # split, no concat), identical to the pre-split behavior.
        sentences = split_sentences(text)
        start = time.monotonic()
        if len(sentences) <= 1 or self._pad_s <= 0:
            audio = await asyncio.to_thread(self._post, self._payload(text, self._seed))
        else:
            # Pin ONE voice across the parts. A reference_id (or a configured seed)
            # already pins the voice across calls, so pass the seed unchanged then.
            # ONLY when neither is set — where each raw call would otherwise sample a
            # fresh timbre (§3.6 voice pinning) — resolve one fallback seed so a
            # split beat can't change voice mid-beat.
            seed = self._seed
            if seed is None and self._reference_id is None:
                seed = random.randint(0, 2**31 - 1)
            parts = [
                await asyncio.to_thread(self._post, self._payload(s, seed))
                for s in sentences
            ]
            audio = concat_wav_with_silence(parts, self._pad_s)
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
