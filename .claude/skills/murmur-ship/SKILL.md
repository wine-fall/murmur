---
name: murmur-ship
description: "Use when implementing, continuing, or shipping any murmur build task or spec step end-to-end — taking a named target (a spec/step, or the direction just agreed in this session) all the way to a delivered PR: build, test, review, commit, open the PR, and follow CI to a terminal state. Also triggers on /murmur-ship."
---

# murmur-ship — end-to-end build loop for murmur

Drive one murmur task from intent to a **delivered PR** through fixed gates, **in order, none skipped**. The build happens in a **linked git worktree, never in the shared main checkout** (step 2) — other sessions live in that checkout and hold uncommitted work there. The loop ends at a merged PR (or green-and-handed-over), not a local commit — CI is real now, so shipping means following it through.

**REQUIRED SUB-SKILL:** the build itself runs under `murmur-build-spec` (read spec → restate contract → clarify gate → test-first build → verify → keep spec aligned). This skill wraps that build with the test gate, a closing review, the commit, and delivery to a PR. **REQUIRED BACKGROUND:** test-first discipline — write the failing test before the implementation (spelled out in `murmur-build-spec`).

## The loop (every step required, in this order)

1. **Target.** Name the spec/step (per `murmur-build-spec`). A continuation ("continue" / "keep going" / "it" / empty args right after agreeing a direction) = that agreed direction. **GitHub issue link/number in the invocation** → `gh issue view <n>` (fetch body + checklist) **first**, and treat that issue as the target's context and contract: its description scopes the work and any checklist items become the acceptance to verify (step 5). If it names a phased plan, ship the phase the user pointed at, not the whole issue. **Diagnose-first:** an investigation-phrased ask ("look into" / "why" / "root cause" / "investigate") with no fix order → state Fact / Inference / Question and checkpoint **before** any code.
2. **Worktree — before you touch a single file.** Create a linked worktree on a fresh branch and do all the work there — worktrees live inside the repo under the gitignored `.worktrees/` directory: from the main checkout, `git worktree add -b <branch> .worktrees/<name> main`. Never build, edit, or commit in the shared main checkout — other sessions run out of it and keep uncommitted scratch there, so building on it risks colliding with (or staging) their work. A fresh linked worktree does **not** inherit the gitignored `.env*` (remote-voice creds); `make install` / `make dev` sync them from the main worktree via `make sync-env` (copy-if-absent), so run one of those before anything that needs real credentials.
3. **Build — test-first.** Run `murmur-build-spec`. Per requirement: deterministic logic → failing unit test → implement → green; stochastic output (Claude persona / Chinese / model-C behavior, voice quality) → the **eval track** (DESIGN §10.3 / §11.4, prefer Ollama), never a brittle assert on model text. Do not defer tests to the end.
4. **Test gate.** `pnpm test` (vitest) all green, plus `pnpm run typecheck` and `pnpm run lint`. Max 3 fix→retry rounds; still red → **Paused** with the failing output. A flaky / non-deterministic failure → Paused (do not loop it to green).
5. **Verify acceptance.** Run the real thing and show evidence. **If the target touches the real Claude brain (`run_task`/`run_guide`), real `yt-dlp`, audio, or the interactive guide — i.e. what the unit gate's fakes can't prove — use `murmur-smoke` to run it for real (a throwaway `scratch/` script) before claiming done, and fold any finding back into a test (step 7). Fakes-green ≠ works at that seam.** Sensory criteria (sounds human, feels like radio, type-and-reply flows) → a **checklist for the user to run**, not self-declared.
6. **Closing review — prefer the other engine.** **After** the test gate is green, once per branch. Preferred reviewer is a *different* engine for independent eyes: if `codex` is installed and `codex login status` reports logged in, run
   `codex review -c model="gpt-5.5" -c model_reasoning_effort="xhigh" --base origin/main`
   (pin the model; 10-min timeout). Auth / quota / timeout = a **mechanical skip**, not "no findings" — say so. Fall back to the `code-review` skill only when codex is unavailable. Triage the findings with technical rigor — do not blindly implement: verify each against the code, fix the genuine ones (then re-run `pnpm test`), dismiss false positives with a one-line reason. One round. Record the outcome for the PR body: `Peer review (codex …): N findings, M applied, K dismissed` — or `Peer review: skipped — <reason>`.
