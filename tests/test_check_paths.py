"""The path-governance gate (scripts/check_paths.py) — proves it actually catches
a hardcoded user-level path and clears a clean tree, so the ratchet can't pass
vacuously. Loads the script by file path (scripts/ is not a package)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check_paths.py"


def _load():
    spec = importlib.util.spec_from_file_location("check_paths", _SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_flags_path_home_outside_paths_module(tmp_path):
    (tmp_path / "leaky.py").write_text(
        "from pathlib import Path\nCACHE = Path.home() / '.cache'\n", encoding="utf-8"
    )
    hits = _load().find_violations(tmp_path)
    assert [p.name for p, _ in hits] == ["leaky.py"]


def test_flags_expanduser(tmp_path):
    (tmp_path / "expand.py").write_text(
        "import os\nP = os.path.expanduser('~/x')\n", encoding="utf-8"
    )
    hits = _load().find_violations(tmp_path)
    assert [p.name for p, _ in hits] == ["expand.py"]


def test_expanduser_on_a_variable_is_allowed(tmp_path):
    # Expanding a user-supplied path (e.g. the dev-log target) honors their input;
    # it is not hardcoding a storage location -> must not be flagged.
    (tmp_path / "devlog.py").write_text(
        "from pathlib import Path\n"
        "def f(target):\n"
        "    return Path(target).expanduser()\n",
        encoding="utf-8",
    )
    assert _load().find_violations(tmp_path) == []


def test_paths_module_itself_is_exempt(tmp_path):
    # The one module allowed to resolve user paths must not flag itself.
    (tmp_path / "paths.py").write_text(
        "from pathlib import Path\ndef home_root():\n    return Path.home() / '.murmur'\n",
        encoding="utf-8",
    )
    assert _load().find_violations(tmp_path) == []


def test_clean_tree_has_no_violations(tmp_path):
    (tmp_path / "ok.py").write_text(
        "from murmur import paths\nC = paths.cache_root()\n", encoding="utf-8"
    )
    assert _load().find_violations(tmp_path) == []
