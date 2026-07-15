"""Centralized prompt management.

All prompt text murmur sends to the Brain lives under this package, written in
English (DESIGN §0 convention). The radio's *output* language is set inside the
prompt itself — the persona seed instructs the host to speak Chinese — so
English prompt scaffolding still yields a Chinese-speaking radio.

Public surface:
- ``build_next_talk_prompt`` / ``build_respond_prompt`` — per-call prompt builders.
- ``DEFAULT_PERSONA_PATH`` — the default static persona seed (L0).
"""

from __future__ import annotations

from pathlib import Path

from .cadence import CADENCE_INSTRUCTION, CADENCE_STATE_HEADER
from .music import (
    MUSIC_CONTEXT_HEADER,
    build_find_music_instruction,
    build_music_situation,
)
from .talk import (
    build_next_talk_prompt,
    build_next_talks_prompt,
    build_respond_prompt,
)

# The static persona System Prompt seed (L0). spec 06 will generate/evolve
# personas at runtime; this is only the bundled default.
DEFAULT_PERSONA_PATH = Path(__file__).resolve().parent / "persona_seed.md"

__all__ = [
    "build_next_talk_prompt",
    "build_next_talks_prompt",
    "build_respond_prompt",
    "build_find_music_instruction",
    "build_music_situation",
    "MUSIC_CONTEXT_HEADER",
    "CADENCE_INSTRUCTION",
    "CADENCE_STATE_HEADER",
    "DEFAULT_PERSONA_PATH",
]
