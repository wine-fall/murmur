"""AudioEngine behavior (spec 03-02 §2.1/§3): fakes at the decoder/loader seams.

No sounddevice stream, no ffmpeg, no real audio: tests drive the mixing
callback by calling ``engine.render(n)`` directly (what the real sink's
callback does) and use a fake decoder / fake voice loader. Pins:
- music plays through the handle and completes on EOF (awaitable done),
- a voice clip AUTO-DUCKS live music and unducks after (one duck path,
  dispatched via the MusicHandle — proven with a fake ControlledHandle),
- stop() targets the voice channel (spec-01 interjection semantics),
- handle.stop()/aclose() tear down with no orphaned decoder, output silence,
- a starved/ended music buffer pads with silence (underrun policy).
"""

from __future__ import annotations

import asyncio

import numpy as np

from murmur.contracts import AudioClip
from murmur.engine.core import AudioEngine

_SR = 8_000
_CH = 2
_BLOCK = 80

# With ramp_s=0.005 at 8 kHz the ramp is 40 samples — after one 80-frame block
# the envelope sits at its target, so assertions on "held" blocks are exact.
_RAMP_S = 0.005


class FakeDecoder:
    """Yields ``blocks`` constant-valued frames then EOF; records close()."""

    def __init__(self, value: float, frames: int, chunk: int = 160) -> None:
        self._value = value
        self._left = frames
        self._chunk = chunk
        self.closed = False

    def read(self) -> np.ndarray | None:
        if self.closed or self._left <= 0:
            return None
        n = min(self._chunk, self._left)
        self._left -= n
        return np.full((n, _CH), self._value, dtype=np.float32)

    def close(self) -> None:
        self.closed = True


def _engine(decoder: FakeDecoder | None = None, voice_frames: int = 160):
    """An engine wired with fakes: no sink, fake decoder, fake voice loader."""
    made: list[FakeDecoder] = []

    def decoder_factory(source: str) -> FakeDecoder:
        d = decoder if decoder is not None else FakeDecoder(0.5, 400)
        made.append(d)
        return d

    def voice_loader(source: str) -> np.ndarray:
        return np.full((voice_frames, _CH), 0.25, dtype=np.float32)

    eng = AudioEngine(
        decoder_factory=decoder_factory,
        voice_loader=voice_loader,
        sink_factory=None,  # tests pump render() themselves
        samplerate=_SR,
        channels=_CH,
        blocksize=_BLOCK,
        ramp_s=_RAMP_S,
        duck_target=0.3,
    )
    return eng, made


