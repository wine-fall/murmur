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
from murmur.voice._wav import wav_seconds
from murmur.voice.remote import (
    RemoteVoiceProvider,
    build_tts_payload,
    concat_wav_with_silence,
    split_sentences,
)


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


# --- sentence pauses (split at enders + silence pad) ---------------------- #
# Enders as codepoints so this source stays ASCII (language gate); the splitter is
# content-agnostic, so ASCII sentence bodies exercise it exactly as CJK would.
STOP = chr(0x3002)  # ideographic full stop
BANG = chr(0xFF01)  # fullwidth exclamation
QUES = chr(0xFF1F)  # fullwidth question


def test_split_sentences_at_cjk_enders_keeps_the_ender():
    assert split_sentences(f"one{STOP}two{STOP}") == [f"one{STOP}", f"two{STOP}"]
    assert split_sentences(f"hi{BANG}how{QUES}ok{STOP}") == [
        f"hi{BANG}",
        f"how{QUES}",
        f"ok{STOP}",
    ]


def test_split_sentences_coalesces_an_ender_run_and_keeps_a_trailing_fragment():
    # A "?!" run stays with its sentence; text after the last ender is its own item.
    assert split_sentences(f"what{QUES}{BANG}really") == [f"what{QUES}{BANG}", "really"]


def test_split_sentences_leaves_decimals_and_abbreviations_whole():
    # ASCII '.' is not an ender -> a decimal sentence is ONE item (no false split),
    # and an English clause stays whole.
    assert split_sentences(f"price 3.5 usd{STOP}") == [f"price 3.5 usd{STOP}"]
    assert split_sentences("the U.S. economy") == ["the U.S. economy"]


def test_split_sentences_single_or_blank():
    assert split_sentences("one clause no ender") == ["one clause no ender"]
    assert split_sentences("") == []
    assert split_sentences("   ") == []


def test_concat_wav_with_silence_sums_durations_plus_the_pad(tmp_path):
    a, b = _wav_bytes(0.20), _wav_bytes(0.30)
    out = concat_wav_with_silence([a, b], pad_s=0.25)
    path = tmp_path / "joined.wav"
    path.write_bytes(out)
    # 0.20 + 0.30 speech + one 0.25 pad between -> ~0.75s (one pad, not trailing).
    assert abs(wav_seconds(path) - 0.75) < 0.02


def test_synthesize_splits_multi_sentence_and_pads(monkeypatch, tmp_path):
    # A 2-sentence beat -> one _post per sentence, joined with a real silence pad.
    prov = RemoteVoiceProvider("http://box:8080", reference_id="spk1")
    calls: list[str] = []

    def fake_post(payload: dict[str, object]) -> bytes:
        calls.append(str(payload["text"]))
        return _wav_bytes(0.20)

    monkeypatch.setattr(prov, "_post", fake_post)
    clip = asyncio.run(prov.synthesize(f"one{STOP}two{STOP}"))
    assert calls == [f"one{STOP}", f"two{STOP}"]  # split into two synth calls
    # 0.20 + 0.20 + one 0.30 default pad = ~0.70s of joined audio.
    assert abs(wav_seconds(Path(clip.source)) - 0.70) < 0.03


def test_synthesize_single_sentence_is_one_call_no_pad(monkeypatch):
    # No interior ender -> exactly the pre-split path (one _post, verbatim text).
    prov = RemoteVoiceProvider("http://box:8080")
    calls: list[str] = []
    monkeypatch.setattr(
        prov, "_post", lambda p: (calls.append(str(p["text"])) or _wav_bytes())
    )
    asyncio.run(prov.synthesize("just one sentence"))
    assert calls == ["just one sentence"]


def test_synthesize_pins_one_voice_across_the_split_when_no_seed(monkeypatch):
    # Without a reference_id or seed, each raw call would sample a fresh timbre;
    # a split beat must pin ONE seed for every sentence so the voice is stable.
    prov = RemoteVoiceProvider("http://box:8080")  # no reference_id, no seed
    seeds: list[object] = []
    monkeypatch.setattr(
        prov, "_post", lambda p: (seeds.append(p.get("seed")) or _wav_bytes())
    )
    asyncio.run(prov.synthesize(f"one{STOP}two{STOP}three{STOP}"))
    assert len(seeds) == 3
    assert all(s is not None for s in seeds)  # a seed was pinned...
    assert len(set(seeds)) == 1  # ...and it is the SAME across sentences


def test_synthesize_does_not_inject_a_seed_when_a_reference_is_set(monkeypatch):
    # A reference_id already pins the voice across calls, so the split path must
    # NOT add a random seed (it would contradict voice-pinning and can perturb the
    # referenced voice / diverge from the single-sentence path).
    prov = RemoteVoiceProvider("http://box:8080", reference_id="spk1")  # no seed
    seeds: list[object] = []
    monkeypatch.setattr(
        prov, "_post", lambda p: (seeds.append(p.get("seed")) or _wav_bytes())
    )
    asyncio.run(prov.synthesize(f"one{STOP}two{STOP}"))
    assert seeds == [None, None]  # reference pins the voice; no seed injected


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
