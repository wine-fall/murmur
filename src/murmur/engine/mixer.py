"""Pure mixing math (spec 03-02 §3.1): gain envelope + block mix.

No I/O, no asyncio, no hardware — everything here is deterministic numpy so
the duck behavior is unit-testable sample-for-sample (acceptance #2). The
engine's audio callback calls ``GainEnvelope.next_block`` for the music gains
of each block and ``mix`` to combine the channels.
"""

from __future__ import annotations

import numpy as np

FULL_GAIN = 1.0
DUCK_TARGET = 0.3  # starting value, tuned by ear (spec 03-02 §6)
RAMP_S = 0.3

# Background bed (spec 03-04 §3.3) — module constants, by-ear tunable (§6).
BED_GAIN = 0.18  # bed level under talk (well below voice; no per-voice duck)
BED_XFADE_S = 1.5  # bed<->song and bed-loop crossfade duration (start linear)


class GainEnvelope:
    """Per-sample linear ramp toward a target gain.

    ``set_target`` starts a ramp from the current gain to ``target`` lasting
    ``ramp_s`` seconds (the slope is fixed at call time, so a mid-ramp retarget
    ramps from wherever it currently is). ``next_block(n)`` returns the next
    ``n`` gain values and advances the state.
    """

    def __init__(
        self,
        *,
        samplerate: int,
        ramp_s: float = RAMP_S,
        initial: float = FULL_GAIN,
    ) -> None:
        self._samplerate = samplerate
        self._ramp_samples: int = max(1, int(ramp_s * samplerate))
        self._current: float = initial
        self._target: float = initial
        self._step: float = 0.0  # signed per-sample increment while ramping

    @property
    def current(self) -> float:
        return self._current

    def set_target(self, target: float, *, ramp_s: float | None = None) -> None:
        """Ramp toward ``target``. ``ramp_s`` overrides this ramp's duration for
        this call only (spec 03-04: a slow crossfade-in, then a fast duck) — the
        envelope's default ramp is left unchanged."""
        ramp_samples = (
            self._ramp_samples
            if ramp_s is None
            else max(1, int(ramp_s * self._samplerate))
        )
        self._target = target
        self._step = (target - self._current) / ramp_samples

    def next_block(self, n: int) -> "np.ndarray[tuple[int], np.dtype[np.float32]]":
        if self._current == self._target:
            return np.full(n, self._current, dtype=np.float32)
        ramp = self._current + self._step * np.arange(1, n + 1, dtype=np.float64)
        if self._step < 0.0:
            ramp = np.maximum(ramp, self._target)
        else:
            ramp = np.minimum(ramp, self._target)
        self._current = float(ramp[-1])
        return ramp.astype(np.float32)


def mix(
    music: "np.ndarray[tuple[int, int], np.dtype[np.float32]]",
    voice: "np.ndarray[tuple[int, int], np.dtype[np.float32]]",
    music_gains: "np.ndarray[tuple[int], np.dtype[np.float32]]",
    bed: "np.ndarray[tuple[int, int], np.dtype[np.float32]] | None" = None,
    bed_gains: "np.ndarray[tuple[int], np.dtype[np.float32]] | None" = None,
) -> "np.ndarray[tuple[int, int], np.dtype[np.float32]]":
    """``music * music_gains + bed * bed_gains + voice``, hard-limited to [-1, 1].

    All arrays are float32; ``music``/``voice``/``bed`` are (n, channels) blocks
    and the gains are (n,) per-sample envelopes for their channel. ``bed`` is the
    optional spec 03-04 background channel; omitting it is exactly 03-02.
    """
    out = music * music_gains[:, None] + voice
    if bed is not None and bed_gains is not None:
        out += bed * bed_gains[:, None]
    # numpy's clip stubs are partially unknown under pyright strict.
    np.clip(out, -1.0, 1.0, out=out)  # pyright: ignore[reportUnknownMemberType]
    return out


def crossfade(
    a: "np.ndarray[tuple[int, int], np.dtype[np.float32]]",
    b: "np.ndarray[tuple[int, int], np.dtype[np.float32]]",
) -> "np.ndarray[tuple[int, int], np.dtype[np.float32]]":
    """Linear crossfade of two equal-length (n, channels) blocks (spec 03-04
    §3.2): ``a`` fades out 1->0 while ``b`` fades in 0->1, summed sample-for-
    sample. Complementary gains sum to 1, so a steady bed has no dip and no gap
    at the loop/rotation boundary. Equal-power is a by-ear upgrade (§6)."""
    n = len(a)
    ramp = np.arange(n, dtype=np.float64) / max(1, n - 1)  # 0 -> 1
    out = a * (1.0 - ramp)[:, None] + b * ramp[:, None]
    return out.astype(np.float32)
