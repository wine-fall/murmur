#!/usr/bin/env python3
"""Enforce English-only comments in Python sources (project convention).

A comment may contain ASCII plus a small allowlist of typographic punctuation
(em/en dashes, ellipsis, curly quotes). Any other character — most importantly
CJK — fails the check. Only comments are inspected; string literals are left
alone, since they legitimately hold non-English content (e.g. the radio's
Chinese output and stub text).

Usage:
    python scripts/check_comment_language.py [FILE ...]

With no arguments, scans src/ and scripts/. Exits non-zero on any violation, so
it works as a pre-commit hook and in CI. Standard library only.
"""

from __future__ import annotations

import sys
import tokenize
from pathlib import Path

# Typographic punctuation acceptable in otherwise-English prose (em/en dashes,
# ellipsis, curly quotes, and the section sign used for spec refs like "§3.1").
# These live in a string literal, not a comment, so this file passes its own rule.
_ALLOWED_NON_ASCII = set("—–…“”‘’§")


def _offending_chars(text: str) -> set[str]:
    bad = set()
    for ch in text:
        if ord(ch) < 128 or ch in _ALLOWED_NON_ASCII:
            continue
        bad.add(ch)
    return bad


def check_file(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        with path.open("rb") as fh:
            for tok in tokenize.tokenize(fh.readline):
                if tok.type == tokenize.COMMENT:
                    bad = _offending_chars(tok.string)
                    if bad:
                        errors.append(
                            f"{path}:{tok.start[0]}: non-English character(s) in "
                            f"comment: {' '.join(sorted(bad))}"
                        )
    except tokenize.TokenError as exc:
        errors.append(f"{path}: tokenize error: {exc}")
    return errors


def _collect(argv: list[str]) -> list[Path]:
    if argv:
        return [Path(a) for a in argv]
    roots = [Path("src"), Path("scripts")]
    return [p for root in roots if root.exists() for p in root.rglob("*.py")]


def main(argv: list[str]) -> int:
    paths = [p for p in _collect(argv) if p.suffix == ".py" and p.exists()]
    errors: list[str] = []
    for p in paths:
        errors.extend(check_file(p))
    if errors:
        print("English-only comment check FAILED:")
        for e in errors:
            print(f"  {e}")
        return 1
    print(f"English-only comment check passed ({len(paths)} file(s)).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
