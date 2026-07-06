"""The guide harness — setup/repair, harnessing the native Claude Code agent.

This does NOT build an agent. Claude Code IS the agent; this shapes it with a
careful persona + its built-in tools (via ``GuideCapable.run_guide``) so it can
diagnose why a murmur dependency is broken in the user's environment and fix it
conversationally. First use: repair the yt-dlp music dependency (e.g. add a
corporate proxy's CA so TLS verification passes).
"""

from __future__ import annotations

import sys
from collections.abc import Awaitable, Callable
from typing import Any

from .harness import GuideCapable
from .prompts.guide import GUIDE_PERSONA, build_fix_music_prompt

_DEFAULT_MODEL = "claude-opus-4-8"  # repair is judgment-heavy + occasional
_DEFAULT_MAX_TURNS = 30


class SetupGuide:
    def __init__(
        self,
        brain: GuideCapable,
        *,
        model: str = _DEFAULT_MODEL,
        max_turns: int = _DEFAULT_MAX_TURNS,
    ) -> None:
        self._brain: GuideCapable = brain
        self._model: str = model
        self._max_turns: int = max_turns

    async def fix_music(
        self,
        *,
        ytdlp: str = "yt-dlp",
        ffmpeg: str = "ffmpeg",
        reason: str = "",
        venv_python: str | None = None,
        permission_mode: str = "default",
        can_use_tool: Any = None,
        on_text: Callable[[str], None] | None = None,
        next_user_input: Callable[[], Awaitable[str | None]] | None = None,
    ) -> str:
        """Diagnose + repair the music dependencies (yt-dlp + ffmpeg) in one
        session; returns the plain-
        language explanation of what was wrong and what changed. ``can_use_tool``
        gates actions, ``on_text`` streams text, and ``next_user_input`` supplies
        the user's natural-language replies (a real conversation via the CLI Host)."""
        prompt = build_fix_music_prompt(
            ytdlp=ytdlp,
            ffmpeg=ffmpeg,
            reason=reason,
            venv_python=venv_python or sys.executable,
        )
        return await self._brain.run_guide(
            GUIDE_PERSONA,
            prompt,
            model=self._model,
            max_turns=self._max_turns,
            permission_mode=permission_mode,
            can_use_tool=can_use_tool,
            on_text=on_text,
            next_user_input=next_user_input,
        )
