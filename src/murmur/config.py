"""Configuration for the core loop (spec 01 §3.1 ``config``).

A single ``Config`` dataclass holds the knobs the core needs: provider
selection, persona file path, cadence gap, model ids, and the recent-window
size. L0 reads sensible defaults from here; richer config sources (file / env)
can be layered on later without changing the call sites.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# Repo root = three levels up from this file: src/murmur/config.py -> repo/.
_REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Config:
    # --- persona -----------------------------------------------------------
    persona_path: Path = _REPO_ROOT / "persona.md"

    # --- pacing (spec 01 §3.4) --------------------------------------------
    # Natural pause between talk segments, in seconds. Bounds the talk rate so
    # testing does not drain the subscription; full economy is spec 08.
    inter_segment_gap: float = 4.0

    # --- brain (spec 01 §3.2) ---------------------------------------------
    # Model id for L0. Tiered models (cheap filler) are deferred to spec 08.
    # Used by the real Brain in spec 01 step 2; the step-1 stub ignores it.
    model: str = "claude-opus-4-8"

    # --- memory (master §6) -----------------------------------------------
    # Size of the recent-turns window handed to the Brain per call.
    recent_window: int = 12

    # --- provider selection (spec 01 §3.1) --------------------------------
    # Which VoiceProvider adapter to construct. "stub" exercises the loop with
    # no spec-02 code present (acceptance criterion §5). spec 02 adds e.g.
    # "qwen3".
    voice_provider: str = "stub"

    @classmethod
    def default(cls) -> "Config":
        return cls()
