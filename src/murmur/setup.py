"""Wire the guide harness into murmur's CLI Host (spec 03-03).

The deterministic preflight decides whether to engage; when it does, the guide
runs with its ask/answer routed through the CLI Host — the agent's text prints
as it streams (``on_text``), and each pre-action permission request is printed
and answered from the same stdin the Director uses (``can_use_tool``). We only
route the SDK's prompts; the SDK owns the ask/execute semantics.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from .cli_host import Host
from .guide import SetupGuide
from .harness import GuideCapable
from .music.preflight import PreflightResult, preflight_ytdlp

if TYPE_CHECKING:
    from claude_agent_sdk import (
        CanUseTool,
        PermissionResultAllow,
        PermissionResultDeny,
        ToolPermissionContext,
    )

_YES = ("y", "yes")
_END = ("", "/done", "/quit", "q")


def _cli_conversation(host: Host) -> Callable[[], Awaitable[str | None]]:
    """Read the user's next natural-language reply from the CLI Host. An empty
    line or /done|/quit ends the conversation (returns None)."""

    async def next_user_input() -> str | None:
        host.info("your reply (natural language; empty or /done to finish):")
        line = (await host.next_line()).strip()
        return None if line.lower() in _END else line

    return next_user_input


def _cli_permission(host: Host) -> CanUseTool:
    """Build a ``can_use_tool`` that asks the user via the CLI Host before each
    tool the guide wants to run, and returns the SDK's allow/deny result."""
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: ToolPermissionContext,
    ) -> PermissionResultAllow | PermissionResultDeny:
        detail = tool_input.get("command") or tool_input
        host.info(f"setup assistant wants to run [{tool_name}]: {detail}")
        host.info("allow? [y/N]")
        if (await host.next_line()).strip().lower() in _YES:
            return PermissionResultAllow()
        return PermissionResultDeny(message="user declined")

    return can_use_tool


async def run_music_setup(
    host: Host,
    brain: GuideCapable,
    *,
    ytdlp: str = "yt-dlp",
    venv_python: str | None = None,
    check: Callable[[str], Awaitable[PreflightResult]] = preflight_ytdlp,
) -> bool:
    """Preflight yt-dlp; if broken, offer the guide (routed through the CLI
    Host). Returns whether music is usable afterward. ``check`` is injectable
    for tests."""
    result = await check(ytdlp)
    if result.ok:
        return True

    host.info(f"music (yt-dlp) isn't working here: {result.reason}")
    host.info("type 'y' to let the setup assistant look into it (anything else skips):")
    if (await host.next_line()).strip().lower() not in _YES:
        host.info("skipped music setup.")
        return False

    await SetupGuide(brain).fix_music(
        ytdlp=ytdlp,
        venv_python=venv_python,
        can_use_tool=_cli_permission(host),
        on_text=host.info,
        next_user_input=_cli_conversation(host),
    )

    recheck = await check(ytdlp)
    host.info("music is working now." if recheck.ok else "music still isn't working.")
    return recheck.ok
