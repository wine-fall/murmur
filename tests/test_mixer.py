"""Mixer core math (spec 03-02 §3.1/§5.2): gain envelope + block mixing.

Pure numpy, no audio hardware. Pins acceptance criterion #2: given synthetic
music + voice blocks and an envelope, the mixed output equals the expected
samples, and the duck target is reached within the ramp time.
"""

from __future__ import annotations

import numpy as np

from murmur.engine.mixer import GainEnvelope, crossfade, mix

_SR = 48_000


def _drain(env: GainEnvelope, samples: int, block: int = 480) -> np.ndarray:
    out = []
    remaining = samples
    while remaining > 0:
        n = min(block, remaining)
        out.append(env.next_block(n))
        remaining -= n
    return np.concatenate(out)


def test_envelope_starts_at_full_gain_and_holds():
    env = GainEnvelope(samplerate=_SR, ramp_s=0.3)
    gains = env.next_block(480)
    assert gains.shape == (480,)
    assert gains.dtype == np.float32
    assert np.all(gains == 1.0)


def test_envelope_reaches_duck_target_within_ramp_time():
    env = GainEnvelope(samplerate=_SR, ramp_s=0.3)
    env.set_target(0.3)
    ramp_samples = int(0.3 * _SR)
    gains = _drain(env, ramp_samples)
    assert gains[-1] == np.float32(0.3)  # target reached by end of ramp
    # And it stays there.
    assert np.all(env.next_block(480) == np.float32(0.3))


def test_envelope_ramp_is_smooth_and_monotonic():
    env = GainEnvelope(samplerate=_SR, ramp_s=0.3)
    env.set_target(0.3)
    gains = _drain(env, int(0.3 * _SR))
    assert np.all(np.diff(gains) <= 0)  # monotonic down
    # No hard step: the very first ducked sample is still near full gain.
    assert gains[0] > 0.99
    # Roughly linear: halfway through the ramp sits near the midpoint.
    mid = gains[len(gains) // 2]
    assert abs(mid - 0.65) < 0.01


def test_envelope_unduck_ramps_back_to_full():
    env = GainEnvelope(samplerate=_SR, ramp_s=0.3)
    env.set_target(0.3)
    _drain(env, int(0.3 * _SR))
    env.set_target(1.0)
    gains = _drain(env, int(0.3 * _SR))
    assert np.all(np.diff(gains) >= 0)
    assert gains[-1] == np.float32(1.0)


def test_mix_is_music_times_gain_plus_voice():
    n = 4
    music = np.full((n, 2), 0.5, dtype=np.float32)
    voice = np.full((n, 2), 0.25, dtype=np.float32)
    gains = np.array([1.0, 0.8, 0.6, 0.3], dtype=np.float32)
    out = mix(music, voice, gains)
    expected = music * gains[:, None] + voice
    assert out.dtype == np.float32
    assert np.array_equal(out, expected)


def test_mix_limits_to_unit_range():
    n = 3
    music = np.full((n, 2), 0.9, dtype=np.float32)
    voice = np.full((n, 2), 0.9, dtype=np.float32)
    gains = np.ones(n, dtype=np.float32)
    out = mix(music, voice, gains)
    assert np.all(out <= 1.0)
    assert np.all(out >= -1.0)
    loud_negative = mix(-music, -voice, gains)
    assert np.all(loud_negative >= -1.0)


# --- spec 03-04: bed channel + crossfade primitive ------------------------- #


def test_mix_sums_the_optional_bed_channel():
    """The bed (spec 03-04) is a third gained source summed before limiting."""
    n = 4
    music = np.full((n, 2), 0.5, dtype=np.float32)
    voice = np.full((n, 2), 0.1, dtype=np.float32)
    bed = np.full((n, 2), 0.4, dtype=np.float32)
    music_gains = np.ones(n, dtype=np.float32)
    bed_gains = np.full(n, 0.5, dtype=np.float32)
    out = mix(music, voice, music_gains, bed, bed_gains)
    expected = music * music_gains[:, None] + bed * bed_gains[:, None] + voice
    assert out.dtype == np.float32
    assert np.array_equal(out, expected)


def test_mix_without_bed_is_unchanged():
    """Bed is optional — omitting it keeps the exact 03-02 behavior."""
    n = 3
    music = np.full((n, 2), 0.5, dtype=np.float32)
    voice = np.full((n, 2), 0.25, dtype=np.float32)
    gains = np.ones(n, dtype=np.float32)
    assert np.array_equal(mix(music, voice, gains), music * gains[:, None] + voice)


def test_crossfade_is_complementary_with_no_gap():
    """Loop/rotation primitive (acceptance #3): the boundary overlaps with
    complementary gains — for a steady signal there is no dip and no gap."""
    n = 8
    a = np.ones((n, 2), dtype=np.float32)
    b = np.ones((n, 2), dtype=np.float32)
    out = crossfade(a, b)
    assert out.shape == (n, 2)
    assert out.dtype == np.float32
    # Equal steady signals -> the sum of the two ramps is flat (no zero-gap).
    assert np.allclose(out, 1.0)
    assert not np.any(np.all(out == 0.0, axis=1))  # no silent frame


def test_crossfade_ramps_from_a_to_b():
    n = 5
    a = np.ones((n, 2), dtype=np.float32)  # outgoing
    b = np.zeros((n, 2), dtype=np.float32)  # incoming
    out = crossfade(a, b)
    # a fades out: starts near full, ends near zero, monotonically down.
    assert out[0, 0] > out[-1, 0]
    assert np.all(np.diff(out[:, 0]) <= 0)
    a2 = np.zeros((n, 2), dtype=np.float32)
    b2 = np.ones((n, 2), dtype=np.float32)
    up = crossfade(a2, b2)  # b fades in: monotonically up
    assert np.all(np.diff(up[:, 0]) >= 0)


def test_set_target_ramp_override_does_not_change_the_default_ramp():
    """A one-off long crossfade-in must not slow the subsequent fast duck
    (spec 03-04: the song crossfades in over _BED_XFADE_S, then ducks over
    RAMP_S)."""
    env = GainEnvelope(samplerate=_SR, ramp_s=0.3, initial=0.0)
    env.set_target(1.0, ramp_s=1.5)  # slow crossfade-in
    # After 0.3 s (the default ramp) it is NOT yet at full — the override is slow.
    partial = _drain(env, int(0.3 * _SR))
    assert partial[-1] < 1.0
    # Finish the slow ramp, then a default-ramp retarget uses 0.3 s again.
    _drain(env, int(1.3 * _SR))
    assert env.current == np.float32(1.0)
    env.set_target(0.3)  # no override -> the fast default ramp
    fast = _drain(env, int(0.3 * _SR))
    assert fast[-1] == np.float32(0.3)
