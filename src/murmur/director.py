"""Program Director — the loop + interruption (spec 01 §3.3, forked by 03-02).

The Director is the program: at each segment boundary it consults the
``CadencePolicy`` (talk vs music, spec 03-02 §2.3), produces the segment,
paces with an inter-segment gap, and arbitrates typed interjections. There is
one arbiter (this loop), so the invariant holds: user turns take priority and
the engine is the only thing that emits sound.

Interjection is **prepare-then-barge-in** (spec 01 §3.3): a typed line is a
``Steer``; the current audio keeps playing while the Brain composes the reply
and the voice synthesizes it, and only when the reply clip is ready does the
loop cut over — so an interjection never opens a dead-air gap. A line that lands
while the Brain is still composing is **merged** into the one reply. All steer
handling funnels through one method (``_run_voice`` + ``_compose``), so there is
no per-segment-kind duplication.

Two barge-in targets (spec 03-02 §3.5):
- **Talk / voice clip**: the ready reply cuts the on-air voice clip
  (``player.stop()`` — the voice channel) and becomes the new voice clip.
- **Music segment**: the song is NEVER stopped by a line. The reply airs OVER
  the still-playing song (``play`` auto-ducks); the loop then keeps awaiting the
  song. The song stops only on /quit/shutdown or when it ends naturally.

Music is optional wiring: without a ``music``+``cadence`` pair this is exactly
the spec-01 talk-only loop (the stub/test path).
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Any, Literal

from .brain import Brain
from .cadence import MUSIC, CadencePolicy, CadenceState
from .cli_host import Host
from .config import Config
from .logging_setup import get_log
from .contracts import (
    AudioClip,
    ContextPack,
    MemoryStore,
    Player,
    Turn,
    VoiceProvider,
)
from .engine.core import MixingPlayer, MusicHandle
from .music.context import MusicContext
from .music.programmer import TrackSource
from .prompts import build_music_situation

# The UI keeps failures terse (one info line); the dev logfile (make dev /
# MURMUR_DEV_LOG) gets the full exception + traceback. No-op when unconfigured.
_log = get_log("director")

_QUIT_COMMAND = "/quit"

SteerIntent = Literal["quit", "talkback"]


@dataclass(frozen=True)
class Steer:
    """A typed user interrupt, first-class (spec 01 §3.3).

    Consolidates the former scattered ``str | None`` "interrupting line": the
    race helpers return ``Steer | None``, and one Director path handles it. The
    ``intent`` is the extension point for future commands (``/skip``, …); L0
    knows only ``quit`` (``/quit``) and ``talkback`` (everything else)."""

    text: str
    intent: SteerIntent

    @classmethod
    def from_line(cls, line: str) -> "Steer":
        intent: SteerIntent = "quit" if line.strip() == _QUIT_COMMAND else "talkback"
        return cls(text=line, intent=intent)


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
            if await self._wants_music() and await self._play_music_segment():
                self._talks_since_music = 0
            else:
                await self._talk_segment()
                self._talks_since_music += 1
            produced += 1

            last = max_segments is not None and produced >= max_segments
            if not last and not self._quit:
                await self._gap()

    # -- segments -------------------------------------------------------------

    async def _talk_segment(self) -> None:
        """One autonomous talk segment (spec 01), then arbitrate any steers."""
        ctx = self._context()
        with _log.timed("talk") as t:
            text = await self._brain.next_talk(ctx)
            t["chars"] = len(text)
        clip = await self._synthesize_or_skip(text)
        if clip is None:
            return  # segment skipped; the loop keeps broadcasting
        # Printed + recorded at air time (when playback starts): synthesis takes
        # seconds and a text/audio gap reads as a glitch; recording it now means
        # an interjection's reply sees this segment in context.
        self._cli.on_radio_segment(text)
        self._memory.record(Turn("radio", text))
        await self._run_voice(asyncio.ensure_future(self._player.play(clip)))

    async def _gap(self) -> None:
        """Inter-segment pause, steerable. A line during the gap gets its reply;
        the gap is not resumed afterward (the program moves to the next segment)."""
        sleep = asyncio.ensure_future(asyncio.sleep(self._config.inter_segment_gap))
        steer = await self._race(sleep)
        await _settle(sleep)
        if steer is not None:
            await self._run_voice(None, steer=steer)

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
            _log.warn("voice synthesis failed; segment skipped", exc=exc)
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
            with _log.timed("music.pick") as t:
                pick = await music.next_track(ctx)
                t["found"] = pick is not None
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
            _log.warn("music segment failed; fell back to talk", exc=exc)
            return False
        title = pick.clip.title or "music"
        artist = f" — {pick.clip.artist}" if pick.clip.artist else ""
        self._cli.info(f"now playing: {title}{artist}")

        # The announce is an on-air voice clip; a steer cuts it (voice channel),
        # never the song. Recorded at air time so a reply sees it in context.
        voice: asyncio.Future[None] | None = None
        if pick.announce and announce_clip is not None:
            self._cli.on_radio_segment(pick.announce)
            self._memory.record(Turn("radio", pick.announce))
            voice = asyncio.ensure_future(self._player.play(announce_clip))

        # Duck, not stop: replies air OVER the song; the song stops only on
        # /quit (handled inside _run_voice) or shutdown cancellation.
        await self._run_voice(voice, song=handle)
        return True

    # -- steer arbitration (one path for every segment kind) -------------------

    async def _run_voice(
        self,
        voice: asyncio.Future[None] | None,
        *,
        song: MusicHandle | None = None,
        steer: Steer | None = None,
    ) -> None:
        """The single steer-arbitration loop (spec 01 §3.3 + 03-02 §3.5).

        Races the current on-air voice clip ``voice`` (a talk segment, a music
        intro, or a reply — may be ``None``) and, when idle, the persistent
        ``song``, against the next typed line. A talkback steer composes a reply
        while the current audio keeps playing (prepare-then-barge-in), then cuts
        over: the reply replaces the voice clip (``player.stop()`` — never the
        song) and becomes the new voice clip. Returns when the voice channel is
        idle and the song (if any) has ended, or on ``/quit`` — on which it also
        stops a still-playing song on the way out. An initial ``steer`` seeds the
        loop (the gap path, where nothing is yet on air)."""
        song_task = asyncio.ensure_future(song.wait()) if song is not None else None
        try:
            while not self._quit:
                if steer is None:
                    current = voice if voice is not None and not voice.done() else None
                    if current is None and song_task is not None and not song_task.done():
                        current = song_task
                    if current is None:
                        return  # voice idle and no live song -> segment over
                    steer = await self._race(current)
                    if steer is None:
                        if current is song_task:
                            return  # song ended -> segment over
                        voice = None  # voice clip ended; re-evaluate / finish
                        continue
                if steer.intent == "quit":
                    self._quit = True
                    return
                reply, clip = await self._compose(steer)
                steer = None
                if self._quit:  # a merged-in line was /quit
                    return
                if clip is None:
                    continue  # reply synthesis failed; keep racing current audio
                if voice is not None and not voice.done():
                    await self._player.stop()  # barge-in: cut the voice clip only
                await _settle(voice)
                self._cli.on_radio_segment(reply)
                self._memory.record(Turn("radio", reply))
                voice = asyncio.ensure_future(self._player.play(clip))
        finally:
            await _settle(voice, song_task)
            # /quit while a song is playing: stop it on the way out (the song is
            # never cut by an interjection, only by quit/shutdown — spec 03-02).
            if self._quit and song is not None:
                await song.stop()

    async def _race(self, current: asyncio.Future[Any]) -> Steer | None:
        """Race a live on-air activity against the next typed line. Returns the
        ``Steer`` if the user typed first (``current`` left running — the caller
        owns its lifecycle), or ``None`` when ``current`` ended. A typed line
        wins a tie (user turns take priority)."""
        get = asyncio.ensure_future(self._cli.next_line())
        try:
            await asyncio.wait({current, get}, return_when=asyncio.FIRST_COMPLETED)
            if get.done() and not get.cancelled():
                return Steer.from_line(get.result())
            return None
        finally:
            await _settle(get)

    async def _compose(self, steer: Steer) -> tuple[str, AudioClip | None]:
        """Compose + synthesize the reply to ``steer``, merging any line that
        lands *before the reply clip is ready* into one combined reply (spec 01
        §3.3) — the whole prepare (Brain compose + synthesis) races the next
        typed line, so fresh input supersedes work in flight until the clip
        lands. Echoes + records each user turn. Returns ``(reply, clip)``;
        ``clip`` is ``None`` if synthesis failed. Sets ``_quit`` (returns
        ``("", None)``) if a merged-in line is ``/quit``.

        A merged-away prepare is discarded mid-flight; the wasted Brain/synth
        call is the cost of merge-anytime, and merges are rare (a second line
        within the prepare window). ``FakeBrain`` records only after its delay,
        so a compose-window discard leaves no trace in tests."""
        texts = [steer.text]
        self._cli.on_user_line(steer.text)
        self._memory.record(Turn("user", steer.text))
        while True:
            prep = asyncio.ensure_future(self._prepare_reply(texts))
            get = asyncio.ensure_future(self._cli.next_line())
            try:
                await asyncio.wait({prep, get}, return_when=asyncio.FIRST_COMPLETED)
                if get.done() and not get.cancelled():
                    await _settle(prep)  # discard the in-flight reply; recompose
                    merged = Steer.from_line(get.result())
                    if merged.intent == "quit":
                        self._quit = True
                        return "", None
                    texts.append(merged.text)
                    self._cli.on_user_line(merged.text)
                    self._memory.record(Turn("user", merged.text))
                    continue
                return prep.result()
            finally:
                await _settle(get)

    async def _prepare_reply(self, texts: list[str]) -> tuple[str, AudioClip | None]:
        """Compose + synthesize one reply over the accumulated user text.
        Cancellable: if a fresh line arrives before the clip is ready this is
        torn down mid-flight, so the synth backend must survive cancellation
        (the sidecar kills its now-desynced process; the remote drops the
        in-flight HTTP result)."""
        reply = await self._brain.respond("\n".join(texts), self._context())
        return reply, await self._synthesize_or_skip(reply)


async def _settle(*tasks: asyncio.Future[Any] | None) -> None:
    """Cancel any still-pending tasks and await all of them, swallowing results
    and cancellations (``None`` entries are ignored). Keeps the racing helpers
    free of leaked tasks even when the caller is cancelled (shutdown)."""
    live = [t for t in tasks if t is not None]
    for t in live:
        if not t.done():
            t.cancel()
    with contextlib.suppress(Exception):
        await asyncio.gather(*live, return_exceptions=True)
