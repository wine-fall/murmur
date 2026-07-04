"""CLI-Host wiring for the guide harness (spec 03-03 §2), fakes only.

No network/model: preflight is injected, the brain is a fake GuideCapable, and
the CLI Host is the test fake. Pins the flow (noop / decline / confirm→recheck)
and the can_use_tool decision.
"""

from __future__ import annotations

import asyncio

from fakes import FakeCli, FakeGuideBrain

from murmur.music.preflight import PreflightResult
from murmur.setup import _cli_permission, run_music_setup


async def _ok(_binary: str) -> PreflightResult:
    return PreflightResult(ok=True, reason="")


async def _broken(_binary: str) -> PreflightResult:
    return PreflightResult(ok=False, reason="CERTIFICATE_VERIFY_FAILED")


def test_noop_when_music_already_works():
    async def go():
        brain = FakeGuideBrain()
        assert await run_music_setup(FakeCli(), brain, check=_ok) is True
        assert brain.calls == 0  # the guide never engages when preflight is ok

    asyncio.run(go())


def test_skips_when_user_declines():
    async def go():
        brain = FakeGuideBrain()
        cli = FakeCli(lines=["n"])
        assert await run_music_setup(cli, brain, check=_broken) is False
        assert brain.calls == 0

    asyncio.run(go())


def test_runs_guide_on_confirm_then_rechecks():
    class _Check:
        def __init__(self) -> None:
            self.n = 0

        async def __call__(self, _binary: str) -> PreflightResult:
            self.n += 1  # broken first, ok on the recheck (fix "worked")
            return PreflightResult(ok=self.n >= 2, reason="" if self.n >= 2 else "cert")

    async def go():
        brain = FakeGuideBrain()
        check = _Check()
        assert await run_music_setup(FakeCli(lines=["y"]), brain, check=check) is True
        assert brain.calls == 1  # guide engaged once
        assert check.n == 2  # initial preflight + recheck

    asyncio.run(go())


def test_cli_permission_allows_on_yes_denies_otherwise():
    from claude_agent_sdk import (
        PermissionResultAllow,
        PermissionResultDeny,
        ToolPermissionContext,
    )

    async def go():
        ctx = ToolPermissionContext()
        allow = await _cli_permission(FakeCli(lines=["y"]))(
            "Bash", {"command": "yt-dlp --version"}, ctx
        )
        deny = await _cli_permission(FakeCli(lines=["nope"]))(
            "Bash", {"command": "rm -rf /"}, ctx
        )
        assert isinstance(allow, PermissionResultAllow)
        assert isinstance(deny, PermissionResultDeny)

    asyncio.run(go())
