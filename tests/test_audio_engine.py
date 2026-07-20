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


# --------------------------------------------------------------------------- #
# spec 03-04: the background bed channel
# --------------------------------------------------------------------------- #

from pathlib import Path  # noqa: E402


class FakeBedSource:
    """Scripted BedSource: returns local paths in play order (spec 03-04 §2.2)."""

    def __init__(self, names: list[str]) -> None:
        self._paths = [Path(n) for n in names]

    def tracks(self) -> list[Path]:
        return list(self._paths)


def _bed_engine(bed_value: float, song_value: float = 0.8, bed_frames: int = 100_000):
    """An engine wired so each source has a distinct constant value and a FRESH
    decoder per open (the bed feeder reopens tracks when it loops). Records
    every source the decoder factory was asked for."""
    opened: list[str] = []

    def decoder_factory(source: str) -> FakeDecoder:
        opened.append(source)
        # Music (play_music) uses fake://; bed uses the scripted paths.
        value = song_value if source.startswith("fake://") else bed_value
        frames = 400 if source.startswith("fake://") else bed_frames
        return FakeDecoder(value, frames)

    def voice_loader(source: str) -> np.ndarray:
        return np.full((400, _CH), 0.25, dtype=np.float32)

    eng = AudioEngine(
        decoder_factory=decoder_factory,
        voice_loader=voice_loader,
        sink_factory=None,
        samplerate=_SR,
        channels=_CH,
        blocksize=_BLOCK,
        ramp_s=_RAMP_S,
        duck_target=0.3,
        bed_gain=0.4,
        bed_xfade_s=_RAMP_S,  # tiny xfade so ramps settle within a block
    )
    return eng, opened


def test_bed_plays_under_talk_and_does_not_duck_per_voice():
    """Acceptance #1: with a non-empty BedSource the bed is mixed at the bed
    gain under talk, and (unlike the featured song) does NOT duck per voice."""

    async def go():
        eng, _ = _bed_engine(bed_value=0.5)
        await eng.start_bed(FakeBedSource(["a.wav"]))
        # Bed fades in to bed_gain: 0.5 * 0.4 = 0.2 under pure talk.
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        # A voice clip plays OVER the bed; the bed stays put (no pumping duck):
        # 0.2 (bed) + 0.25 (voice) = 0.45.
        voice_task = asyncio.ensure_future(eng.play(_talk_clip()))
        await _pump_until(eng, lambda b: np.allclose(b, 0.45))
        # Keep pumping: the voice drains, the bed remains at its steady gain
        # (it never ducked, so it returns straight to 0.2 with no dip).
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        await asyncio.wait_for(voice_task, 2.0)
        await eng.aclose()

    asyncio.run(go())


def test_bed_crossfades_out_under_the_song_and_back_when_it_ends():
    """Acceptance #2 (bed ramp): isolate the bed by making the song silent —
    output is bed-only, so we watch the bed gain ramp to 0 as the song starts
    and ramp back when it ends."""

    async def go():
        eng, _ = _bed_engine(bed_value=0.5, song_value=0.0)
        await eng.start_bed(FakeBedSource(["a.wav"]))
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))  # steady bed
        # Song starts (silent) -> bed crossfades out to 0.
        await eng.play_music(_music_clip())
        await _pump_until(eng, lambda b: np.allclose(b, 0.0))
        # Song is short (400 frames); drain it -> bed crossfades back in.
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        await eng.aclose()

    asyncio.run(go())


def test_song_crossfades_in_over_the_bed():
    """Acceptance #2 (song ramp): isolate the song by making the bed silent —
    output is song-only, and the song must ramp in from 0 (not hard-cut) while
    a bed is active."""

    async def go():
        eng, _ = _bed_engine(bed_value=0.0, song_value=0.8, bed_frames=100_000)
        await eng.start_bed(FakeBedSource(["a.wav"]))
        first = eng.render(_BLOCK)
        assert np.allclose(first, 0.0)  # silent bed, no song yet
        await eng.play_music(_music_clip())
        # The very next block after starting is NOT already at full gain: the
        # song fades in (born at 0), it does not hard-cut to 0.8.
        just_after = eng.render(_BLOCK)
        assert just_after[0, 0] < 0.8
        await _pump_until(eng, lambda b: np.allclose(b, 0.8))  # reaches full
        await eng.aclose()

    asyncio.run(go())


