"""Persona loader tests (spec 01 §3.1)."""

from __future__ import annotations

from pathlib import Path

import pytest

from murmur.persona import load_persona


def test_loads_and_strips(tmp_path: Path):
    p = tmp_path / "persona.md"
    p.write_text("  hello persona  \n", encoding="utf-8")
    assert load_persona(p) == "hello persona"


def test_missing_file_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        load_persona(tmp_path / "nope.md")


def test_empty_file_raises(tmp_path: Path):
    p = tmp_path / "empty.md"
    p.write_text("   \n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_persona(p)


def test_bundled_default_seed_loads():
    from murmur.prompts import DEFAULT_PERSONA_PATH

    assert load_persona(DEFAULT_PERSONA_PATH)  # non-empty
