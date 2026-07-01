"""SidecarVoiceProvider — the supervising client (spec 02 §3.1).

Drives the *real* sidecar subprocess running ``--backend fake`` (fast, no heavy
model), so the full two-process path is exercised: spawn + wait-for-ready,
synthesize over the pipe, kill-and-recover (acceptance §3), and clean shutdown.
Backend selection by name (acceptance §4) is covered via the build_voice factory
without spawning a model.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from murmur.contracts import VoiceProvider
from murmur.voice import build_voice
from murmur.voice.client import SidecarDied, SidecarVoiceProvider
from murmur.voice.protocol import decode, encode


def test_satisfies_voice_provider_protocol():
    assert isinstance(SidecarVoiceProvider("fake"), VoiceProvider)


def test_sidecar_stdout_channel_survives_a_backend_printing_to_stdout():
    # Regression: mlx/HF print download progress to stdout during load(), which
    # corrupted the JSON protocol channel (JSONDecodeError on the health line).
    # _serve_protected must redirect fd 1 to stderr so a noisy backend can't break
    # the channel; the real fix is exercised via a backend that prints on load().
    prog = (
        "import sys\n"
        "from murmur.voice.sidecar import _serve_protected\n"
        "from murmur.voice.backend import FakeBackend\n"
        "class Noisy(FakeBackend):\n"
        "    def load(self):\n"
        "        print('POLLUTION-print')\n"
        "        sys.stdout.write('POLLUTION-write\\n'); sys.stdout.flush()\n"
        "        super().load()\n"
        "_serve_protected(Noisy())\n"
    )

    async def go():
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            prog,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(
            encode({"op": "synthesize", "request": {"text": "hi"}}).encode()
        )
        await proc.stdin.drain()
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=20)
        resp = decode(line.decode())  # must parse cleanly despite the pollution
        audio_path = resp["audio_path"]
        assert isinstance(audio_path, str)
        assert Path(audio_path).exists()
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=10)
        assert proc.stderr is not None
        stderr = await proc.stderr.read()
        assert b"POLLUTION" in stderr  # the noise went to stderr, off the channel

    asyncio.run(go())


def test_sidecar_module_starts_without_runtime_warnings():
    # Regression: `python -m murmur.voice.sidecar` must not emit the double-import
    # RuntimeWarning — the package __init__ must not pull the server module into
    # sys.modules before runpy executes it as __main__.
    async def go():
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "murmur.voice.sidecar",
            "--backend",
            "fake",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(encode({"op": "health"}).encode())
        await proc.stdin.drain()
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=20)
        assert decode(line.decode()) == {"ready": True}
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=10)
        assert proc.stderr is not None
        stderr = await proc.stderr.read()
        assert b"RuntimeWarning" not in stderr

    asyncio.run(go())


def test_start_then_synthesize_returns_playable_clip():
    async def go():
        provider = SidecarVoiceProvider("fake")
        await provider.start()
        try:
            clip = await asyncio.wait_for(
                provider.synthesize("hello there"), timeout=20
            )
            assert clip.kind == "talk"
            assert Path(clip.source).exists()
        finally:
            await provider.aclose()

    asyncio.run(go())


def test_synthesize_lazy_starts_without_explicit_start():
    async def go():
        provider = SidecarVoiceProvider("fake")
        try:
            clip = await asyncio.wait_for(provider.synthesize("hi"), timeout=20)
            assert Path(clip.source).exists()
        finally:
            await provider.aclose()

    asyncio.run(go())


def test_start_is_idempotent_one_process():
    async def go():
        provider = SidecarVoiceProvider("fake")
        await provider.start()
        proc1 = provider._proc
        await provider.start()
        assert provider._proc is proc1  # no second spawn
        await provider.aclose()

    asyncio.run(go())


def test_killing_sidecar_does_not_hang_core_and_recovers():
    # Acceptance §3: a dead sidecar must not crash/hang the core; the next call
    # restarts it and succeeds.
    async def go():
        provider = SidecarVoiceProvider("fake")
        await provider.start()
        clip1 = await asyncio.wait_for(provider.synthesize("one"), timeout=20)
        assert Path(clip1.source).exists()

        # Hard-kill the underlying process.
        killed = provider._proc
        assert killed is not None
        killed.kill()
        await killed.wait()

        # Next synthesize must recover (restart) rather than hang.
        clip2 = await asyncio.wait_for(provider.synthesize("two"), timeout=20)
        assert Path(clip2.source).exists()
        assert provider._proc is not killed  # a fresh process took over
        await provider.aclose()

    asyncio.run(go())


def test_synthesize_restarts_once_on_mid_request_death(monkeypatch):
    # The retry branch: a request that dies mid-flight (SidecarDied) triggers one
    # restart-and-retry. We stub the respawn to reuse the live proc so the test
    # stays fast and deterministic.
    async def go():
        provider = SidecarVoiceProvider("fake")
        await provider.start()
        real_request = provider._request
        state = {"n": 0}

        async def flaky(obj):
            if obj.get("op") == "synthesize":
                state["n"] += 1
                if state["n"] == 1:
                    raise SidecarDied("died mid-request")
            return await real_request(obj)

        async def noop_respawn():
            pass

        monkeypatch.setattr(provider, "_request", flaky)
        monkeypatch.setattr(provider, "_spawn_and_ready", noop_respawn)

        clip = await asyncio.wait_for(provider.synthesize("hi"), timeout=20)
        assert Path(clip.source).exists()
        assert state["n"] == 2  # failed once, retried once
        await provider.aclose()

    asyncio.run(go())


def test_two_sequential_synths_on_one_live_process():
    # Regression: strict request/response over the real stdio pipe must not
    # deadlock or desync across multiple calls on the same sidecar process
    # (guards the readline loop + the synth-timeout cleanup).
    async def go():
        provider = SidecarVoiceProvider("fake")
        await provider.start()
        proc = provider._proc
        c1 = await asyncio.wait_for(provider.synthesize("one"), timeout=20)
        c2 = await asyncio.wait_for(provider.synthesize("two"), timeout=20)
        assert provider._proc is proc  # same process — no restart
        assert c1.source != c2.source  # distinct clips — pipe not desynced
        assert Path(c1.source).exists() and Path(c2.source).exists()
        await provider.aclose()

    asyncio.run(go())


def test_synth_timeout_kills_sidecar_to_avoid_pipe_desync(monkeypatch):
    # Regression: a synth that times out while the sidecar is still alive must
    # kill the process — otherwise the unread response stays buffered and every
    # later call reads the previous request's stale audio_path forever.
    async def go():
        provider = SidecarVoiceProvider("fake", synth_timeout=0.05)
        await provider.start()

        async def slow(obj):
            await asyncio.sleep(1.0)
            return {"audio_path": "/never.wav"}

        monkeypatch.setattr(provider, "_request", slow)
        with pytest.raises(RuntimeError, match="timed out"):
            await asyncio.wait_for(provider.synthesize("hi"), timeout=20)
        assert provider._proc is None  # hung sidecar was killed
        await provider.aclose()

    asyncio.run(go())


def test_synthesize_raises_on_backend_error_response(monkeypatch):
    async def go():
        provider = SidecarVoiceProvider("fake")
        await provider.start()

        async def erroring(obj):
            return {"error": "boom"}

        monkeypatch.setattr(provider, "_request", erroring)
        with pytest.raises(RuntimeError, match="boom"):
            await asyncio.wait_for(provider.synthesize("hi"), timeout=20)
        await provider.aclose()

    asyncio.run(go())


def test_aclose_terminates_the_process():
    async def go():
        provider = SidecarVoiceProvider("fake")
        await provider.start()
        proc = provider._proc
        assert proc is not None
        await provider.aclose()
        assert proc.returncode is not None  # exited
        assert provider._proc is None

    asyncio.run(go())


def test_synthesize_passes_configured_voice_fields(monkeypatch):
    # The provider builds a SynthesisRequest from its per-backend config; the
    # core only ever passes text (spec 02 §3.5).
    async def go():
        provider = SidecarVoiceProvider(
            "fake", voice="warm", language="en", params={"speed": 1.2}
        )
        await provider.start()
        seen = {}

        async def capture(obj):
            seen.update(obj)
            return {"audio_path": "/tmp/x.wav"}

        monkeypatch.setattr(provider, "_request", capture)
        await asyncio.wait_for(provider.synthesize("hi"), timeout=20)
        assert seen["op"] == "synthesize"
        assert seen["request"]["text"] == "hi"
        assert seen["request"]["voice"] == "warm"
        assert seen["request"]["language"] == "en"
        assert seen["request"]["params"] == {"speed": 1.2}
        await provider.aclose()

    asyncio.run(go())


# --- factory: hot-swap by name (acceptance §4) ---------------------------- #
# Stub/unknown selection is covered in test_config_and_factories.py; here we
# pin the two new sidecar-backed names and that constructing them loads no model.


def test_build_voice_qwen3_is_sidecar_without_loading_model():
    provider = build_voice("qwen3")
    assert isinstance(provider, SidecarVoiceProvider)
    assert provider._backend == "qwen3"


def test_build_voice_sidecar_fake():
    provider = build_voice("sidecar-fake")
    assert isinstance(provider, SidecarVoiceProvider)
    assert provider._backend == "fake"
