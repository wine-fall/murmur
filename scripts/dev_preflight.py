#!/usr/bin/env python3
"""Non-interactive dev preflight for `make dev`.

Reports each dependency the chosen run mode needs, with an actionable fix, and
exits non-zero when a hard blocker is missing so `make dev` can stop and point
the developer at the fix (req 3: no silent half-starts). It reuses murmur's own
music preflight (spec 03-03) so this and the in-app startup check agree.

Usage:
    python scripts/dev_preflight.py --voice spark   # real TTS wanted
    python scripts/dev_preflight.py --voice stub    # silent voice (no mlx/model)
    python scripts/dev_preflight.py --no-music      # skip the binary checks
"""

from __future__ import annotations

import argparse
import asyncio
import os
import platform
import sys

from murmur.music.preflight import preflight_ffmpeg, preflight_ytdlp

_OK = "\033[32m✓\033[0m"
_NO = "\033[31m✗\033[0m"


async def _probe_music() -> list[tuple[str, bool, str]]:
    """(name, ok, reason) for each music binary, probed concurrently."""
    yt, ff = await asyncio.gather(preflight_ytdlp(), preflight_ffmpeg())
    return [("yt-dlp", yt.ok, yt.reason), ("ffmpeg", ff.ok, ff.reason)]


def _check_music() -> list[str]:
    """Print each binary's status; return fix hints for the broken ones."""
    problems: list[str] = []
    for name, ok, reason in asyncio.run(_probe_music()):
        if ok:
            print(f"  {_OK} {name}")
        else:
            print(f"  {_NO} {name}: {reason}")
            problems.append(name)
    if problems:
        joined = " ".join(problems)
        return [
            f"music needs {joined}. Fix with:  make setup-music"
            f"   (or: brew install {joined})",
        ]
    return []


def _check_real_voice() -> list[str]:
    """Real MLX voices are Apple-Silicon only and need the tts-mlx extra."""
    on_apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
    if not on_apple_silicon:
        print(f"  {_NO} real voice: needs Apple Silicon (this host is not)")
        return ["real voice unavailable here. Use:  VOICE=stub make dev"]
    try:
        import mlx_audio  # noqa: F401  (probe only)
    except ImportError:
        print(f"  {_NO} real voice: mlx-audio not installed")
        return ["install the TTS extra:  uv sync --extra tts-mlx"]
    print(f"  {_OK} real voice (mlx-audio installed)")
    print("      note: the first run downloads the TTS model (slow, once).")
    return []


def _check_remote_voice() -> list[str]:
    """The remote HTTP backend (spec 02 §3.6) needs no local model — just a
    configured endpoint. Check the URL is set; the server itself is proven on the
    first synth."""
    url = os.environ.get("MURMUR_TTS_URL", "")
    if not url:
        print(f"  {_NO} remote voice: MURMUR_TTS_URL not set")
        return [
            "remote voice needs an endpoint:  "
            "MURMUR_TTS_URL=http://host:port VOICE=remote make dev"
        ]
    print(f"  {_OK} remote voice -> {url}")
    return []


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="dev preflight for make dev")
    ap.add_argument("--voice", default="spark", help="voice backend (or 'stub')")
    ap.add_argument("--no-music", action="store_true", help="skip music binaries")
    args = ap.parse_args(argv)

    print("preflight:")
    fixes: list[str] = []
    if not args.no_music:
        fixes += _check_music()
    if args.voice == "remote":
        fixes += _check_remote_voice()  # off-machine HTTP TTS — no local model
    elif args.voice != "stub":
        fixes += _check_real_voice()

    if fixes:
        print("\nblockers — fix these, or use an escape hatch:")
        for fix in fixes:
            print(f"  → {fix}")
        print("  → skip everything (offline):  STUB=1 make dev")
        return 1
    print("all set.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
