#!/usr/bin/env python3
"""Any-budget ratchet — keep ``typing.Any`` from creeping into the codebase.

``Any`` is the type checker's escape hatch: every one is a spot where pyright's
guarantees stop. This counts real ``Any`` references per tracked root (via AST, so
imports, strings, and comments are NOT counted — only actual uses like ``x: Any``,
``-> Any``, ``Future[Any]``) and fails if a root exceeds its frozen baseline.

A PR that adds an ``Any`` past the ceiling fails. Prefer a precise type, a
Protocol, or ``object`` instead. When you legitimately remove ``Any``, LOWER the
matching baseline below so the gain is locked in. Raising a baseline is a
deliberate, reviewed exception — say why in the PR.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

# Frozen ceilings (references counted 2026-07-17). Lower as you delete Any.
BASELINE: dict[str, int] = {
    "src": 22,  # shipped code — the ratchet that matters most
    "tests": 17,  # mostly fakes.py (loosely-typed doubles); still capped
    "scripts": 0,  # dev tooling stays Any-free
}


def count_any(root: Path) -> int:
    """AST-count references to the name ``Any`` (bare or attribute, e.g.
    ``typing.Any``) under ``root``. Skips files that fail to parse."""
    total = 0
    for path in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == "Any":
                total += 1
            elif isinstance(node, ast.Attribute) and node.attr == "Any":
                total += 1
    return total


def main() -> int:
    failed = False
    for root, cap in BASELINE.items():
        current = count_any(Path(root))
        if current > cap:
            failed = True
            print(
                f"FAIL {root}: {current} Any references > baseline {cap}. "
                f"Avoid new Any (use a precise type / Protocol / object). "
                f"If unavoidable, raise the baseline in scripts/check_any_budget.py "
                f"and justify it in the PR."
            )
        elif current < cap:
            print(
                f"note {root}: {current} Any references < baseline {cap} — nice. "
                f"Lower the baseline to {current} in scripts/check_any_budget.py "
                f"to lock it in."
            )
        else:
            print(f"ok   {root}: {current} Any references (== baseline {cap}).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
