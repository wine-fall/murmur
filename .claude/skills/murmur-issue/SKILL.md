---
name: murmur-issue
description: "Use when the user reports a bug, asks for a feature, or wants something recorded for later ('file an issue', 'record this bug', 'open a ticket for X' — in any language), or on /murmur-issue <description> — capture it as a well-formed GitHub issue by gathering the evidence this session already holds (logs, measurements, code seams, spec sections) instead of asking the user to write it."
---

# murmur-issue — capture a bug or feature as a GitHub issue

Turn "we should fix/build X" into an issue a future agent can pick up cold.
The issue body is a contract, written like the specs: explicit, verifiable,
no narration. This skill owns the **birth** of an issue; `murmur-backlog`
owns everything after it (close, sync, the STATUS.md pointer).

## Procedure

1. **Admission gate.** Only work that outlives the current PR/session gets an
   issue (`murmur-backlog`'s rule). An in-flight TODO belongs in the code or
   the current PR, not the tracker. Fails the gate → say so and stop.
2. **Gather evidence before writing.** The session usually already holds it:
   error output, `.dev/dev.log` lines, measured numbers, the code seam
   (`file:line`), the governing spec section. Missing pieces that are cheap to
   fetch (a grep, a spec read, `graphify query`) — fetch them now. What you
   cannot verify, mark **suspected, NOT verified**; never dress a hypothesis
   as a finding. Precedent: issue #77 labeled its suspect list exactly so,
   and the dominant root cause turned out to be elsewhere.
3. **Classify on two axes** (labels compose — #77 is `bug, eng`):
   - **Nature**: `bug` (a spec'd contract is violated — cite the section) or
     `enhancement` (behavior is within contract but should be better).
   - **Lifecycle** (`murmur-backlog`'s taxonomy — decides who can close it):
     `eng` (an agent closes it with a PR), `by-ear` (only the user's senses
     can close it), `watch` (act only if it recurs).
4. **Write the body** (English, like all tracked text). Three sections:
   - **What it is** — bug: reproduction + observed vs expected, suspects
     labeled; feature: motivation + rough shape + explicit non-goals.
   - **Spec** — the governing `specs/...md` path and section; for a bug, the
     contract line being violated.
   - **Done when** — a verifiable close condition: for `eng`, what a PR must
     demonstrate; for `by-ear`, what the user will judge.
5. **File it.** `gh auth switch --user wine-fall`, then `gh issue create`
   with title, labels, and the body. Report the URL back.
6. **Leave the lifecycle to `murmur-backlog`.** The one-line `#N` pointer in
   STATUS.md's `## Open` rides the current PR if one is already open;
   otherwise the next `murmur-backlog` sync carries it. Never open a PR just
   for the pointer, and never touch STATUS.md beyond that one line.

## Anti-patterns

- Asking the user to describe what the session already witnessed.
- A body that says "see conversation" — the future reader has no conversation.
- An unverified hypothesis stated as the root cause.
- Opening an issue for an in-PR leftover (fails the admission gate).
- Duplicating a ticket `gh issue list` would have shown — search first.
