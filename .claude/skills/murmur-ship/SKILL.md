---
name: murmur-ship
description: "Use when implementing, continuing, or shipping any murmur build task or spec step end-to-end — taking a named target (a spec/step, or the direction just agreed in this session) all the way to a delivered PR: build, test, review, commit, open the PR, and follow CI to a terminal state. Also triggers on /murmur-ship."
---

# murmur-ship — end-to-end build loop for murmur

Drive one murmur task from intent to a **delivered PR** through fixed gates, **in order, none skipped**. The build happens on the **main checkout** (solo repo, no worktree). The loop ends at a merged PR (or green-and-handed-over), not a local commit — CI is real now, so shipping means following it through.

**REQUIRED SUB-SKILL:** the build itself runs under `murmur-build-spec` (read spec → restate contract → clarify gate → test-first build → verify → keep spec aligned). This skill wraps that build with the test gate, a closing review, the commit, and delivery to a PR. **REQUIRED BACKGROUND:** `superpowers:test-driven-development`.

## The loop (every step required, in this order)

1. **Target.** Name the spec/step (per `murmur-build-spec`). A continuation ("continue" / "keep going" / "it" / empty args right after agreeing a direction) = that agreed direction. **Diagnose-first:** an investigation-phrased ask ("look into" / "why" / "root cause" / "investigate") with no fix order → state Fact / Inference / Question and checkpoint **before** any code.
2. **Build — test-first.** Run `murmur-build-spec`. Per requirement: deterministic logic → failing unit test → implement → green; stochastic output (Claude persona / Chinese / model-C behavior, voice quality) → the **eval track** (DESIGN §10.3 / §11.4, prefer Ollama), never a brittle assert on model text. Do not defer tests to the end.
3. **Test gate.** `pytest` all green. Max 3 fix→retry rounds; still red → **Paused** with the failing output. A flaky / non-deterministic failure → Paused (do not loop it to green).
4. **Verify acceptance.** Run the real thing and show evidence. **If the target touches the real Claude brain (`run_task`/`run_guide`), real `yt-dlp`, audio, or the interactive guide — i.e. what the unit gate's fakes can't prove — use `murmur-smoke` to run it for real (a throwaway `scratch/` script) before claiming done, and fold any finding back into a test (step 6). Fakes-green ≠ works at that seam.** Sensory criteria (sounds human, feels like radio, type-and-reply flows) → a **checklist for the user to run**, not self-declared.
5. **Closing review — prefer the other engine.** **After** the test gate is green, once per branch. Preferred reviewer is a *different* engine for independent eyes: if `codex` is installed and `codex login status` reports logged in, run
   `codex review -c model="gpt-5.5" -c model_reasoning_effort="xhigh" --base origin/main`
   (pin the model; 10-min timeout). Auth / quota / timeout = a **mechanical skip**, not "no findings" — say so. Fall back to the `code-review` skill only when codex is unavailable. Triage the findings with `superpowers:receiving-code-review`: verify each, fix the genuine ones (then re-run `pytest`), dismiss false positives with a one-line reason. One round. Record the outcome for the PR body: `Peer review (codex …): N findings, M applied, K dismissed` — or `Peer review: skipped — <reason>`.
6. **Lock against recurrence.** Any bug found (in build or review) → add the regression test that would have caught it, in the same change. Deterministic → unit test; stochastic → an eval detector or a noted eval gap.
7. **Commit.** Group into logical commits via `smart-commit`. The org commit-message convention applies. Stage explicit paths (the main checkout is shared) and commit with `PATH="$PWD/.venv/bin:$PATH"` so the `language: system` pre-commit hooks resolve.
8. **Deliver.** Invoke `create-pr` — it owns the local `check_pr.py` pre-check (exit 0 **before** pushing) → branch → push → open the PR. Then run the **Wait loop** below. Don't stop at "PR opened."

## Wait loop (after the PR is open)

- Watch: `gh pr checks <n> --watch`. Follow through in the same turn — stay in the loop or exit with an explicit "needs human" line.
- No checks registered after ~5 min → one empty `ci: nudge` commit → still none → exit **"CI not picking up."**
- Failed check → `gh run view --log-failed`. Infra flake (runner evicted / step canceled with no failing test) → rerun once, don't open a fix round. Real failure → targeted fix → push → **re-enter the watch**.
- Green → **merge is always squash**. If the invocation pre-authorized it ("merge it" / "just merge"), `gh pr merge --squash` then delete the local branch. Otherwise exit: **"PR green, awaiting your merge — <url>."**
- Re-enter the watch after any push. Exit only when no check is queued / in-progress / failed.

## Exit in exactly one of

- **Shipped** — gates green, acceptance verified, PR merged (or green + handed over per the merge knob). If it advanced the milestone or the next target, `specs/STATUS.md` reflects the new state (how: see `murmur-build-spec`).
- **Paused — needs human input** — a gate failed past budget, a sensory checklist is owed, CI won't pick up, or a decision is needed (spec divergence, an open question, a multi-source conflict). State exactly what's needed.
- **Won't-do** — decided against the change: close the PR, delete the branch, revert the working changes, and say why.

## Anti-patterns

- Backfilling tests at the end instead of test-first per step (the cardinal sin — see `murmur-build-spec`).
- Skipping the closing review, or running it before the test gate is green.
- Committing with the test gate red.
- Opening the PR and walking away from CI instead of following the Wait loop to a terminal state.
- Reacting to a CI title/description format failure that `check_pr.py` would have caught locally — run the pre-check first (see `create-pr`).
- Asserting on Claude's exact output in a unit test — that belongs in the eval track.
- Charging into a fix on an investigation-phrased ask without checkpointing.
- Declaring "done" before a user-set acceptance bar is met.