async def _pump_until(engine: AudioEngine, predicate, timeout_s: float = 2.0):
    """Render blocks until ``predicate(block)`` is true; returns that block."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    while True:
        block = engine.render(_BLOCK)
        if predicate(block):
            return block
        if asyncio.get_event_loop().time() > deadline:
            raise AssertionError("condition not reached while pumping")
        await asyncio.sleep(0.001)


def _music_clip() -> AudioClip:
    return AudioClip(source="fake://track", kind="music")


def _talk_clip() -> AudioClip:
    return AudioClip(source="fake://talk", kind="talk")


def test_music_plays_at_full_gain_and_completes_on_eof():
    async def go():
        eng, _ = _engine(FakeDecoder(0.5, 400))
        handle = await eng.play_music(_music_clip())
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))
        # Drain to EOF: output falls back to silence and the handle completes.
        await _pump_until(eng, lambda b: np.allclose(b, 0.0))
        await asyncio.wait_for(handle.wait(), 1.0)
        await eng.aclose()

    asyncio.run(go())


def test_voice_auto_ducks_live_music_and_unducks_after():
    async def go():
        eng, _ = _engine(FakeDecoder(0.5, 100_000), voice_frames=400)
        await eng.play_music(_music_clip())
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))

        voice_task = asyncio.ensure_future(eng.play(_talk_clip()))
        # Ducked hold: music*0.3 + voice = 0.5*0.3 + 0.25 = 0.4.
        await _pump_until(eng, lambda b: np.allclose(b, 0.4))
        # Keep pumping: the voice drains, play() unducks, music ramps back.
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))
        await asyncio.wait_for(voice_task, 2.0)
        await eng.aclose()

    asyncio.run(go())


def test_voice_alone_plays_and_returns():
    async def go():
        eng, _ = _engine(voice_frames=200)
        voice_task = asyncio.ensure_future(eng.play(_talk_clip()))
        await _pump_until(eng, lambda b: np.allclose(b, 0.25))
        await _pump_until(eng, lambda b: np.allclose(b, 0.0))
        await asyncio.wait_for(voice_task, 1.0)
        await eng.aclose()

    asyncio.run(go())


def test_auto_duck_dispatches_through_the_music_handle_protocol():
    """Acceptance #6: a second mechanism (ControlledHandle) slots in without
    touching the mixer — the engine ducks whatever handle is live."""

    class FakeControlledHandle:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def duck(self) -> None:
            self.calls.append("duck")

        async def unduck(self) -> None:
            self.calls.append("unduck")

        async def stop(self) -> None:
            self.calls.append("stop")

        async def wait(self) -> None:
            pass

    async def go():
        eng, _ = _engine(voice_frames=100)
        fake = FakeControlledHandle()
        eng.adopt_handle(fake)  # a black-box player is now "the music"

        voice_task = asyncio.ensure_future(eng.play(_talk_clip()))
        await _pump_until(eng, lambda b: np.allclose(b, 0.25))
        await _pump_until(eng, lambda b: np.allclose(b, 0.0))
        await asyncio.wait_for(voice_task, 1.0)
        assert fake.calls == ["duck", "unduck"]
        await eng.aclose()

    asyncio.run(go())


def test_play_music_stops_an_adopted_external_handle_first():
    """Sole audio authority: starting our own track silences whatever external
    source was adopted for duck dispatch (review fix)."""

    class FakeControlledHandle:
        def __init__(self) -> None:
            self.stops = 0

        async def duck(self) -> None: ...

        async def unduck(self) -> None: ...

        async def stop(self) -> None:
            self.stops += 1

        async def wait(self) -> None: ...

    async def go():
        eng, _ = _engine(FakeDecoder(0.5, 400))
        external = FakeControlledHandle()
        eng.adopt_handle(external)
        await eng.play_music(_music_clip())
        assert external.stops == 1
        await eng.aclose()

    asyncio.run(go())


def test_voice_play_does_not_hang_when_the_sink_dies():
    """Dead-sink guard (review fix): if nothing pumps render(), play()
    returns after its timeout instead of freezing the radio forever."""

    async def go():
        eng, _ = _engine(voice_frames=160)  # 0.02 s of voice at 8 kHz
        eng._voice_timeout_margin_s = 0.05  # tight margin for the test
        await asyncio.wait_for(eng.play(_talk_clip()), 1.0)  # no pumping at all
        await eng.aclose()

    asyncio.run(go())


def test_stop_cancels_the_voice_channel_only():
    async def go():
        eng, _ = _engine(FakeDecoder(0.5, 100_000), voice_frames=100_000)
        await eng.play_music(_music_clip())
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))

        voice_task = asyncio.ensure_future(eng.play(_talk_clip()))
        await _pump_until(eng, lambda b: np.allclose(b, 0.4))
        await eng.stop()  # the interjection cancel — voice dies, music lives
        with contextlib_suppress_cancelled():
            await voice_task
        # Music is still playing and returns to full gain.
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))
        await eng.aclose()

    asyncio.run(go())


def test_cancelling_play_directly_propagates_and_unducks():
    """Shutdown path (carried over from the retired AudioPlayer's test):
    cancelling the play() TASK itself (not stop()) must propagate
    CancelledError to the caller, and play()'s cleanup must still unduck."""

    async def go():
        eng, _ = _engine(FakeDecoder(0.5, 100_000), voice_frames=100_000)
        await eng.play_music(_music_clip())
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))

        voice_task = asyncio.ensure_future(eng.play(_talk_clip()))
        await _pump_until(eng, lambda b: np.allclose(b, 0.4))
        voice_task.cancel()
        try:
            await voice_task
            raise AssertionError("play() swallowed CancelledError")
        except asyncio.CancelledError:
            pass
        # play()'s finally still ran: music unducks back to full gain.
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))
        await eng.aclose()

    asyncio.run(go())


def test_handle_stop_tears_down_decoder_and_silences():
    async def go():
        decoder = FakeDecoder(0.5, 100_000)
        eng, _ = _engine(decoder)
        handle = await eng.play_music(_music_clip())
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))
        await handle.stop()
        assert decoder.closed  # no orphaned decoder (acceptance #4)
        await asyncio.wait_for(handle.wait(), 1.0)
        await _pump_until(eng, lambda b: np.allclose(b, 0.0))
        await eng.aclose()

    asyncio.run(go())


def test_aclose_stops_everything_no_orphans():
    async def go():
        decoder = FakeDecoder(0.5, 100_000)
        eng, _ = _engine(decoder, voice_frames=100_000)
        handle = await eng.play_music(_music_clip())
        await _pump_until(eng, lambda b: np.allclose(b, 0.5))
        voice_task = asyncio.ensure_future(eng.play(_talk_clip()))
        await _pump_until(eng, lambda b: np.allclose(b, 0.4))

        await eng.aclose()
        assert decoder.closed
        with contextlib_suppress_cancelled():
            await voice_task
        await asyncio.wait_for(handle.wait(), 1.0)
        assert np.allclose(eng.render(_BLOCK), 0.0)

    asyncio.run(go())


def test_partial_final_block_pads_with_silence():
    """Underrun policy: a starved music buffer yields silence, not an error —
    here the track ends mid-block and the tail is zero-padded."""

    async def go():
        # 100 frames written atomically: one full 80-frame block, then a
        # boundary block of 20 music frames zero-padded to 80.
        eng, _ = _engine(FakeDecoder(0.5, 100, chunk=100))
        handle = await eng.play_music(_music_clip())
        block = await _pump_until(eng, lambda b: b[0].any() and not b[-1].any())
        assert np.allclose(block[:20], 0.5)
        assert np.allclose(block[20:], 0.0)
        await asyncio.wait_for(handle.wait(), 1.0)
        await eng.aclose()

    asyncio.run(go())


def contextlib_suppress_cancelled():
    import contextlib

    return contextlib.suppress(asyncio.CancelledError)
