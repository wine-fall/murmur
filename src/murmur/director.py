"""Program Director — the loop (spec 01 §3.3).

The Director is the program: it decides and produces the next segment (L0:
always a talk segment), drives synth -> play, and paces with an inter-segment
gap. Arbitrating user interjections (cancel-and-resume) is spec 01 step 3; the
step-1 Director runs the autonomous talk loop only, which is what acceptance
criterion §5 requires (the loop runs end-to-end against a stub VoiceProvider).
"""

from __future__ import annotations

import asyncio

from .audio_player import AudioPlayer
from .brain import Brain
from .cli_host import CliHost
from .config import Config
from .contracts import ContextPack, MemoryStore, Turn, VoiceProvider


class Director:
    def __init__(
        self,
        *,
        config: Config,
        persona: str,
        brain: Brain,
        voice: VoiceProvider,
        player: AudioPlayer,
        memory: MemoryStore,
        cli_host: CliHost,
    ) -> None:
        self._config = config
        self._persona = persona
        self._brain = brain
        self._voice = voice
        self._player = player
        self._memory = memory
        self._cli = cli_host

    def _context(self) -> ContextPack:
        return ContextPack(
            persona=self._persona,
            recent=self._memory.recent(self._config.recent_window),
        )

    async def run(self, *, max_segments: int | None = None) -> None:
        """Run the autonomous talk loop.

        ``max_segments`` bounds the run for verification (run N segments then
        return cleanly); ``None`` runs until cancelled (Ctrl-C). The loop:
        build context -> next_talk -> synthesize -> play -> record -> gap.
        """
        produced = 0
        while max_segments is None or produced < max_segments:
            ctx = self._context()
            text = await self._brain.next_talk(ctx)
            self._cli.on_radio_segment(text)

            clip = await self._voice.synthesize(text)
            await self._player.play(clip)

            # Record only after the segment has been on air (spec 01 §3.3 step 5).
            self._memory.record(Turn("radio", text))
            produced += 1

            if max_segments is not None and produced >= max_segments:
                break

            # Inter-segment gap — a paced program, not a firehose (§3.4).
            # Cancellable: an interjection (step 3) or shutdown cuts it short.
            await asyncio.sleep(self._config.inter_segment_gap)
