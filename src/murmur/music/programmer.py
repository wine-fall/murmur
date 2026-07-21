"""MusicProgrammer — the Director-facing find-and-pull entry (spec 03-01 §2.4/§3.2).

Runs the harnessed brain (``Harness.run_task``) over the music tools and a
rendered context, and returns the resolved ``AudioClip`` (or None). It finds and
pulls a track — it does not play, schedule, or announce it (that is spec 03-02).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from ..contracts import AudioClip, MusicProvider
from ..harness import BrainTool, Harness
from ..prompts import build_find_music_instruction
from .context import MusicContext, render_context
from .tools import SearchMusicTool, StreamProbe, SubmitPickTool, parse_submit_success

_DEFAULT_MAX_TURNS = 6


@dataclass(frozen=True)
class TrackPick:
    """One found-and-pulled track (spec 03-01 §2.4, widened by 03-02): the
    playable clip (with title/artist display metadata when the task supplied
    them) plus the one-line in-persona DJ intro to speak over its ducked head
    (None -> no intro)."""

    clip: AudioClip
    announce: str | None = None


@runtime_checkable
class TrackSource(Protocol):
    """What the Director consumes (spec 03-01 §2.4 seam): find + pull one
    track. ``MusicProgrammer`` is the real impl; tests inject a fake."""

    async def next_track(self, ctx: MusicContext) -> "TrackPick | None": ...


class MusicProgrammer:
    def __init__(
        self,
        *,
        brain: Harness,
        provider: MusicProvider,
        model: str,
        max_turns: int = _DEFAULT_MAX_TURNS,
        instruction: str | None = None,
        probe: StreamProbe | None = None,
    ) -> None:
        self._brain: Harness = brain
        self._provider: MusicProvider = provider
        self._model: str = model
        self._max_turns: int = max_turns
        self._instruction: str = (
            instruction if instruction is not None else build_find_music_instruction()
        )
        # The tool set is fixed (the provider never changes) — build it once. The
        # probe (spec 04) validates each resolved stream in submit_pick, so a dead
        # 403 stream is retried away here at pull time (the model picks another,
        # overlapping talk) rather than surfacing as a silent skip at playback.
        self._tools: list[BrainTool] = [
            SearchMusicTool(provider),
            SubmitPickTool(provider, probe=probe),
        ]

    async def next_track(self, ctx: MusicContext) -> TrackPick | None:
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
        # Validate the opaque terminal result into a typed pick (or None). The
        # shape is defined and checked in one place (music.tools), so field
        # access below is type-safe rather than a trusted string-key guess.
        pick = parse_submit_success(result)
        if pick is None:
            return None
        clip = AudioClip(
            source=pick["source"],
            kind=pick["kind"],
            title=pick["title"],
            artist=pick["artist"],
        )
        return TrackPick(clip=clip, announce=pick["announce"])
