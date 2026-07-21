"""Configuration for the core loop (spec 01 §3.1 ``config``).

A single ``Config`` dataclass holds the knobs the core needs: provider
selection, persona file path, cadence gap, model ids, and the recent-window
size. L0 reads sensible defaults from here; richer config sources (file / env)
can be layered on later without changing the call sites.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .prompts import DEFAULT_PERSONA_PATH


def _env_seed() -> int | None:
    """Parse ``MURMUR_TTS_SEED`` (empty/unset → None). A non-numeric value is a
    misconfiguration, but it only matters to the remote voice — it must not abort
    Config construction (and thus every voice, incl. spark/stub). So we warn and
    ignore it, falling back to the documented unpinned-voice default."""
    raw = os.environ.get("MURMUR_TTS_SEED", "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        print(
            f"warning: ignoring non-numeric MURMUR_TTS_SEED={raw!r}", file=sys.stderr
        )
        return None


# The inter-sentence silence pad (seconds) the remote voice splices between
# sentences (spec 02 §3.6). A by-ear knob: fish TTS runs sentences together, and
# the model's own pause hints proved inert, so we insert this gap ourselves.
# 0 disables splitting entirely (one-shot synth). Tunable live via env.
_DEFAULT_SENTENCE_PAD_S = 0.8


def _env_sentence_pad() -> float:
    """Parse ``MURMUR_TTS_SENTENCE_PAD_S`` (empty/unset → default). Non-numeric or
    negative degrades to the default with a warning — a bad value must not abort
    Config (same posture as ``_env_seed``)."""
    raw = os.environ.get("MURMUR_TTS_SENTENCE_PAD_S", "").strip()
    if not raw:
        return _DEFAULT_SENTENCE_PAD_S
    try:
        value = float(raw)
    except ValueError:
        print(
            f"warning: ignoring non-numeric MURMUR_TTS_SENTENCE_PAD_S={raw!r}",
            file=sys.stderr,
        )
        return _DEFAULT_SENTENCE_PAD_S
    return value if value >= 0 else _DEFAULT_SENTENCE_PAD_S


@dataclass(frozen=True)
class Config:
    # --- persona -----------------------------------------------------------
    persona_path: Path = DEFAULT_PERSONA_PATH

    # --- pacing (spec 01 §3.4) --------------------------------------------
    # Natural pause between talk segments, in seconds. A by-ear knob (live via
    # --gap): short enough to feel like a continuous program, long enough to
    # read as breathing room. Also bounds the talk rate so testing does not
    # drain the subscription; full economy is spec 08.
    inter_segment_gap: float = 2.0

    # --- audio engine (spec 03-02) -----------------------------------------
    # The mixing AudioEngine replaced the spec-01 afplay player; its only
    # external binary is ffmpeg (per-track decode).
    ffmpeg_cmd: str = "ffmpeg"

    # --- brain (spec 01 §3.2) ---------------------------------------------
    # Model id for L0. Tiered models (cheap filler) are deferred to spec 08.
    # Used by the real Brain in spec 01 step 2; the step-1 stub ignores it.
    model: str = "claude-opus-4-8"

    # --- music (specs 03-01/03-02) ------------------------------------------
    # Music is on by default, gated by the startup checks (spec 03-02 §2.4);
    # it needs the real (claude) brain — the stub runs talk-only.
    music_enabled: bool = True
    ytdlp_cmd: str = "yt-dlp"
    # Cheap tier for the music-discovery task and the opt-in brain cadence
    # (master §7 pillar 3).
    music_model: str = "claude-haiku-4-5-20251001"
    # Talk<->music scheduling mode (spec 03-02 §2.3): "every_n" (default) |
    # "random" | "brain" (the opt-in master §7 pillar-1 exception).
    cadence_mode: str = "every_n"
    music_every_n: int = 2

    # --- background bed (spec 03-04) ---------------------------------------
    # A continuous low-volume instrumental under all talk, so pure-talk stretches
    # are never dead silence. On by default when the cache has tracks; the pull
    # happens at first-run loading (bed.py), never on the audio path. The bed
    # gain / crossfade are module constants (engine/mixer.py), by-ear tunable.
    bed_enabled: bool = True

    # --- memory (master §6) -----------------------------------------------
    # Size of the recent-turns window handed to the Brain per call.
    recent_window: int = 12

    # --- provider selection (spec 01 §3.1) --------------------------------
    # Which Brain to construct. "claude" = real claude-agent-sdk Brain (L0
    # default, subscription OAuth); "stub" = canned text, no network (the fast
    # test layer, DESIGN §11.1).
    brain_provider: str = "claude"

    # Which VoiceProvider adapter to construct. "stub" exercises the loop with
    # no spec-02 code present (acceptance criterion §5). spec 02 adds e.g.
    # "qwen3"; "remote" is the off-machine HTTP backend (§3.6).
    voice_provider: str = "stub"

    # --- remote TTS (spec 02 §3.6) — off-machine VoiceProvider via HTTP ----
    # Read from env so a URL / key is never hardcoded; only used when
    # voice_provider == "remote". Empty = not configured.
    tts_url: str = field(default_factory=lambda: os.environ.get("MURMUR_TTS_URL", ""))
    tts_reference_id: str = field(
        default_factory=lambda: os.environ.get("MURMUR_TTS_REFERENCE_ID", "")
    )
    tts_api_key: str = field(
        default_factory=lambda: os.environ.get("MURMUR_TTS_API_KEY", "")
    )
    # Fixed sampling seed for the remote voice. fish-speech has no preset voices,
    # so without a reference each call samples a fresh timbre; a pinned seed keeps
    # one stable voice across lines. Empty = unset (random per call).
    tts_seed: int | None = field(default_factory=lambda: _env_seed())
    # HTTP `model` header for the remote backend — selects a hosted model (e.g.
    # fish.audio "s2.1-pro-free"). Empty = no header (self-hosted fish-speech
    # ignores it).
    tts_model: str = field(default_factory=lambda: os.environ.get("MURMUR_TTS_MODEL", ""))
    # Inter-sentence silence pad (seconds) for the remote voice (§3.6). By-ear
    # knob via MURMUR_TTS_SENTENCE_PAD_S; 0 disables sentence-splitting.
    tts_sentence_pad_s: float = field(default_factory=lambda: _env_sentence_pad())

    @classmethod
    def default(cls) -> "Config":
        return cls()
