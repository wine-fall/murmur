"""Static persona loader (spec 01 §3.1 ``persona``).

L0 loads a hand-written persona System Prompt seed from a config-specified file
at startup. Onboarding Q&A and persona evolution are spec 06 — this module does
not touch them.
"""

from __future__ import annotations

from pathlib import Path


def load_persona(path: Path) -> str:
    """Read the persona seed file and return its text (stripped).

    Raises ``FileNotFoundError`` with a clear message if the configured persona
    file is missing — a missing persona is a startup error, not a silent empty
    prompt.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            f"persona seed file not found: {path} "
            f"(set Config.persona_path to a valid Markdown/text file)"
        ) from exc
    text = text.strip()
    if not text:
        raise ValueError(f"persona seed file is empty: {path}")
    return text
