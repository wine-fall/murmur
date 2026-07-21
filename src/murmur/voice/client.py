"""SidecarVoiceProvider — the supervising VoiceProvider client (spec 02 §3.1).

Owns the warm TTS sidecar's lifecycle and supervises it: ``start()`` spawns the
sidecar process and blocks until it reports ready (model loaded + warmed);
``synthesize()`` sends a request over JSON-lines-over-stdio and returns the wav
the sidecar wrote; ``aclose()`` shuts it down. If the sidecar dies, the next
``synthesize()`` restarts it and retries once — a TTS crash surfaces as a clear
error or a recovered call, never a hung core (master §3.5).

The model only ever loads inside the spawned subprocess, so constructing this
provider (even for the ``"qwen3"`` backend) imports no heavy dependency.
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
from typing import cast

from ..contracts import AudioClip
from ..logging_setup import get_log
from .backend import SynthesisRequest
from .protocol import OP_HEALTH, OP_SYNTHESIZE, decode, encode

_log = get_log("voice")

# A generous default: a real model's load + warm can take many seconds.
_READY_TIMEOUT = 120.0
_SYNTH_TIMEOUT = 120.0
_SHUTDOWN_TIMEOUT = 5.0


def log_synth(chars: int, timings: object) -> None:
    """Emit one 'synth' timing event from the sidecar's returned numbers. rtf =
    gen_s / audio_s makes 'is TTS slow?' answerable at a glance (>1 = slower than
    real time). Tolerant of a timings-less response (older sidecar / an error)."""
    fields: dict[str, object] = {"chars": chars}
    if isinstance(timings, dict):
        t = cast("dict[str, object]", timings)
        fields.update(t)
        gen_s, audio_s = t.get("gen_s"), t.get("audio_s")
        if (
            isinstance(gen_s, (int, float))
            and isinstance(audio_s, (int, float))
            and audio_s > 0
        ):
            fields["rtf"] = gen_s / audio_s
    _log.event("synth", **fields)


class SidecarDied(Exception):
    """The sidecar process is gone / the pipe broke mid-request."""


class SidecarVoiceProvider:
    """VoiceProvider backed by a supervised, warm TTS sidecar process."""

    def __init__(
        self,
        backend: str,
        *,
        voice: str | None = None,
        language: str | None = None,
        reference_audio: str | None = None,
        reference_text: str | None = None,
        style: str | None = None,
        params: dict[str, object] | None = None,
        ready_timeout: float = _READY_TIMEOUT,
        synth_timeout: float = _SYNTH_TIMEOUT,
    ) -> None:
        self._backend = backend
        self._voice = voice
        self._language = language
        self._reference_audio = reference_audio
        self._reference_text = reference_text
        self._style = style
        self._params = dict(params or {})
        self._ready_timeout = ready_timeout
        self._synth_timeout = synth_timeout
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()  # serialize access to the single pipe

    # --- VoiceProvider contract ------------------------------------------- #

    async def start(self) -> None:
        """Spawn + warm the sidecar. Idempotent: a no-op if already running."""
        async with self._lock:
            await self._ensure_started()

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        # scenario is accepted but deliberately unused in L0 (spec 02 §1: per-
        # scenario voice wiring is deferred; L0 honors one voice). The seam stays
        # open — when it lands it maps to SynthesisRequest fields in _build_request.
        obj: dict[str, object] = {
            "op": OP_SYNTHESIZE,
            "request": self._build_request(text).to_dict(),
        }
        async with self._lock:
            await self._ensure_started()
            try:
                try:
                    resp = await self._do_synth(obj)
                except SidecarDied:
                    # Supervise: restart once and retry rather than hang the core.
                    await self._spawn_and_ready()
                    resp = await self._do_synth(obj)
            except asyncio.CancelledError:
                # A cancelled synth (the Director merges a fresh line before the
                # clip is ready, §3.3) left a request written but its response
                # unread — the pipe is desynced, exactly like the timeout case.
                # Kill the still-alive sidecar so the next call respawns clean
                # instead of reading this request's stale response.
                await self._kill_proc()
                raise
        if "error" in resp:
            raise RuntimeError(f"sidecar synthesize failed: {resp['error']}")
        path = resp.get("audio_path")
        if not isinstance(path, str):
            raise RuntimeError(f"sidecar returned no audio_path: {resp}")
        log_synth(len(text), resp.get("timings"))
        return AudioClip(source=path, kind="talk")

    async def aclose(self) -> None:
        async with self._lock:
            await self._shutdown_proc()

    # --- supervision internals -------------------------------------------- #

    def _build_request(self, text: str) -> SynthesisRequest:
        return SynthesisRequest(
            text=text,
            voice=self._voice,
            language=self._language,
            reference_audio=self._reference_audio,
            reference_text=self._reference_text,
            style=self._style,
            params=dict(self._params),
        )

    async def _ensure_started(self) -> None:
        if self._proc is None or self._proc.returncode is not None:
            await self._spawn_and_ready()

    async def _spawn_and_ready(self) -> None:
        await self._kill_proc()  # clear out a dead/stale process first
        self._proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "murmur.voice.sidecar",
            "--backend",
            self._backend,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            # stderr is inherited: model/library diagnostics stay visible and
            # off the stdout protocol channel.
        )
        try:
            resp = await asyncio.wait_for(
                self._request({"op": OP_HEALTH}), timeout=self._ready_timeout
            )
        except (SidecarDied, asyncio.TimeoutError) as exc:
            await self._kill_proc()
            raise RuntimeError(
                f"sidecar {self._backend!r} failed to become ready: {exc}"
            ) from exc
        if not resp.get("ready"):
            await self._kill_proc()
            raise RuntimeError(
                f"sidecar {self._backend!r} did not report ready: {resp}"
            )

    async def _do_synth(self, obj: dict[str, object]) -> dict[str, object]:
        try:
            return await asyncio.wait_for(
                self._request(obj), timeout=self._synth_timeout
            )
        except asyncio.TimeoutError as exc:
            # The request line was written but its response was never read, so
            # the pipe is now desynced: the next read would return THIS request's
            # stale response. Kill the (still-alive) sidecar so the next call
            # respawns a clean process instead of silently shifting every reply.
            await self._kill_proc()
            raise RuntimeError("sidecar synthesize timed out") from exc

    async def _request(self, obj: dict[str, object]) -> dict[str, object]:
        # Invariant: this has no internal deadline — every caller MUST wrap it in
        # asyncio.wait_for so a wedged-but-alive sidecar cannot hang the core.
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdout is None:
            raise SidecarDied("sidecar is not running")
        try:
            proc.stdin.write(encode(obj).encode())
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise SidecarDied(f"write failed: {exc}") from exc
        line = await proc.stdout.readline()
        if not line:  # EOF — the sidecar exited
            raise SidecarDied("sidecar closed the connection")
        return decode(line.decode())

    async def _shutdown_proc(self) -> None:
        """Graceful shutdown, final-close only: stdin EOF lets the sidecar's
        serve loop exit and remove its temp clip dir (issue #46), then escalate
        to the hard kill if it does not exit in time. The supervised-restart
        paths use _kill_proc directly — no cleanup — because clips already
        returned may still be queued for playback (spec 04 look-ahead)."""
        proc = self._proc
        if proc is not None and proc.returncode is None and proc.stdin is not None:
            with contextlib.suppress(Exception):
                proc.stdin.close()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), timeout=_SHUTDOWN_TIMEOUT)
        await self._kill_proc()  # reap, or escalate if still alive

    async def _kill_proc(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None or proc.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), timeout=_SHUTDOWN_TIMEOUT)
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()
