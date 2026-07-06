"""Mixer core math (spec 03-02 §3.1/§5.2): gain envelope + block mixing.

Pure numpy, no audio hardware. Pins acceptance criterion #2: given synthetic
music + voice blocks and an envelope, the mixed output equals the expected
samples, and the duck target is reached within the ramp time.
"""

from __future__ import annotations

import numpy as np

from murmur.engine.mixer import GainEnvelope, mix

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
