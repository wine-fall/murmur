---
name: create-pr
description: Use when opening, pushing, or updating a GitHub pull request for the murmur repo (after a local commit is ready) — including when a PR's CI "check / Validate PR title + description" fails, or when a `gh pr edit --body` silently does nothing.
---

# create-pr — open a murmur PR that passes CI on the first try

## Core principle

**The PR title/description gate runs `.github/scripts/check_pr.py`, and that script runs locally.** Run it locally with your intended title+body and require **exit 0 before you push** — never discover a format failure on CI. Everything below is the murmur-specific procedure around that pre-check.

This picks up where `murmur-ship` ends (a clean local commit). It pushes and opens the PR — `murmur-ship` itself never does.

## Procedure (in order)

1. **Draft the title.** Conventional Commits: `type(scope): summary`. For product-behavior types (`feat`/`fix`/`perf`/`refactor`) the title MUST also carry a spec tag `[spec NN]` or `[spec NN-NN]` (e.g. `feat(voice): add X [spec 02]`). Meta types (`chore`/`docs`/`ci`/`style`/`test`/`build`/`revert`) need no tag.

2. **Draft the body** to a file (`gh` handles multi-line from a file cleanly). It MUST contain:
   - For product-behavior PRs: at least one **`specs/<...>.md` path that exists on disk** (e.g. `specs/spec02/02-voice-provider.md`) — a bare `DESIGN.md` or "spec 02" does NOT match. An `Implements specs/...md` line is the simplest way.
   - The org-required **`## AI coding brief`** section with three parts: **Original request** (+ the why), **Manual interventions** (human feedback that redirected the work), **Retro** (how to prompt better to ship faster).
   - A final footer line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

3. **Pre-check LOCALLY — require exit 0 before pushing:**
   ```bash
   PR_TITLE="feat(voice): add X [spec 02]" \
   PR_BODY="$(cat /path/to/body.md)" \
   python3 .github/scripts/check_pr.py; echo "exit=$?"
   ```
   Non-zero → fix title/body and re-run. Do not push until it says `OK:`.

4. **Branch + push.** Branch name is org-standard `{first}{lastname_initial}-{mm}{dd}--{feature}` (e.g. `zachg-0704--add-voxcpm2`). **Never push to `main`/`master`.** `git push -u origin <branch>`.

5. **Create the PR** against `main`:
   ```bash
   gh pr create --base main --head <branch> --title "<title>" --body-file /path/to/body.md
   ```

6. **Merge is squash.** Org rule: squash merge only, no direct push to master.

## Editing the body later — use the REST API, not `gh pr edit`

`gh pr edit --body`/`--body-file` can **silently no-op** (exit non-zero on a `Projects (classic) … deprecated` GraphQL error, leaving the body unchanged). Verify, and if it didn't take, PATCH via REST — which doesn't touch the projectCards query:

```bash
gh api repos/<owner>/<repo>/pulls/<N> -X PATCH -F body=@/path/to/body.md --jq '.body' \
  | grep -oE 'specs/[[:alnum:]./_-]+\.md'   # confirm the spec path actually landed
```

## What `check_pr.py` enforces (so you can satisfy it)

| Rule | Requirement |
|---|---|
| Title format | `type(scope)!: summary` — type ∈ build/chore/ci/docs/feat/fix/perf/refactor/revert/style/test |
| Spec tag (feat/fix/perf/refactor only) | `[spec NN]` or `[spec NN-NN]` in the **title** |
| Spec link (feat/fix/perf/refactor only) | a `specs/…​.md` **path in the body that exists on disk** |

## Common mistakes

- **Opening the PR, then reacting to CI.** The gate is local — run step 3 first. This is the failure this skill exists to prevent.
- Body says "spec 02 §3.3" or "DESIGN.md" but no `specs/…/*.md` path → gate fails ("must link a spec file … by path").
- A `specs/…md` path that's a typo / doesn't exist on disk → gate fails ("path(s) … do not exist").
- Trusting `gh pr edit` succeeded without verifying the body changed.
- Pushing straight to `main`, or planning a non-squash merge.

## Red flags — STOP

- About to `git push` / `gh pr create` without having seen `check_pr.py` print `OK:` locally.
- A product-behavior PR whose body has no on-disk `specs/*.md` path, or whose title has no `[spec NN]`.
- Missing the `## AI coding brief` section.
