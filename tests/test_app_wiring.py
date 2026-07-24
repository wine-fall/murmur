"""app wiring for memory (spec 05 §3.2/§3.7): store selection by brain provider,
stub isolation (the memory dir is untouched on a stub run), and persona homing
(seed copied into the memory dir on first run, loaded from there after)."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from murmur.app import build_memory, resolve_persona_path
from murmur.config import Config
from murmur.memory import InProcessMemoryStore, PersistentMemoryStore


def _config(tmp_path: Path, persona: str) -> Config:
    seed = tmp_path / "seed.md"
    seed.write_text(persona, encoding="utf-8")
    return replace(
        Config.default(), memory_dir=tmp_path / "mem", persona_path=seed
    )


def test_claude_run_uses_persistent_store(tmp_path: Path) -> None:
    cfg = _config(tmp_path, "p")
    store = build_memory(cfg, persistent=True)
    assert isinstance(store, PersistentMemoryStore)
    assert (tmp_path / "mem").is_dir()


def test_stub_run_uses_in_process_store_and_leaves_memory_dir_untouched(
    tmp_path: Path,
) -> None:
    cfg = _config(tmp_path, "p")
    store = build_memory(cfg, persistent=False)
    assert isinstance(store, InProcessMemoryStore)
    assert not (tmp_path / "mem").exists()  # stub isolation (§3.7)


def test_persona_homing_copies_seed_then_loads_from_memory_dir(tmp_path: Path) -> None:
    cfg = _config(tmp_path, "first-seed")
    home = tmp_path / "mem" / "persona.md"

    # First run: the seed is copied into the memory dir.
    p1 = resolve_persona_path(cfg, persistent=True)
    assert p1 == home
    assert home.read_text(encoding="utf-8") == "first-seed"

    # The living asset now owns the persona: editing the seed does not override
    # the homed copy on a later run (spec 06 evolves persona.md, not the seed).
    cfg.persona_path.write_text("changed-seed", encoding="utf-8")
    p2 = resolve_persona_path(cfg, persistent=True)
    assert p2 == home
    assert home.read_text(encoding="utf-8") == "first-seed"


def test_stub_run_loads_seed_directly_no_homing(tmp_path: Path) -> None:
    cfg = _config(tmp_path, "seed")
    p = resolve_persona_path(cfg, persistent=False)
    assert p == cfg.persona_path
    assert not (tmp_path / "mem").exists()
