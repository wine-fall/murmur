"""The warm TTS sidecar process (spec 02 §3.1-§3.2).

A separate, single-purpose Python process that loads a TTS model once and serves
synthesis requests over JSON-lines-over-stdio. The supervising client
(``SidecarVoiceProvider``, step 2) spawns it with ``python -m murmur.voice.sidecar``,
waits for ``health`` to report ready, then sends ``synthesize`` requests.

Run order: ``load()`` then ``warm()`` (slow, once), then the request loop. The
process only reaches the loop after warming, so the first ``health`` response
naturally means "model ready." stdout is the protocol channel — keep it clean;
everything else (model/library output, logging) must go to stderr.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import TextIO

from ._wav import wav_seconds
from .backend import FakeBackend, SynthesisRequest, TtsBackend
from .mlx_backend import PROFILES, MlxAudioBackend
from .protocol import OP_HEALTH, OP_SYNTHESIZE, ProtocolError, decode, encode


def build_backend(name: str) -> TtsBackend:
    """Select a ``TtsBackend`` by name: ``"fake"`` (no model), or one of the MLX
    backends in ``mlx_backend.PROFILES`` (``spark``/``qwen3``/``chatterbox``/``dia``/``voxcpm2``).
    Constructing an MLX backend imports no MLX — the model loads only in load()."""
    if name == "fake":
        return FakeBackend()
    profile = PROFILES.get(name)
    if profile is not None:
        return MlxAudioBackend(profile)
    available = ", ".join(["fake", *sorted(PROFILES)])
    raise ValueError(f"unknown tts backend {name!r}; available: {available}")


def _handle(
    backend: TtsBackend,
    req: dict[str, object],
    startup: dict[str, float],
) -> dict[str, object]:
    op = req.get("op")
    if op == OP_HEALTH:
        # Unconditionally ready by construction: serve() runs load()+warm() to
        # completion *before* the request loop starts, so the process cannot
        # answer health until the model is warm. If warm() ever becomes lazy,
        # this must instead query real backend readiness.
        return {"ready": True}
    if op == OP_SYNTHESIZE:
        # from_dict takes untrusted input and validates (raises on a non-object
        # payload or missing text), so pass it through without narrowing here.
        sr = SynthesisRequest.from_dict(req.get("request"))
        start = time.monotonic()
        path = backend.synthesize(sr)
        # Report numbers only (no logging here — the parent is the single log
        # writer). gen_s = model time; audio_s = clip length -> parent's rtf.
        timings: dict[str, float] = {
            "gen_s": time.monotonic() - start,
            "audio_s": wav_seconds(path),
        }
        # load/warm ran once before the loop; ride them out on the first synth,
        # then clear so later responses don't repeat them.
        timings.update(startup)
        startup.clear()
        # MLX memory (bytes -> MB) rides along so the parent's synth log shows
        # where the multi-GB footprint goes: active (needed) vs cache (reclaimable).
        for key, value in backend.memory_stats().items():
            timings[f"{key}_mb"] = round(value / 1024 / 1024)
        return {"audio_path": path, "timings": timings}
    raise ProtocolError(f"unknown op {op!r}")


def serve(backend: TtsBackend, *, stdin: TextIO, stdout: TextIO) -> None:
    """Load + warm the backend, then serve one request per input line until EOF.

    A bad request (malformed line, unknown op, missing field) or a backend
    failure becomes an ``{"error": ...}`` response and the loop keeps serving —
    a single bad call must never take the sidecar down. ``load()``/``warm()``
    failures propagate (the process exits; the client's supervision restarts it).

    On the way out (stdin EOF — the client's graceful ``aclose()``, or a dead
    parent) the backend's ``close()`` runs so its temp clip dir does not outlive
    the process (issue #46). A hard kill (the client's supervised-restart path)
    deliberately skips it: clips already returned may still be queued for playback.
    """
    load_start = time.monotonic()
    backend.load()
    load_s = time.monotonic() - load_start
    warm_start = time.monotonic()
    backend.warm()
    # Startup one-shot: attached to the first synth response, then cleared.
    startup = {"load_s": load_s, "warm_s": time.monotonic() - warm_start}
    try:
        # Explicit readline() rather than `for raw in stdin` — file-object iteration
        # can read-ahead past the single line the client sent while the client blocks
        # waiting for this line's response, a classic strict-request/response deadlock.
        for raw in iter(stdin.readline, ""):
            if not raw.strip():
                continue  # tolerate blank lines on the pipe
            resp: dict[str, object]
            try:
                resp = _handle(backend, decode(raw), startup)
            except ProtocolError as exc:
                resp = {"error": str(exc)}
            except Exception as exc:  # backend failure — surface, don't crash the loop
                resp = {"error": f"{type(exc).__name__}: {exc}"}
            stdout.write(encode(resp))
            stdout.flush()  # essential: unbuffer so the client's read returns
    finally:
        backend.close()


def _serve_protected(backend: TtsBackend) -> None:
    """Serve with the stdout protocol channel protected.

    stdout carries only protocol JSON, but the model and its libraries (mlx-audio,
    huggingface_hub/tqdm download progress, warnings) print to stdout during
    ``load()`` — which would corrupt the channel and crash the client's JSON
    decode. Preserve the real stdout for protocol writes, then point fd 1 *and*
    ``sys.stdout`` at stderr so any such output (Python- or C-level) is visible on
    stderr and can never reach the pipe the client reads (§3.2).
    """
    protocol_out = os.fdopen(
        os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8"
    )
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    serve(backend, stdin=sys.stdin, stdout=protocol_out)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="murmur.voice.sidecar")
    parser.add_argument("--backend", default="fake", help="TTS backend name")
    args = parser.parse_args(argv)
    _serve_protected(build_backend(args.backend))


if __name__ == "__main__":
    main()
