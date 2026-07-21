"""The single resolver for murmur's user-level storage (spec 05 §2.3).

Everything murmur keeps about you lives under one home — ``~/.murmur`` by
default, relocatable with ``$MURMUR_HOME`` — so backing up or moving murmur is
one directory, not a hunt across ``~/.cache`` and ``~/.local/share``. This module
is the **only** place allowed to resolve those locations; a pre-commit gate
(``scripts/check_paths.py``) forbids ``Path.home()`` / ``expanduser`` elsewhere.

Two roots, split by "what happens if you delete it":

- ``data_root()``  — **irreplaceable** user state (spec 05's ``memory/``, incl.
  the evolving persona). Losing it loses who murmur thinks you are; back it up.
- ``cache_root()`` — **rebuildable** (the background-music ``bed/``); deleting it
  only costs a re-pull.

Out of scope on purpose: **ephemeral TTS clips** are throwaway and live in the
system tmp (``tempfile``, ``murmur-*`` prefixes), cleaned by their creator on
close — not user storage. Repo-relative dev tooling (``.dev/``, ``scratch/``,
``graphify-out/``) is dev-loop, not app storage.

Resolvers are **pure** (they compute a path, they do not create it); a writer
``mkdir(parents=True, exist_ok=True)`` at its own write site, as today.
"""

from __future__ import annotations

import os
from pathlib import Path

_ENV_HOME = "MURMUR_HOME"


def home_root() -> Path:
    """murmur's storage home: ``$MURMUR_HOME`` when set to a non-blank value
    (``~`` expanded), else ``~/.murmur``. One env var relocates everything below.
    A set-but-blank value degrades to the default rather than resolving to the
    CWD or ``/``."""
    override = os.environ.get(_ENV_HOME, "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".murmur"


def data_root() -> Path:
    """Irreplaceable user state (spec 05 ``memory/``, incl. the persona). Back up."""
    return home_root() / "data"


def cache_root() -> Path:
    """Rebuildable caches (the music ``bed/``). Safe to delete — costs a re-pull."""
    return home_root() / "cache"