def test_bed_loops_seamlessly_with_no_silent_gap():
    """Acceptance #3: a bed shorter than the talk stretch crossfades into the
    next cached track (here itself) with no all-silent frame at the boundary."""

    async def go():
        # Short bed track (240 frames = 3 blocks) so we pump well past its end.
        eng, opened = _bed_engine(bed_value=0.5, bed_frames=240)
        await eng.start_bed(FakeBedSource(["a.wav"]))
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        # Pump many blocks (far more than one track) — the bed must never fall
        # to silence at the loop boundary.
        for _ in range(60):
            block = eng.render(_BLOCK)
            await asyncio.sleep(0.001)
            assert not np.allclose(block, 0.0), "bed went silent at a loop boundary"
        assert len(opened) > 1  # the feeder reopened the track to loop it
        await eng.aclose()

    asyncio.run(go())


def test_bed_streams_incrementally_without_waiting_for_track_end():
    """Regression (found by the real-boundary smoke): the feeder must STREAM —
    emit audio as it decodes, not decode the whole track first. A real bed track
    is a long (hour-scale) ambient piece; a load-fully feeder stays silent until
    EOF. An endless decoder never hits EOF, so the bed must still play."""

    class EndlessDecoder:
        def __init__(self) -> None:
            self.closed = False

        def read(self) -> np.ndarray | None:
            if self.closed:
                return None
            return np.full((160, _CH), 0.5, dtype=np.float32)  # never EOF

        def close(self) -> None:
            self.closed = True

    async def go():
        eng = AudioEngine(
            decoder_factory=lambda source: EndlessDecoder(),
            voice_loader=lambda s: np.full((160, _CH), 0.25, dtype=np.float32),
            sink_factory=None,
            samplerate=_SR,
            channels=_CH,
            blocksize=_BLOCK,
            ramp_s=_RAMP_S,
            bed_gain=0.4,
            bed_xfade_s=_RAMP_S,
        )
        await eng.start_bed(FakeBedSource(["endless.wav"]))
        # A never-ending track still yields bed audio (0.5 * 0.4 = 0.2).
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        await eng.aclose()

    asyncio.run(go())


def test_start_bed_reads_only_the_local_paths_no_network():
    """Acceptance #4: the runtime bed reads only the BedSource's local paths —
    the decoder factory is asked for exactly those, nothing else."""

    async def go():
        eng, opened = _bed_engine(bed_value=0.5, bed_frames=100_000)
        await eng.start_bed(FakeBedSource(["one.wav", "two.wav"]))
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        assert set(opened) <= {"one.wav", "two.wav"}
        await eng.aclose()

    asyncio.run(go())


def test_empty_bed_source_degrades_to_no_bed():
    """Acceptance #6: an empty BedSource -> no bed, the engine still renders."""

    async def go():
        eng, opened = _bed_engine(bed_value=0.5)
        await eng.start_bed(FakeBedSource([]))
        assert np.allclose(eng.render(_BLOCK), 0.0)  # no bed, silence
        assert opened == []  # nothing opened
        await eng.aclose()

    asyncio.run(go())


def test_a_bad_bed_track_does_not_crash_the_engine():
    """Acceptance #6: a bed track whose decoder fails is skipped; the engine
    keeps running (degrades, never crashes)."""

    async def go():
        def decoder_factory(source: str) -> FakeDecoder:
            raise RuntimeError(f"cannot open {source}")

        eng = AudioEngine(
            decoder_factory=decoder_factory,
            voice_loader=lambda s: np.full((400, _CH), 0.25, dtype=np.float32),
            sink_factory=None,
            samplerate=_SR,
            channels=_CH,
            blocksize=_BLOCK,
            ramp_s=_RAMP_S,
            bed_gain=0.4,
            bed_xfade_s=_RAMP_S,
        )
        await eng.start_bed(FakeBedSource(["bad.wav"]))
        # Every track dead -> bed degrades to silence, render still works.
        for _ in range(5):
            eng.render(_BLOCK)
            await asyncio.sleep(0.001)
        assert np.allclose(eng.render(_BLOCK), 0.0)
        await eng.aclose()

    asyncio.run(go())


def test_start_bed_is_idempotent():
    async def go():
        eng, opened = _bed_engine(bed_value=0.5, bed_frames=100_000)
        await eng.start_bed(FakeBedSource(["a.wav"]))
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        before = len(opened)
        await eng.start_bed(FakeBedSource(["b.wav"]))  # second call: no-op
        eng.render(_BLOCK)
        assert "b.wav" not in opened
        assert len(opened) == before
        await eng.aclose()

    asyncio.run(go())


def test_no_bed_task_outlives_the_engine():
    """Acceptance #7: aclose stops the bed feeder — no thread outlives it."""

    async def go():
        eng, _ = _bed_engine(bed_value=0.5, bed_frames=100_000)
        await eng.start_bed(FakeBedSource(["a.wav"]))
        await _pump_until(eng, lambda b: np.allclose(b, 0.2))
        assert eng._bed is not None
        thread = eng._bed._thread  # the feeder thread
        await eng.aclose()
        assert eng._bed is None
        assert not thread.is_alive()

    asyncio.run(go())
