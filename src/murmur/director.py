"""Program Director — the loop + interruption (spec 01 §3.3, forked by 03-02).

The Director is the program: at each segment boundary it consults the
``CadencePolicy`` (talk vs music, spec 03-02 §2.3), produces the segment,
paces with an inter-segment gap, and arbitrates typed interjections. There is
one arbiter (this loop), so the invariant holds: user turns take priority and
the engine is the only thing that emits sound.

Two interjection paths (spec 03-02 §3.5):
- **Talk segment** (spec 01, unchanged): a typed line cancels the on-air clip
  (``player.stop()`` — the voice channel), the Brain replies, the program
  resumes. Cancel-and-resume.
- **Music segment** (new): the song is NEVER stopped by a line. The loop races
  the handle's completion against the next typed line; a line gets its reply
  played OVER the still-playing music (``play`` auto-ducks), then the loop
  keeps awaiting the song. The song stops only on /quit/shutdown or when it
  ends naturally. Duck, not stop.

Music is optional wiring: without a ``music``+``cadence`` pair this is exactly
the spec-01 talk-only loop (the stub/test path).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Coroutine

from .audio_player import Player
from .brain import Brain
from .cadence import MUSIC, CadencePolicy, CadenceState
from .cli_host import Host
from .config import Config
from .contracts import AudioClip, ContextPack, MemoryStore, Turn, VoiceProvider
from .engine.core import MixingPlayer, MusicHandle
from .music.context import MusicContext
from .music.programmer import TrackSource
from .prompts import build_music_situation

# The UI keeps failures terse (one info line); the dev logfile (make dev /
# MURMUR_DEV_LOG) gets the full exception + traceback. No-op when unconfigured.
_log = logging.getLogger("murmur.director")

_QUIT_COMMAND = "/quit"


class Director:
    def __init__(
        self,
        *,
        config: Config,
        persona: str,
        brain: Brain,
        voice: VoiceProvider,
        player: Player,
        memory: MemoryStore,
        cli_host: Host,
        music: TrackSource | None = None,
        cadence: CadencePolicy | None = None,
    ) -> None:
        self._config: Config = config
        self._persona: str = persona
        self._brain: Brain = brain
        self._voice: VoiceProvider = voice
        self._player: Player = player
        self._memory: MemoryStore = memory
        self._cli: Host = cli_host
        self._quit: bool = False
        self._talks_since_music: int = 0
        self._music: TrackSource | None = music
        self._cadence: CadencePolicy | None = cadence
        self._mixing: MixingPlayer | None = None
        if music is not None:
            if not isinstance(player, MixingPlayer):
                raise ValueError("music wiring requires a player with play_music")
            self._mixing = player

    def _context(self) -> ContextPack:
        return ContextPack(
            persona=self._persona,
            recent=self._memory.recent(self._config.recent_window),
        )

    def _recent_lines(self) -> list[str]:
        return [
            f"{t.role}: {t.text}"
            for t in self._memory.recent(self._config.recent_window)
        ]

    async def run(self, *, max_segments: int | None = None) -> None:
        """Run the program: talk/music segments + typed interjections.

        ``max_segments`` bounds the run for verification (produce N segments
        then stop cleanly); ``None`` runs until ``/quit`` or Ctrl-C.
        """
        self._cli.start()
        produced = 0
        while not self._quit and (max_segments is None or produced < max_segments):
            line: str | None = None
            if await self._wants_music() and await self._play_music_segment():
                self._talks_since_music = 0
            else:
                line = await self._talk_segment()
                self._talks_since_music += 1
            produced += 1

            last = max_segments is not None and produced >= max_segments
            if line is None and not last and not self._quit:
                line = await self._sleep_interruptible(self._config.inter_segment_gap)

            # Handle interjection(s); a reply may itself be interrupted, so chain.
            while line is not None and not self._quit:
                line = await self._handle_user(line)

    # -- segments -------------------------------------------------------------

    async def _talk_segment(self) -> str | None:
        """One autonomous talk segment (spec 01). Returns an interrupting line."""
        ctx = self._context()
        text = await self._brain.next_talk(ctx)
        clip = await self._synthesize_or_skip(text)
        if clip is None:
            return None  # segment skipped; the loop keeps broadcasting
        # Printed at air time (when playback starts), not at generation time —
        # synthesis takes seconds and the text/audio gap read as a glitch.
        self._cli.on_radio_segment(text)
        line = await self._play_interruptible(clip)
        self._memory.record(Turn("radio", text))
        return line

    async def _synthesize_or_skip(self, text: str) -> AudioClip | None:
        """Synthesize with degradation: a TTS failure skips this one spoken
        segment (info line; nothing aired or recorded) instead of crashing the
        radio — same principle as the music branch's fallback. Found live: a
        single bad utterance used to unwind the whole loop."""
        try:
            return await self._voice.synthesize(text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._cli.info(f"voice synthesis failed ({exc}); skipping this segment.")
            _log.warning("voice synthesis failed; segment skipped", exc_info=exc)
            return None

    async def _wants_music(self) -> bool:
        if self._music is None or self._cadence is None:
            return False
        state = CadenceState(
            talks_since_music=self._talks_since_music,
            situation="\n".join(f"- {ln}" for ln in self._recent_lines()),
        )
        return await self._cadence.next_kind(state) == MUSIC

    async def _play_music_segment(self) -> bool:
        """Find, announce, and play one track (spec 03-02 §3.5 music branch).
        Returns False when nothing resolves or the machinery fails (the caller
        falls back to talk — a music error must never crash the radio)."""
        music, mixing = self._music, self._mixing
        assert music is not None and mixing is not None
        ctx = MusicContext(
            persona=self._persona,
            situation=build_music_situation(self._recent_lines()),
        )
        try:
            pick = await music.next_track(ctx)
            if pick is None:
                self._cli.info("music: nothing suitable found; back to talk.")
                return False

            announce_clip: AudioClip | None = None
            if pick.announce:
                # Synthesized before the song starts so the intro is ready to
                # ride the ducked head with no gap. A synthesis failure only
                # costs the intro, never the song.
                announce_clip = await self._synthesize_or_skip(pick.announce)

            handle = await mixing.play_music(pick.clip)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._cli.info(f"music segment failed ({exc}); back to talk.")
            _log.warning("music segment failed; fell back to talk", exc_info=exc)
            return False
        title = pick.clip.title or "music"
        artist = f" — {pick.clip.artist}" if pick.clip.artist else ""
        self._cli.info(f"now playing: {title}{artist}")

        # The announce is an on-air spoken segment like any other: it races
        # the next typed line (user turns take priority, spec 01) — cancelling
        # it only cuts the intro, the song underneath keeps playing.
        line: str | None = None
        if pick.announce and announce_clip is not None:
            self._cli.on_radio_segment(pick.announce)
            line = await self._play_interruptible(announce_clip)
            self._memory.record(Turn("radio", pick.announce))

        # Duck, not stop: lines during the song get replies OVER it; the song
        # is stopped only by /quit (or shutdown cancellation).
        if line is None:
            line = await self._race_song(handle)
        while line is not None and not self._quit:
            line = await self._handle_user(line)
            if line is None and not self._quit:
                line = await self._race_song(handle)
        if self._quit:
            await handle.stop()
        return True

    # -- interjection plumbing --------------------------------------------------

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
        clip = await self._synthesize_or_skip(reply)
        if clip is None:
            return None  # reply skipped; the user turn stays recorded
        self._cli.on_radio_segment(reply)
        interrupting = await self._play_interruptible(clip)
        self._memory.record(Turn("radio", reply))
        return interrupting

    async def _race_line(
        self, primary: Coroutine[Any, Any, object], *, stop_player: bool = False
    ) -> str | None:
        """The one race protocol: run ``primary`` against the next typed line.
        Returns the line if it arrived first (with ``stop_player`` cancelling
        the voice channel — the interjection), or None when ``primary`` ends."""
        primary_task = asyncio.ensure_future(primary)
        get_task = asyncio.ensure_future(self._cli.next_line())
        try:
            await asyncio.wait(
                {primary_task, get_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if get_task.done() and not get_task.cancelled():
                if stop_player:
                    await self._player.stop()
                return get_task.result()
            return None
        finally:
            await _settle(primary_task, get_task)

    async def _play_interruptible(self, clip: AudioClip) -> str | None:
        """Play ``clip``, racing it against the next typed line. ``stop()``
        targets the voice channel only, so over a music segment this cancels
        the reply/announce, never the song (spec 03-02 §3.5)."""
        return await self._race_line(self._player.play(clip), stop_player=True)

    async def _race_song(self, handle: MusicHandle) -> str | None:
        """Await the song's natural end vs the next typed line. Returns the
        line (song keeps playing), or None when it ended."""
        return await self._race_line(handle.wait())

    async def _sleep_interruptible(self, seconds: float) -> str | None:
        """Wait the inter-segment gap vs the next typed line."""
        return await self._race_line(asyncio.sleep(seconds))


async def _settle(*tasks: asyncio.Task[object]) -> None:
    """Cancel any still-pending tasks and await all of them, swallowing results
    and cancellations. Keeps the racing helpers free of leaked tasks even when
    the caller is cancelled (shutdown)."""
    for t in tasks:
        if not t.done():
            t.cancel()
    with contextlib.suppress(Exception):
        await asyncio.gather(*tasks, return_exceptions=True)
