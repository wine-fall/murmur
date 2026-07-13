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


def test_payload_carries_seed_only_when_set():
    # seed pins the timbre (fish-speech has no presets); omitted -> random voice.
    assert build_tts_payload("hi", reference_id=None, seed=42)["seed"] == 42
    assert "seed" not in build_tts_payload("hi", reference_id=None)


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


def test_url_strips_surrounding_whitespace_and_crlf():
    # A .env value edited on Windows carries a trailing \r that must not reach
    # the host (rstrip('/') would leave it, corrupting the URL).
    assert RemoteVoiceProvider("http://box:8080/\r\n")._url == "http://box:8080/v1/tts"


def _post_headers(monkeypatch, prov: RemoteVoiceProvider) -> dict[str, str]:
    """Capture the outgoing Request headers of one _post call — no network.
    urllib title-cases header keys (``model`` -> ``Model``)."""
    seen: dict[str, dict[str, str]] = {}

    class _Resp:
        def read(self) -> bytes:
            return b"wav"

        def __enter__(self):
            return self

        def __exit__(self, *a) -> None:
            return None

    def fake_urlopen(req, timeout):  # noqa: ANN001
        seen["headers"] = dict(req.header_items())
        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    prov._post({"text": "hi"})
    return seen["headers"]


def test_post_sends_a_named_user_agent(monkeypatch):
    # A Cloudflare-fronted server 403s urllib's default "Python-urllib/*" UA;
    # _post must send a named one.
    h = _post_headers(monkeypatch, RemoteVoiceProvider("http://box:8080"))
    assert "urllib" not in h["User-agent"].lower()


def test_post_sends_model_header_when_set(monkeypatch):
    # The 'model' header selects a hosted model (e.g. fish.audio s2.1-pro-free).
    h = _post_headers(
        monkeypatch, RemoteVoiceProvider("http://box:8080", model="s2.1-pro-free")
    )
    assert h["Model"] == "s2.1-pro-free"


def test_post_omits_model_header_when_unset(monkeypatch):
    # Self-hosted fish-speech takes no model header — don't send an empty one.
    h = _post_headers(monkeypatch, RemoteVoiceProvider("http://box:8080"))
    assert "Model" not in h


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
    monkeypatch.setenv("MURMUR_TTS_SEED", "42")
    monkeypatch.setenv("MURMUR_TTS_MODEL", "s2.1-pro-free")
    c = Config.default()
    assert c.tts_url == "http://box:8080"
    assert c.tts_reference_id == "spk1"
    assert c.tts_seed == 42
    assert c.tts_model == "s2.1-pro-free"


def test_config_seed_unset_is_none(monkeypatch):
    monkeypatch.delenv("MURMUR_TTS_SEED", raising=False)
    assert Config.default().tts_seed is None


def test_config_bad_seed_is_ignored_not_fatal(monkeypatch):
    # A non-numeric seed must not abort Config() for every voice (incl. spark) —
    # it degrades to the unpinned default, not a startup crash.
    monkeypatch.setenv("MURMUR_TTS_SEED", "not-a-number")
    assert Config.default().tts_seed is None


def test_build_voice_threads_seed_to_provider():
    v = build_voice("remote", tts_url="http://box:8080", tts_seed=42)
    assert isinstance(v, RemoteVoiceProvider) and v._seed == 42


def test_build_voice_threads_model_to_provider():
    v = build_voice("remote", tts_url="http://box:8080", tts_model="s2.1-pro-free")
    assert isinstance(v, RemoteVoiceProvider) and v._model == "s2.1-pro-free"
