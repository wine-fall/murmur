#!/usr/bin/env python3
"""Path-governance gate — keep user-level path resolution in one module.

murmur's persistent storage lives under one home (``~/.murmur``, spec 05 §2.3),
resolved solely by ``src/murmur/paths.py``. This ratchet fails a commit that
resolves a user-level location anywhere else: ``Path.home()`` or an
``expanduser`` call. Route it through ``murmur.paths`` (``data_root`` /
``cache_root``) instead, so relocating via ``$MURMUR_HOME`` and backing up stay
a single-directory story.

AST-based (imports, strings, and comments are NOT matched — only real calls), so
a docstring mentioning ``Path.home()`` does not trip it.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

SCAN_ROOT = Path("src/murmur")
# The one module allowed to resolve user-level paths.
EXEMPT = {SCAN_ROOT / "paths.py"}


def _is_path_home(node: ast.AST) -> bool:
    # Path.home()  ->  Call(func=Attribute(attr="home", value=Name(id="Path")))
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "home"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "Path"
    )


def _tilde_literal(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and "~" in node.value


def _is_expanduser(node: ast.AST) -> bool:
    # Flag ``expanduser`` only on a hardcoded ``~`` LITERAL — a scattering vector
    # for a fixed storage location (``Path("~/.cache/murmur").expanduser()`` /
    # ``os.path.expanduser("~/x")``). Expanding a *variable* the user supplied
    # (``Path(dev_log_target).expanduser()``) is honoring their input, not
    # hardcoding a location — and is legitimately out of paths.py's scope.
    if not (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "expanduser"
    ):
        return False
    # os.path.expanduser("~/x") -> the tilde literal is this call's own arg.
    if any(_tilde_literal(arg) for arg in node.args):
        return True
    # Path("~/x").expanduser() -> the receiver is Path(<tilde literal>).
    recv = node.func.value
    return isinstance(recv, ast.Call) and any(_tilde_literal(a) for a in recv.args)


def find_violations(root: Path) -> list[tuple[Path, int]]:
    """Return ``(file, lineno)`` for every hardcoded user-path resolution under
    ``root``, skipping the exempt ``paths.py`` and files that fail to parse."""
    hits: list[tuple[Path, int]] = []
    for path in sorted(root.rglob("*.py")):
        if path in EXEMPT or path.name == "paths.py":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if _is_path_home(node) or _is_expanduser(node):
                hits.append((path, getattr(node, "lineno", 0)))
    return hits


def main() -> int:
    hits = find_violations(SCAN_ROOT)
    if not hits:
        print(f"ok   {SCAN_ROOT}: no hardcoded user-level paths.")
        return 0
    for path, lineno in hits:
        print(
            f"FAIL {path}:{lineno}: hardcoded user-level path "
            f"(Path.home()/expanduser). Route it through murmur.paths "
            f"(data_root/cache_root) — the only module allowed to resolve these."
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
