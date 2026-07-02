#!/usr/bin/env python3
"""Validate a pull request's title and description against murmur conventions.

Reads PR_TITLE and PR_BODY from the environment (set by the workflow) and runs
from the repo root so referenced spec files can be checked on disk.

Rules
-----
1. Conventional Commits: the title starts with a recognized type, an optional
   ``(scope)``, an optional breaking ``!``, then ``: `` and a subject.
2. Spec tag: the title contains ``[spec NN]`` (or ``[spec NN-NN]`` for a
   sub-spec), e.g. ``[spec 01]`` / ``[spec 03-01]``.
3. Spec link: the description references at least one spec file that actually
   exists (``specs/NN-....md``), and its number matches the title's spec tag.

Rules 2-3 apply only to product-behavior PRs (``feat``/``fix``/``perf``/
``refactor``); infra/meta types (``ci``/``chore``/``docs``/``build``/``style``/
``test``/``revert``) are exempt from the spec requirement — they still must
satisfy rule 1.

Stdlib-only by design (mirrors scripts/check_source_language.py). Exit 0 on
pass, 1 on any violation, with GitHub Actions ``::error::`` annotations.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

# Conventional Commits types (the widely-used Angular set).
TYPES = (
    "build",
    "chore",
    "ci",
    "docs",
    "feat",
    "fix",
    "perf",
    "refactor",
    "revert",
    "style",
    "test",
)

# Types whose PRs must reference a spec (product behavior). The rest are meta.
REQUIRE_SPEC = {"feat", "fix", "perf", "refactor"}

TITLE_RE = re.compile(rf"^(?:{'|'.join(TYPES)})(?:\([^)]+\))?!?: .+")
TYPE_RE = re.compile(r"^([a-z]+)")
# [spec 01] / [spec 03-01] / [spec1]  (space optional, sub-spec optional)
SPEC_TAG_RE = re.compile(r"\[spec ?(\d{1,2}(?:-\d{1,2})?)\]", re.IGNORECASE)
# A concrete spec path anywhere in the body: specs/03-01-brain-harness.md
SPEC_PATH_RE = re.compile(r"specs/\d{2}(?:-\d{2})?-[a-z0-9-]+\.md")
SPEC_ID_RE = re.compile(r"specs/(\d{2}(?:-\d{2})?)-")


def _norm(spec_id: str) -> str:
    """Zero-pad each numeric part so '3-1' and '03-01' compare equal."""
    return "-".join(part.zfill(2) for part in spec_id.split("-"))


def _emit(errors: list[str]) -> None:
    for err in errors:
        head, *rest = err.splitlines()
        print(f"  - {head}")
        for line in rest:
            print(f"    {line}")


def main() -> int:
    title = os.environ.get("PR_TITLE", "").strip()
    body = os.environ.get("PR_BODY") or ""

    errors: list[str] = []

    if not TITLE_RE.match(title):
        errors.append(
            "Title must start with a Conventional Commits type "
            f"({', '.join(TYPES)}) then ': '.\n"
            "e.g.  feat(voice): add Spark backend [spec 02]"
        )

    type_match = TYPE_RE.match(title)
    pr_type = type_match.group(1) if type_match else ""

    # Spec tag + linked spec path are required only for product-behavior PRs.
    if pr_type in REQUIRE_SPEC:
        tag_match = SPEC_TAG_RE.search(title)
        if not tag_match:
            errors.append(
                "Title must carry a spec tag: [spec 01], or [spec 03-01] for a "
                "sub-spec."
            )

        # Description must link a spec file that exists on disk.
        linked_paths = SPEC_PATH_RE.findall(body)
        existing_paths = [p for p in linked_paths if Path(p).is_file()]
        existing_ids = {
            _norm(m.group(1))
            for p in existing_paths
            if (m := SPEC_ID_RE.match(p))
        }

        if not linked_paths:
            errors.append(
                "Description must link the corresponding spec file by path, "
                "e.g. specs/03-01-brain-harness.md."
            )
        elif not existing_paths:
            errors.append(
                "The spec path(s) in the description do not exist in the repo: "
                f"{sorted(set(linked_paths))}."
            )

        # Cross-check: the title's [spec NN] must match a linked, existing spec.
        if tag_match and existing_ids:
            tag_id = _norm(tag_match.group(1))
            if tag_id not in existing_ids:
                errors.append(
                    f"Title tag [spec {tag_match.group(1)}] does not match any "
                    f"spec linked in the description (found "
                    f"{sorted(existing_ids)}). Keep the title tag and the linked "
                    "spec path consistent."
                )

    if errors:
        print(f"::error::Invalid PR title/description: {title!r}")
        _emit(errors)
        print()
        print("Example title:        feat(brain): add music search [spec 03-01]")
        print("Example description:  Implements specs/03-01-brain-harness.md")
        return 1

    print(f"OK: {title}")
    if pr_type not in REQUIRE_SPEC:
        print(f"({pr_type}: spec reference not required)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