7. **Lock against recurrence.** Any bug found (in build or review) → add the regression test that would have caught it, in the same change. Deterministic → unit test; stochastic → an eval detector or a noted eval gap.
8. **Commit.** Group into logical commits via `smart-commit`. The org commit-message convention applies. Commit inside the worktree from step 2, never in the main checkout. Stage explicit paths — never `git add -A` / `git add .`; the pre-commit gates (source-language + tsc + oxlint + path-governance) run on commit and need `node`/`npx` on PATH.
9. **Deliver.** Invoke `create-pr` — it owns the local `check-pr.ts` pre-check (exit 0 **before** pushing) → branch → push → open the PR. Then run the **Wait loop** below. Don't stop at "PR opened."

## Wait loop (after the PR is open)

- Watch: `gh pr checks <n> --watch`. Follow through in the same turn — stay in the loop or exit with an explicit "needs human" line.
- No checks registered after ~5 min → one empty `ci: nudge` commit → still none → exit **"CI not picking up."**
- Failed check → `gh run view --log-failed`. Infra flake (runner evicted / step canceled with no failing test) → rerun once, don't open a fix round. Real failure → targeted fix → push → **re-enter the watch**.
- Green → **merge is always squash**. If the invocation pre-authorized it ("merge it" / "just merge"), `gh pr merge --squash`, then run **Post-merge cleanup** below. Otherwise exit: **"PR green, awaiting your merge — <url>."** (run the cleanup on the next invocation, once the user has merged.)
- Re-enter the watch after any push. Exit only when no check is queued / in-progress / failed.

## Post-merge cleanup (once the PR is actually merged)

After the PR merges — whether you merged it or the user did — leave the local repo clean for the next task. Every build ran in a worktree (step 2), so **all three steps below are mandatory, in this order** — none of them is conditional:

1. **Verify the merge.** `gh pr view <n> --json state` must report `MERGED`, and `git status` inside the worktree must be clean. Anything unmerged or uncommitted → stop and say so; never delete work.
2. **Remove the worktree.** `git worktree remove <path>`, then delete the merged local branch and prune its stale remote-tracking ref.
3. **Back to `main` and pull.** Return to the main checkout and `git pull`, so the next build branches off the merged tip — which now includes your change and anything else that landed.

## Exit in exactly one of

- **Shipped** — gates green, acceptance verified, PR merged (or green + handed over per the merge knob). When merged: the worktree and its branch are removed and the main checkout is back on an up-to-date `main` (see Post-merge cleanup — all three steps, always). If it advanced the milestone or the next target, `specs/STATUS.md` reflects the new state (how: see `murmur-build-spec`). Anything the build found but did not fix — an owed by-ear pass, a measured defect, a watch item — leaves through `murmur-issue` (an issue plus one pointer line), never as a paragraph in STATUS.md.
- **Paused — needs human input** — a gate failed past budget, a sensory checklist is owed, CI won't pick up, or a decision is needed (spec divergence, an open question, a multi-source conflict). State exactly what's needed.
- **Won't-do** — decided against the change: close the PR, remove the worktree, delete the branch, and say why.

## Anti-patterns

- Backfilling tests at the end instead of test-first per step (the cardinal sin — see `murmur-build-spec`).
- Skipping the closing review, or running it before the test gate is green.
- Committing with the test gate red.
- Opening the PR and walking away from CI instead of following the Wait loop to a terminal state.
- Reacting to a CI title/description format failure that `check-pr.ts` would have caught locally — run the pre-check first (see `create-pr`).
- Asserting on Claude's exact output in a unit test — that belongs in the eval track.
- Charging into a fix on an investigation-phrased ask without checkpointing.
- Declaring "done" before a user-set acceptance bar is met.
- Building, editing, or committing in the shared main checkout instead of a linked worktree — step 2 is not optional.
- Leaving the merged worktree/branch behind or a stale local `main` after shipping — Post-merge cleanup runs in full, every time, once the PR is merged.
