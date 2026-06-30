#!/usr/bin/env python3
"""Enforce the v1 source-language policy on Python files (DESIGN §0).

Two checks:

1. **No Chinese (CJK) anywhere** — comments, string literals, docstrings alike.
   v1 sources contain no Chinese. The radio speaks Chinese only at runtime, from
   the model (the persona prompt sets the output language); it is never a
   hardcoded string.

2. **Comments are English-only** — a comment may hold ASCII plus a small
   allowlist of typographic punctuation (em/en dashes, ellipsis, curly quotes,
   the section sign used for spec refs like "§3.1"). Anything else fails. (CJK
   in a comment is already caught by check 1; this additionally bars other
   non-English scripts from comments.)

Usage:
    python scripts/check_source_language.py [FILE ...]

With no arguments, scans src/ and scripts/. Exits non-zero on any violation, so
it works as a pre-commit hook and in CI. Standard library only.
"""

from __future__ import annotations

import sys
import tokenize
from pathlib import Path

# Typographic punctuation acceptable in otherwise-English comments. These live
# in a string literal, not a comment, so this file passes its own comment rule.
_ALLOWED_NON_ASCII = set("—–…“”‘’§")


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x3000 <= o <= 0x303F  # CJK symbols and punctuation
        or 0x3040 <= o <= 0x30FF  # Hiragana + Katakana
        or 0x3400 <= o <= 0x4DBF  # CJK Unified Ideographs Extension A
        or 0x4E00 <= o <= 0x9FFF  # CJK Unified Ideographs
        or 0xAC00 <= o <= 0xD7AF  # Hangul syllables
        or 0xF900 <= o <= 0xFAFF  # CJK compatibility ideographs
        or 0xFF00 <= o <= 0xFFEF  # halfwidth and fullwidth forms
    )


def _check_no_cjk(path: Path, text: str) -> list[str]:
    errors: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        found = sorted({ch for ch in line if _is_cjk(ch)})
        if found:
            errors.append(
                f"{path}:{lineno}: Chinese/CJK not allowed in v1 sources: {' '.join(found)}"
            )
    return errors


def _check_comments_english(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        with path.open("rb") as fh:
            for tok in tokenize.tokenize(fh.readline):
                if tok.type != tokenize.COMMENT:
                    continue
                bad = sorted(
                    {
                        ch
                        for ch in tok.string
                        if ord(ch) >= 128
                        and ch not in _ALLOWED_NON_ASCII
                        and not _is_cjk(ch)
                    }
                )
                if bad:
                    errors.append(
                        f"{path}:{tok.start[0]}: non-English character(s) in comment: "
                        f"{' '.join(bad)}"
                    )
    except tokenize.TokenError as exc:
        errors.append(f"{path}: tokenize error: {exc}")
    return errors


def check_file(path: Path) -> list[str]:
    # The no-CJK check applies to every file type; the English-only-comment
    # check is Python-specific (it relies on tokenizing Python comments).
    text = path.read_text(encoding="utf-8")
    errors = _check_no_cjk(path, text)
    if path.suffix == ".py":
        errors += _check_comments_english(path)
    return errors


def _collect(argv: list[str]) -> list[Path]:
    if argv:
        return [Path(a) for a in argv]
    roots = [Path("src"), Path("scripts"), Path("tests")]
    return [p for root in roots if root.exists() for p in root.rglob("*.py")]


def main(argv: list[str]) -> int:
    # Explicit args (e.g. from pre-commit) may include non-Python files; those
    # get the no-CJK check. With no args, scan the Python sources under src/scripts.
    paths = [p for p in _collect(argv) if p.exists()]
    errors: list[str] = []
    for p in paths:
        errors.extend(check_file(p))
    if errors:
        print("Source-language check FAILED:")
        for e in errors:
            print(f"  {e}")
        return 1
    print(f"Source-language check passed ({len(paths)} file(s)).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
