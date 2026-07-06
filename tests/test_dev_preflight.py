"""dev_preflight blocker logic (fakes for the binary/platform probes)."""

from __future__ import annotations

import sys
from pathlib import Path

from murmur.music.preflight import PreflightResult

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import dev_preflight  # noqa: E402  (after the sys.path insert above)


def _fake_probe(ok: bool, reason: str = ""):
    async def probe(*_args, **_kwargs) -> PreflightResult:
        return PreflightResult(ok=ok, reason=reason)

    return probe


def _music_ok(monkeypatch) -> None:
    monkeypatch.setattr(dev_preflight, "preflight_ytdlp", _fake_probe(True))
    monkeypatch.setattr(dev_preflight, "preflight_ffmpeg", _fake_probe(True))


def _apple_silicon(monkeypatch) -> None:
    monkeypatch.setattr(dev_preflight.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(dev_preflight.platform, "machine", lambda: "arm64")


def test_stub_voice_no_music_needs_nothing(monkeypatch):
    assert dev_preflight.main(["--no-music", "--voice", "stub"]) == 0


def test_broken_binary_blocks_with_a_fix_hint(monkeypatch, capsys):
    monkeypatch.setattr(
        dev_preflight, "preflight_ytdlp", _fake_probe(False, "not found")
    )
    monkeypatch.setattr(dev_preflight, "preflight_ffmpeg", _fake_probe(True))
    rc = dev_preflight.main(["--voice", "stub"])  # stub skips the voice check
    out = capsys.readouterr().out
    assert rc == 1
    assert "yt-dlp" in out
    assert "make setup-music" in out


def test_healthy_music_and_stub_voice_passes(monkeypatch):
    _music_ok(monkeypatch)
    assert dev_preflight.main(["--voice", "stub"]) == 0


def test_real_voice_off_apple_silicon_blocks(monkeypatch, capsys):
    _music_ok(monkeypatch)
    monkeypatch.setattr(dev_preflight.platform, "system", lambda: "Linux")
    monkeypatch.setattr(dev_preflight.platform, "machine", lambda: "x86_64")
    rc = dev_preflight.main(["--voice", "spark"])
    out = capsys.readouterr().out
    assert rc == 1
    assert "Apple Silicon" in out
    assert "VOICE=stub" in out


def test_real_voice_on_apple_silicon_with_mlx_passes(monkeypatch):
    _music_ok(monkeypatch)
    _apple_silicon(monkeypatch)
    # mlx-audio is installed in the dev env (uv sync --all-extras); if not, the
    # check would add a hint — either way the import path is exercised here.
    import importlib.util

    if importlib.util.find_spec("mlx_audio") is None:
        import types

        monkeypatch.setitem(sys.modules, "mlx_audio", types.ModuleType("mlx_audio"))
    assert dev_preflight.main(["--voice", "spark"]) == 0
