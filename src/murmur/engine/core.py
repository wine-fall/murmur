"""The mixing engine core (spec 03-02 §2.1/§3.1): handles, buffers, auto-duck.

The engine is the sole audio authority with two logical channels. Music PCM is
fed by a decoder (real: ffmpeg — spawned per track, torn down with it) through
a ring buffer; a voice clip is a short PCM array played on top. The mixing
callback (``render``) runs on the sink's audio thread and only does numpy math
(mixer.py); everything async happens on the event loop and crosses over via
``call_soon_threadsafe``.

Ducking is ONE path: ``play(voice)`` ducks whatever ``MusicHandle`` is live —
the ``MixedHandle`` here ducks the engine's gain envelope; a future
``ControlledHandle`` (black-box player) would issue a volume command instead —
the engine never special-cases the mechanism (spec §2.2).
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
from pathlib import Path
from typing import Any, Callable, Protocol, TypeAlias, runtime_checkable

import numpy as np

from ..contracts import AudioClip, Player
from ..logging_setup import get_log
from .mixer import (
    BED_GAIN,
    BED_XFADE_S,
    DUCK_TARGET,
    FULL_GAIN,
    RAMP_S,
    GainEnvelope,
    crossfade,
    mix,
)

_log = get_log("engine")

# One float32 PCM block. numpy cannot express a fixed shape, so the shape
# parameter stays ``Any`` — but the dtype is pinned and the alias names the
# contract, so nothing in the engine falls back to a bare ``Any``.
_Block: TypeAlias = "np.ndarray[Any, np.dtype[np.float32]]"


@runtime_checkable
class Decoder(Protocol):
    """One track's PCM source (real: an ffmpeg subprocess pipe). ``read``
    blocks until it has a chunk of (frames, channels) float32 at the engine's
    rate, and returns None at end-of-stream. ``close`` must unblock a pending
    read and be idempotent (it is the teardown path)."""

    def read(self) -> _Block | None: ...

    def close(self) -> None: ...


@runtime_checkable
class Sink(Protocol):
    """The one output stream (real: sounddevice). Constructed by a factory
    ``(render, samplerate, channels, blocksize) -> Sink`` already started;
    calls ``render(frames)`` from its audio thread for every block."""

    def close(self) -> None: ...


@runtime_checkable
class MusicHandle(Protocol):
    """The duck seam (spec 03-02 §2.2): one intent, any mechanism."""

    async def duck(self) -> None: ...

    async def unduck(self) -> None: ...

    async def stop(self) -> None: ...

    async def wait(self) -> None: ...


@runtime_checkable
class MixingPlayer(Player, Protocol):
    """The player capability the Director's music branch needs (spec §2.1):
    the spec-01 ``Player`` surface plus ``play_music``. ``AudioEngine`` is the
    real impl; tests inject a fake."""

    async def play_music(self, clip: AudioClip) -> MusicHandle: ...


@runtime_checkable
class BedSource(Protocol):
    """The cached local bed tracks (spec 03-04 §2.2), in play order (empty ->
    no bed). Local files only: resolving/pulling happened at first-run loading,
    never on the audio path — no network at this seam."""

    def tracks(self) -> list[Path]: ...


class _Ring:
    """Thread-safe float32 frame ring: feeder thread writes, audio thread reads."""

    def __init__(self, capacity: int, channels: int) -> None:
        self._buf: _Block = np.zeros((capacity, channels), dtype=np.float32)
        self._capacity = capacity
        self._lock = threading.Lock()
        self._read = 0
        self._count = 0

    @property
    def count(self) -> int:
        with self._lock:
            return self._count

    def write(self, block: _Block) -> int:
        """Copy in up to ``len(block)`` frames; returns how many fit."""
        with self._lock:
            n = min(len(block), self._capacity - self._count)
            if n == 0:
                return 0
            start = (self._read + self._count) % self._capacity
            first = min(n, self._capacity - start)
            self._buf[start : start + first] = block[:first]
            if n > first:
                self._buf[: n - first] = block[first:n]
            self._count += n
            return n

    def read_into(self, out: _Block, frames: int) -> int:
        """Copy out up to ``frames`` frames; returns how many were available."""
        with self._lock:
            n = min(frames, self._count)
            if n:
                first = min(n, self._capacity - self._read)
                out[:first] = self._buf[self._read : self._read + first]
                if n > first:
                    out[first:n] = self._buf[: n - first]
                self._read = (self._read + n) % self._capacity
                self._count -= n
            return n

    def clear(self) -> None:
        with self._lock:
            self._read = 0
            self._count = 0


class MixedHandle:
    """The PCM/own-mixer duck mechanism (spec §2.2): a feeder thread pulls the
    decoder into the engine's music ring; duck/unduck drive the engine's gain
    envelope. ``wait`` completes when the track ends naturally or is stopped."""

    def __init__(
        self,
        *,
        decoder: Decoder,
        ring: _Ring,
        set_gain_target: Callable[[float], None],
        duck_target: float,
        loop: asyncio.AbstractEventLoop,
        on_finished: Callable[["MixedHandle"], None],
    ) -> None:
        self._decoder = decoder
        self._ring = ring
        self._set_gain_target = set_gain_target
        self._duck_target = duck_target
        self._loop = loop
        self._on_finished = on_finished
        self._done = asyncio.Event()
        self._stopping = threading.Event()
        self._eof = threading.Event()
        self._finished = False  # loop-thread only
        self._thread = threading.Thread(target=self._feed, daemon=True)

    def start(self) -> None:
        self._thread.start()

    # -- feeder thread ------------------------------------------------------
    def _feed(self) -> None:
        try:
            while not self._stopping.is_set():
                try:
                    block = self._decoder.read()
                except Exception:
                    break  # a dying decoder ends the track, not the radio
                if block is None:
                    break
                offset = 0
                while offset < len(block) and not self._stopping.is_set():
                    offset += self._ring.write(block[offset:])
                    if offset < len(block):
                        time.sleep(0.002)  # ring full — backpressure
        finally:
            self._eof.set()
            with contextlib.suppress(Exception):
                self._decoder.close()

    # -- audio-thread hooks (called by the engine's render) ------------------
    def drained(self) -> bool:
        return self._eof.is_set() and self._ring.count == 0

    def signal_finished(self) -> None:
        self._loop.call_soon_threadsafe(self._finish)

    # -- loop thread ---------------------------------------------------------
    def _finish(self) -> None:
        if not self._finished:
            self._finished = True
            self._done.set()
            self._on_finished(self)

    async def duck(self) -> None:
        self._set_gain_target(self._duck_target)

    async def unduck(self) -> None:
        self._set_gain_target(FULL_GAIN)

    async def stop(self) -> None:
        self._stopping.set()
        with contextlib.suppress(Exception):
            self._decoder.close()  # unblocks a pending read
        if self._thread.is_alive():
            await asyncio.to_thread(self._thread.join, 2.0)
        self._ring.clear()
        self._finish()

    async def wait(self) -> None:
        await self._done.wait()


class _BedFeeder:
    """Feeds the bed ring (spec 03-04 §3.1): streams each cached track through
    the decoder, crossfades track->track (and a single track into itself) so the
    backdrop loops gap-free, and rotates the list forever until stopped. A
    bad/empty track is skipped; if no track yields audio the bed degrades to
    silence. Local files only — the source paths are handed straight to the
    decoder factory, never resolved over the network.

    Streaming (not load-fully): the real bed tracks are long ambient pieces, so
    we emit blocks as they decode and hold back only the last ``xfade`` samples
    as the tail to crossfade into the next track. Memory stays bounded to ~one
    crossfade window, and the ring fills immediately instead of after the whole
    (possibly hour-long) track decodes.
    """

    def __init__(
        self,
        *,
        bed: BedSource,
        ring: _Ring,
        decoder_factory: Callable[[str], Decoder],
        xfade_samples: int,
        channels: int,
    ) -> None:
        self._sources = [str(p) for p in bed.tracks()]
        self._ring = ring
        self._decoder_factory = decoder_factory
        self._xfade = max(1, xfade_samples)
        self._channels = channels
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._feed, daemon=True)

    def start(self) -> None:
        self._thread.start()

    async def stop(self) -> None:
        self._stopping.set()
        if self._thread.is_alive():
            await asyncio.to_thread(self._thread.join, 2.0)

    def _write(self, block: _Block) -> None:
        offset = 0
        while offset < len(block) and not self._stopping.is_set():
            offset += self._ring.write(block[offset:])
            if offset < len(block):
                time.sleep(0.002)  # ring full — backpressure paces the feeder

    def _stream_track(self, source: str, carry: _Block | None) -> _Block | None:
        """Stream one track to the ring, crossfading its head against ``carry``
        (the previous track's tail). Returns this track's tail (held back, to
        crossfade into the next track), or None on open failure / empty track."""
        try:
            decoder = self._decoder_factory(source)
        except Exception:
            return None
        xf = self._xfade
        # Prime the buffer with the carry so the first xf samples crossfade it.
        hold: _Block = (
            carry
            if carry is not None
            else np.zeros((0, self._channels), dtype=np.float32)
        )
        need_fade = carry is not None
        try:
            while not self._stopping.is_set():
                block = decoder.read()
                if block is None:
                    break
                hold = np.concatenate((hold, block))  # pyright: ignore[reportUnknownMemberType]
                if need_fade:
                    if len(hold) < 2 * xf:
                        continue  # still collecting carry-tail + this-head
                    self._write(crossfade(hold[:xf], hold[xf : 2 * xf]))
                    hold = hold[2 * xf :]
                    need_fade = False
                if len(hold) > xf:  # emit all but the trailing xf (potential tail)
                    self._write(hold[:-xf])
                    hold = hold[-xf:]
        except Exception:
            pass  # a dying decoder ends this track, not the bed
        finally:
            with contextlib.suppress(Exception):
                decoder.close()
        if need_fade:
            # Track shorter than a crossfade window: flush what we have (carry +
            # the stub track), no clean tail to carry forward. Rare, and only for
            # a sub-xfade track — a tiny seam, never a crash.
            if len(hold):
                self._write(hold)
            return None
        return hold if len(hold) else None

    def _feed(self) -> None:
        if not self._sources:
            return
        carry: _Block | None = None  # tail of the previous track, awaiting xfade
        idx = 0
        misses = 0
        while not self._stopping.is_set():
            source = self._sources[idx % len(self._sources)]
            idx += 1
            tail = self._stream_track(source, carry)
            if tail is None and carry is not None:
                carry = None  # its carry was flushed inside; start the next fresh
            if tail is None:
                misses += 1
                if misses >= len(self._sources):
                    return  # every track dead this pass -> degrade to no bed
                continue
            misses = 0
            carry = tail


class AudioEngine:
    """Sole audio authority (spec 03-02 §2.1): music + voice, mixed, ducked.

    Implements the spec-01 ``Player`` seam (``play``/``stop`` keep interjection
    semantics, voice channel only) and adds ``play_music`` -> ``MusicHandle``.
    ``render`` is the mixing callback the sink drives; tests drive it directly.
    """

    def __init__(
        self,
        *,
        decoder_factory: Callable[[str], Decoder],
        voice_loader: Callable[[str], _Block],
        sink_factory: (
            Callable[[Callable[[int], _Block], int, int, int], Sink] | None
        ) = None,
        samplerate: int = 48_000,
        channels: int = 2,
        blocksize: int = 1_024,
        duck_target: float = DUCK_TARGET,
        ramp_s: float = RAMP_S,
        music_buffer_s: float = 4.0,
        voice_timeout_margin_s: float = 5.0,
        bed_gain: float = BED_GAIN,
        bed_xfade_s: float = BED_XFADE_S,
    ) -> None:
        self._decoder_factory = decoder_factory
        self._voice_loader = voice_loader
        self._sink_factory = sink_factory
        self._samplerate = samplerate
        self._channels = channels
        self._blocksize = blocksize
        self._duck_target = duck_target
        self._ramp_s = ramp_s
        self._voice_timeout_margin_s = voice_timeout_margin_s
        self._bed_gain = bed_gain
        self._bed_xfade_s = bed_xfade_s
        self._sink: Sink | None = None
        # Scratch buffers reused by render() — the audio callback must not
        # allocate per block (an allocator stall there is an audible dropout).
        self._music_buf: _Block = np.zeros((blocksize, channels), dtype=np.float32)
        self._voice_buf: _Block = np.zeros((blocksize, channels), dtype=np.float32)
        self._bed_buf: _Block = np.zeros((blocksize, channels), dtype=np.float32)

        self._env_lock = threading.Lock()  # guards both envelopes below
        self._envelope = GainEnvelope(samplerate=samplerate, ramp_s=ramp_s)
        self._music_ring = _Ring(int(music_buffer_s * samplerate), channels)
        self._music: MusicHandle | None = None  # whatever duck() dispatches to
        self._mixed: MixedHandle | None = None  # our own PCM-backed handle

        # The background bed (spec 03-04): its own ring + envelope. The envelope
        # starts at 0 (silent) and crossfades up over bed_xfade_s on start_bed;
        # it is driven only by start/stop and the bed<->song crossfade — never by
        # a voice clip, so the bed does NOT pump-duck under talk (§1.5).
        self._bed_ring = _Ring(int(music_buffer_s * samplerate), channels)
        self._bed_envelope = GainEnvelope(
            samplerate=samplerate, ramp_s=bed_xfade_s, initial=0.0
        )
        self._bed: _BedFeeder | None = None

        self._voice_lock = threading.Lock()
        self._voice_pcm: _Block | None = None
        self._voice_pos = 0
        self._voice_notify: Callable[[], None] | None = None
        self._voice_task: asyncio.Task[bool] | None = None

    # -- Player seam (spec 01): voice channel --------------------------------
    async def play(self, clip: AudioClip) -> None:
        """Play a voice clip; auto-duck any live music for its duration."""
        # Time the pre-playback path (device open on first use + decoding the
        # whole clip into memory): the suspected source of the "stutter at
        # playback start" — correlate its elapsed_s against mem.log RSS ticks.
        with _log.timed("play") as t:
            first = self._sink is None  # first play opens the audio device
            self._ensure_sink()
            pcm = await asyncio.to_thread(self._voice_loader, clip.source)
            t["first"] = first
            t["frames"] = len(pcm)
        handle = self._music
        if handle is not None:
            await handle.duck()
        loop = asyncio.get_running_loop()
        done = asyncio.Event()

        def _notify() -> None:
            loop.call_soon_threadsafe(done.set)

        with self._voice_lock:
            self._voice_pcm = pcm
            self._voice_pos = 0
            self._voice_notify = _notify
        # Mirror spec-01 AudioPlayer: the wait runs as an inner task so stop()
        # (the interjection) can cancel it without cancelling play()'s caller.
        # The timeout is a dead-sink guard: if the output stream stops pulling
        # blocks mid-clip (device gone), the radio must not freeze forever.
        timeout = 2.0 * len(pcm) / self._samplerate + self._voice_timeout_margin_s
        waiter: asyncio.Task[bool] = asyncio.ensure_future(done.wait())
        self._voice_task = waiter
        try:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(waiter, timeout)
        finally:
            self._voice_task = None
            with self._voice_lock:
                self._voice_pcm = None
                self._voice_notify = None
            if handle is not None:
                await handle.unduck()

    async def stop(self) -> None:
        """Cancel current voice playback (the interjection signal). Music is
        untouched — the Director's music branch stops via the handle."""
        task = self._voice_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    # -- music ---------------------------------------------------------------
    async def play_music(self, clip: AudioClip) -> MusicHandle:
        """Start a music source; non-blocking. Returns its handle."""
        self._ensure_sink()
        # One music source at a time (sole audio authority) — stop whatever is
        # live, our own MixedHandle or an adopted external one.
        previous = self._mixed if self._mixed is not None else self._music
        if previous is not None:
            await previous.stop()
            self._music = None
        decoder = await asyncio.to_thread(self._decoder_factory, clip.source)
        with self._voice_lock:
            voice_live = self._voice_pcm is not None
        with self._env_lock:
            # Fresh track, fresh envelope; born ducked if a voice is on air.
            target = self._duck_target if voice_live else FULL_GAIN
            if self._bed is not None:
                # Bed<->song crossfade (spec 03-04 §3.1): fade the bed out while
                # the song crossfades in (born at 0), both over the bed xfade.
                self._bed_envelope.set_target(0.0)
                self._envelope = GainEnvelope(
                    samplerate=self._samplerate, ramp_s=self._ramp_s, initial=0.0
                )
                self._envelope.set_target(target, ramp_s=self._bed_xfade_s)
            else:
                self._envelope = GainEnvelope(
                    samplerate=self._samplerate, ramp_s=self._ramp_s, initial=target
                )
        handle = MixedHandle(
            decoder=decoder,
            ring=self._music_ring,
            set_gain_target=self._set_gain_target,
            duck_target=self._duck_target,
            loop=asyncio.get_running_loop(),
            on_finished=self._on_music_finished,
        )
        self._music_ring.clear()
        handle.start()
        self._mixed = handle
        self._music = handle
        return handle

    def adopt_handle(self, handle: MusicHandle) -> None:
        """Make an externally-managed music source (e.g. a black-box player's
        ``ControlledHandle``) the live music for duck dispatch (spec §2.2)."""
        self._music = handle

    def _on_music_finished(self, handle: MixedHandle) -> None:
        if self._mixed is handle:
            self._mixed = None
        if self._music is handle:
            self._music = None
        # Song over -> crossfade the bed back in (spec 03-04 §3.1). Harmless if
        # a new song is starting: play_music re-targets the bed to 0 right after.
        if self._bed is not None:
            with self._env_lock:
                self._bed_envelope.set_target(self._bed_gain)

    def _set_gain_target(self, target: float) -> None:
        with self._env_lock:
            self._envelope.set_target(target)

    # -- background bed (spec 03-04) -----------------------------------------
    async def start_bed(self, bed: BedSource) -> None:
        """Begin the continuous low-gain backdrop (idempotent). Pulls PCM from
        ``bed``'s local tracks, looping/rotating with a crossfade so it never
        gaps, and crossfades it up to the bed gain. No-op if a bed is already
        running or the source is empty (degrade to no bed)."""
        if self._bed is not None:
            return
        if not bed.tracks():
            return  # empty cache -> no bed, radio still runs (§3.4)
        self._ensure_sink()
        self._bed_ring.clear()
        with self._env_lock:
            self._bed_envelope.set_target(self._bed_gain)  # crossfade up from 0
        feeder = _BedFeeder(
            bed=bed,
            ring=self._bed_ring,
            decoder_factory=self._decoder_factory,
            xfade_samples=int(self._bed_xfade_s * self._samplerate),
            channels=self._channels,
        )
        self._bed = feeder
        feeder.start()

    async def stop_bed(self) -> None:
        """Fade the bed out and stop pulling from the source (on /quit /
        shutdown). No bed task outlives the engine (§3.1)."""
        feeder = self._bed
        if feeder is None:
            return
        with self._env_lock:
            self._bed_envelope.set_target(0.0)
        await feeder.stop()
        self._bed = None
        self._bed_ring.clear()

    # -- lifecycle ------------------------------------------------------------
    async def aclose(self) -> None:
        """Stop everything and release the output stream. No orphans."""
        await self.stop()
        await self.stop_bed()
        mixed = self._mixed
        if mixed is not None:
            await mixed.stop()
        self._music = None
        if self._sink is not None:
            sink, self._sink = self._sink, None
            with contextlib.suppress(Exception):
                await asyncio.to_thread(sink.close)

    def _ensure_sink(self) -> None:
        if self._sink is None and self._sink_factory is not None:
            self._sink = self._sink_factory(
                self.render, self._samplerate, self._channels, self._blocksize
            )

    # -- the mixing callback (audio thread; tests call it directly) -----------
    def render(self, frames: int) -> _Block:
        """Produce the next mixed block. Starved buffers pad with silence."""
        if len(self._music_buf) != frames:  # sink blocksize changed — rare
            self._music_buf = np.zeros((frames, self._channels), dtype=np.float32)
            self._voice_buf = np.zeros((frames, self._channels), dtype=np.float32)
            self._bed_buf = np.zeros((frames, self._channels), dtype=np.float32)
        music = self._music_buf
        music.fill(0.0)
        self._music_ring.read_into(music, frames)
        mixed = self._mixed
        if mixed is not None and mixed.drained():
            mixed.signal_finished()

        bed = self._bed_buf
        bed.fill(0.0)
        self._bed_ring.read_into(bed, frames)

        with self._env_lock:
            gains = self._envelope.next_block(frames)
            bed_gains = self._bed_envelope.next_block(frames)

        voice = self._voice_buf
        voice.fill(0.0)
        with self._voice_lock:
            pcm = self._voice_pcm
            if pcm is not None:
                n = min(frames, len(pcm) - self._voice_pos)
                if n > 0:
                    voice[:n] = pcm[self._voice_pos : self._voice_pos + n]
                    self._voice_pos += n
                if self._voice_pos >= len(pcm) and self._voice_notify is not None:
                    self._voice_notify()
                    self._voice_notify = None

        return mix(music, voice, gains, bed, bed_gains)
