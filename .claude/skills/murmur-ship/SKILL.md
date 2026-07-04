---
name: murmur-ship
description: "Use when implementing, continuing, or shipping any murmur build task or spec step end-to-end in the local repo — taking a named target (a spec/step, or the direction just agreed in this session) all the way to committed code. Also triggers on /murmur-ship. The murmur repo is local-only; this builds, tests, reviews, and commits — it does not push."
---

# murmur-ship — end-to-end build loop for murmur

Drive one murmur task from intent to committed code through fixed gates, **in order, none skipped**. The repo is **local-only** (no remote, CI, PR, or tickets): the loop ends at a clean local commit, never a push.

**REQUIRED SUB-SKILL:** the build itself runs under `murmur-build-spec` (read spec → restate contract → clarify gate → test-first build → verify → keep spec aligned). This skill wraps that build with the test gate, a closing review, and the commit. **REQUIRED BACKGROUND:** `superpowers:test-driven-development`.

## The loop (every step required, in this order)

1. **Target.** Name the spec/step (per `murmur-build-spec`). A continuation ("继续" / "it" / empty args right after agreeing a direction) = that agreed direction. **Diagnose-first:** an investigation-phrased ask (看看 / 研究 / 为什么 / 根因 / "why" / "root cause") with no fix order → state Fact / Inference / Question and checkpoint **before** any code.
2. **Build — test-first.** Run `murmur-build-spec`. Per requirement: deterministic logic → failing unit test → implement → green; stochastic output (Claude persona / Chinese / model-C behavior, voice quality) → the **eval track** (DESIGN §10.3 / §11.4, prefer Ollama), never a brittle assert on model text. Do not defer tests to the end.
3. **Test gate.** `pytest` all green. Max 3 fix→retry rounds; still red → **Paused** with the failing output. A flaky / non-deterministic failure → Paused (do not loop it to green).
4. **Verify acceptance.** Run the real thing and show evidence. **If the target touches the real Claude brain (`run_task`/`run_guide`), real `yt-dlp`, audio, or the interactive guide — i.e. what the unit gate's fakes can't prove — use `murmur-smoke` to run it for real (a throwaway `scratch/` script) before claiming done, and fold any finding back into a test (step 6). Fakes-green ≠ works at that seam.** Sensory criteria (sounds human, feels like radio, type-and-reply flows) → a **checklist for the user to run**, not self-declared.
5. **Closing review.** Run the `code-review` skill on the working diff — **after** the test gate is green. Triage with `superpowers:receiving-code-review`: verify each finding, fix the genuine ones (then re-run `pytest`), dismiss false positives with a one-line reason. One round.
6. **Lock against recurrence.** Any bug found (in build or review) → add the regression test that would have caught it, in the same change. Deterministic → unit test; stochastic → an eval detector or a noted eval gap.
7. **Commit.** Group into logical commits via `smart-commit`. **Local only — never push** unless explicitly asked. The org commit-message convention applies.

## Exit in exactly one of

- **Shipped** — gates green, acceptance verified, committed.
- **Paused — needs human input** — a gate failed past budget, a sensory checklist is owed, or a decision is needed (spec divergence, an open question, a multi-source conflict). State exactly what's needed.
- **Won't-do** — decided against the change: revert the working changes and say why.

## Anti-patterns

- Backfilling tests at the end instead of test-first per step (the cardinal sin — see `murmur-build-spec`).
- Skipping the closing `code-review`, or running it before the test gate is green.
- Committing with the test gate red, or pushing (the repo is local-only).
- Asserting on Claude's exact output in a unit test — that belongs in the eval track.
- Charging into a fix on an investigation-phrased ask without checkpointing.
- Declaring "done" before a user-set acceptance bar is met.
