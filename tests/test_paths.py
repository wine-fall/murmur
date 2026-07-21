"""paths.py — the single resolver for murmur's user-level storage (spec 05 §2.3).

All unit, no disk writes: the resolvers are pure (they compute locations, callers
create dirs). ``$MURMUR_HOME`` relocates the whole tree, so tests point it at
``tmp_path`` and assert the two roots split beneath it.
"""

from __future__ import annotations

from pathlib import Path

from murmur import paths


def test_home_defaults_to_dot_murmur_under_home(monkeypatch):
    monkeypatch.delenv("MURMUR_HOME", raising=False)
    assert paths.home_root() == Path.home() / ".murmur"


def test_murmur_home_env_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("MURMUR_HOME", str(tmp_path / "elsewhere"))
    assert paths.home_root() == tmp_path / "elsewhere"


def test_blank_env_falls_back_to_default(monkeypatch):
    # A set-but-empty / whitespace value must not resolve to CWD or "/".
    monkeypatch.setenv("MURMUR_HOME", "   ")
    assert paths.home_root() == Path.home() / ".murmur"


def test_env_expands_user(monkeypatch):
    monkeypatch.setenv("MURMUR_HOME", "~/somewhere")
    assert paths.home_root() == Path.home() / "somewhere"


def test_data_and_cache_roots_split_under_home(monkeypatch, tmp_path):
    monkeypatch.setenv("MURMUR_HOME", str(tmp_path))
    assert paths.data_root() == tmp_path / "data"
    assert paths.cache_root() == tmp_path / "cache"
