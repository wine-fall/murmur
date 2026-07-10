"""RemoteVoiceProvider (spec 02 §3.6): the off-machine HTTP TTS adapter.

All unit, no network: the payload builder + build_voice wiring are pure, and
synthesize() runs with a stubbed transport (no real HTTP). The real fish-speech
server is a hands-on acceptance gate, owed when that box is up. Async tests wrap
the coroutine in asyncio.run(), matching the sidecar-client tests.
"""

from __future__ import annotations

import asyncio
import io
import wave
from pathlib import Path

import pytest

from murmur.config import Config
from murmur.contracts import AudioClip
from murmur.voice import build_voice
from murmur.voice.remote import RemoteVoiceProvider, build_tts_payload


def _wav_bytes(seconds: float = 0.1, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


# --- payload builder (fish-speech /v1/tts body) --------------------------- #


def test_payload_carries_text_and_whole_clip_wav_defaults():
    p = build_tts_payload("hello", reference_id="spk1")
    assert p["text"] == "hello"
    assert p["format"] == "wav"
    assert p["streaming"] is False  # whole-clip, not chunked (spec 02 §3.4)
    assert p["normalize"] is True
    assert p["reference_id"] == "spk1"


def test_payload_omits_reference_id_when_absent():
    # No reference_id -> let the server use its default voice.
    assert "reference_id" not in build_tts_payload("hi", reference_id=None)


# --- synthesize (stubbed transport, no network) --------------------------- #


def test_synthesize_writes_the_remote_wav_and_returns_a_talk_clip(monkeypatch):
    prov = RemoteVoiceProvider("http://box:8080", reference_id="spk1")
    audio = _wav_bytes()
    sent: dict[str, object] = {}

    def fake_post(payload: dict[str, object]) -> bytes:
        sent["payload"] = payload
        return audio

    monkeypatch.setattr(prov, "_post", fake_post)

    async def go() -> AudioClip:
        await prov.start()
        clip = await prov.synthesize("good evening")
        await prov.aclose()
        return clip

    clip = asyncio.run(go())
    assert isinstance(clip, AudioClip) and clip.kind == "talk"
    assert Path(clip.source).read_bytes() == audio  # the server's wav, verbatim
    payload = sent["payload"]
    assert isinstance(payload, dict)
    assert payload["text"] == "good evening" and payload["reference_id"] == "spk1"


def test_url_gets_the_v1_tts_path():
    assert RemoteVoiceProvider("http://box:8080/")._url == "http://box:8080/v1/tts"


# --- build_voice wiring (config switch, no code edit) --------------------- #


def test_build_voice_remote_constructs_provider():
    v = build_voice("remote", tts_url="http://box:8080", tts_reference_id="spk1")
    assert isinstance(v, RemoteVoiceProvider)


def test_build_voice_remote_without_url_raises():
    with pytest.raises(ValueError):
        build_voice("remote", tts_url="")


# --- config reads the endpoint from env ----------------------------------- #


def test_config_reads_tts_env(monkeypatch):
    monkeypatch.setenv("MURMUR_TTS_URL", "http://box:8080")
    monkeypatch.setenv("MURMUR_TTS_REFERENCE_ID", "spk1")
    c = Config.default()
    assert c.tts_url == "http://box:8080"
    assert c.tts_reference_id == "spk1"
