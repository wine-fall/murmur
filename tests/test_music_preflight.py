"""Deterministic yt-dlp preflight (spec 03-03 §2 / acceptance #2).

No network, no LLM: stand-in binaries stand in for yt-dlp so we test the
classification (ok / broken + reason / missing) purely on exit code + output.
"""

from __future__ import annotations

import asyncio
import stat
from pathlib import Path

from murmur.music.preflight import PreflightResult, preflight_ytdlp


def _stub_binary(tmp_path: Path, name: str, script: str) -> str:
    path = tmp_path / name
    path.write_text("#!/bin/sh\n" + script)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_preflight_ok_when_binary_returns_json(tmp_path: Path):
    binary = _stub_binary(tmp_path, "ytok", 'echo \'{"id":"x","title":"t"}\'\n')

    async def go():
        result = await preflight_ytdlp(binary)
        assert isinstance(result, PreflightResult)
        assert result.ok is True

    asyncio.run(go())


def test_preflight_broken_surfaces_the_reason(tmp_path: Path):
    binary = _stub_binary(
        tmp_path,
        "ytbad",
        'echo "ERROR: [SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate" 1>&2\n'
        "exit 1\n",
    )

    async def go():
        result = await preflight_ytdlp(binary)
        assert result.ok is False
        assert "CERTIFICATE_VERIFY_FAILED" in result.reason

    asyncio.run(go())


def test_preflight_reports_missing_binary(tmp_path: Path):
    missing = str(tmp_path / "does-not-exist")

    async def go():
        result = await preflight_ytdlp(missing)
        assert result.ok is False
        assert "not found" in result.reason.lower()

    asyncio.run(go())


def test_preflight_broken_when_no_output(tmp_path: Path):
    binary = _stub_binary(tmp_path, "ytempty", "exit 0\n")  # exit 0 but no JSON

    async def go():
        result = await preflight_ytdlp(binary)
        assert result.ok is False

    asyncio.run(go())
