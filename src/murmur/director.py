"""Program Director — the loop + interruption (spec 01 §3.3).

The Director is the program: it produces the next segment (L0: always a talk
segment), drives synth -> play, paces with an inter-segment gap, and arbitrates
typed interjections. There is one arbiter (this loop), so the invariant holds:
user turns take priority, only one segment is on air at a time, and the
AudioPlayer is the only thing that emits sound.

Interjection is cancel-and-resume (§3.3, the §6 open question, resolved): while
a segment (or the gap) is on air, the loop races it against the next typed line.
If a line arrives first, the current playback is stopped, the Brain replies in
persona, the reply is spoken, and then the program resumes.
"""

from __future__ import annotations

import asyncio
import contextlib

from .audio_player import AudioPlayer
from .brain import Brain
from .cli_host import CliHost
from .config import Config
from .contracts import AudioClip, ContextPack, MemoryStore, Turn, VoiceProvider

_QUIT_COMMAND = "/quit"


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
        self._config: Config = config
        self._persona: str = persona
        self._brain: Brain = brain
        self._voice: VoiceProvider = voice
        self._player: AudioPlayer = player
        self._memory: MemoryStore = memory
        self._cli: CliHost = cli_host
        self._quit: bool = False

    def _context(self) -> ContextPack:
        return ContextPack(
            persona=self._persona,
            recent=self._memory.recent(self._config.recent_window),
        )

    async def run(self, *, max_segments: int | None = None) -> None:
        """Run the program: autonomous talk loop + typed interjections.

        ``max_segments`` bounds the run for verification (produce N talk
        segments then stop cleanly); ``None`` runs until ``/quit`` or Ctrl-C.
        """
        self._cli.start()
        produced = 0
        while not self._quit and (max_segments is None or produced < max_segments):
            ctx = self._context()
            text = await self._brain.next_talk(ctx)
            self._cli.on_radio_segment(text)
            clip = await self._voice.synthesize(text)
            line = await self._play_interruptible(clip)
            self._memory.record(Turn("radio", text))
            produced += 1

            last = max_segments is not None and produced >= max_segments
            if line is None and not last:
                line = await self._sleep_interruptible(self._config.inter_segment_gap)

            # Handle interjection(s); a reply may itself be interrupted, so chain.
            while line is not None and not self._quit:
                line = await self._handle_user(line)

    async def _handle_user(self, line: str) -> str | None:
        """Process a typed line. Returns a line that interrupted the reply (so
        the caller can chain), or None. Sets ``_quit`` on ``/quit``."""
        if line.strip() == _QUIT_COMMAND:
            self._quit = True
            return None
        self._cli.on_user_line(line)
        self._memory.record(Turn("user", line))
        ctx = self._context()
        reply = await self._brain.respond(line, ctx)
        self._cli.on_radio_segment(reply)
        clip = await self._voice.synthesize(reply)
        interrupting = await self._play_interruptible(clip)
        self._memory.record(Turn("radio", reply))
        return interrupting

    async def _play_interruptible(self, clip: AudioClip) -> str | None:
        """Play ``clip``, racing it against the next typed line. Returns the
        interrupting line (playback stopped), or None if playback finished."""
        play_task = asyncio.ensure_future(self._player.play(clip))
        get_task = asyncio.ensure_future(self._cli.next_line())
        try:
            await asyncio.wait({play_task, get_task}, return_when=asyncio.FIRST_COMPLETED)
            if get_task.done() and not get_task.cancelled():
                await self._player.stop()  # cancel current playback (interjection)
                return get_task.result()
            return None
        finally:
            await _settle(play_task, get_task)

    async def _sleep_interruptible(self, seconds: float) -> str | None:
        """Wait the inter-segment gap, racing it against the next typed line.
        Returns the interrupting line, or None if the gap elapsed."""
        sleep_task: asyncio.Task[None] = asyncio.ensure_future(asyncio.sleep(seconds))
        get_task = asyncio.ensure_future(self._cli.next_line())
        try:
            await asyncio.wait({sleep_task, get_task}, return_when=asyncio.FIRST_COMPLETED)
            if get_task.done() and not get_task.cancelled():
                return get_task.result()
            return None
        finally:
            await _settle(sleep_task, get_task)


async def _settle(*tasks: asyncio.Task[object]) -> None:
    """Cancel any still-pending tasks and await all of them, swallowing results
    and cancellations. Keeps the racing helpers free of leaked tasks even when
    the caller is cancelled (shutdown)."""
    for t in tasks:
        if not t.done():
            t.cancel()
    with contextlib.suppress(Exception):
        await asyncio.gather(*tasks, return_exceptions=True)
