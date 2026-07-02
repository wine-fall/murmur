"""MusicProgrammer — the Director-facing find-and-pull entry (spec 03-01 §2.4/§3.2).

Runs the harnessed brain (``Harness.run_task``) over the music tools and a
rendered context, and returns the resolved ``AudioClip`` (or None). It finds and
pulls a track — it does not play, schedule, or announce it (that is spec 03-02).
"""

from __future__ import annotations

from ..contracts import AudioClip, MusicProvider
from ..harness import BrainTool, Harness
from ..prompts import build_find_music_instruction
from .context import MusicContext, render_context
from .tools import SearchMusicTool, SubmitPickTool

_DEFAULT_MAX_TURNS = 6


class MusicProgrammer:
    def __init__(
        self,
        *,
        brain: Harness,
        provider: MusicProvider,
        model: str,
        max_turns: int = _DEFAULT_MAX_TURNS,
        instruction: str | None = None,
    ) -> None:
        self._brain: Harness = brain
        self._provider: MusicProvider = provider
        self._model: str = model
        self._max_turns: int = max_turns
        self._instruction: str = (
            instruction if instruction is not None else build_find_music_instruction()
        )
        # The tool set is fixed (the provider never changes) — build it once.
        self._tools: list[BrainTool] = [
            SearchMusicTool(provider),
            SubmitPickTool(provider),
        ]

    async def next_track(self, ctx: MusicContext) -> AudioClip | None:
        """Find and pull one track for ``ctx``; None if nothing suitable resolves."""
        system_prompt, situation_block = render_context(ctx)
        prompt = f"{self._instruction}\n\n{situation_block}"
        result = await self._brain.run_task(
            system_prompt,
            prompt,
            tools=self._tools,
            model=self._model,
            max_turns=self._max_turns,
        )
        if not result or not result.get("ok"):
            return None
        source = result.get("source")
        if not source:
            return None
        return AudioClip(source=str(source), kind=str(result.get("kind", "music")))
