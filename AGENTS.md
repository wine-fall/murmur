# murmur — agent brief

Read this first, every session. It is the routing card, not the design.

## What this is

A fully-local companion "radio" — always on the air, Claude as its brain, a
voice that sounds human, keyboard-driven replies. Vision: `README.md`.
Master spec: `specs/DESIGN.md`. Do not duplicate either here; go read them.

## Commands

- `make dev` — dependency report + run the radio (diagnostics stream to
  `.dev/dev.log`). The report never blocks: the radio always launches, degraded
  if need be, and offers to fix its own gaps by talking (spec 03-03 §7).
- `make logs` — tail those diagnostics (run in a 2nd terminal).
- `make preflight` — report the dependencies without launching.
- `make setup` / `make setup-music` — the onboarding conversation on demand
  (whole surface / just the music binaries).
- `STUB=1 make dev` — full offline: canned brain, silent voice, no music.
- `TUI=0 make dev` — plain stdout instead of the spec-10 front-end, which is
  the default (without `bun` it falls back to plain on its own).
- `pnpm test` — the fast (model-free) vitest suite; `pnpm run typecheck` /
  `pnpm run lint` — the static gates.
- `pre-commit run --all-files` — all gates (source-language + tsc + oxlint +
  path-governance).

## Map / routing

- `specs/DESIGN.md` = master; `specs/specNN/` = sub-specs. Specs are written
  for a coding agent (explicit contracts, verifiable acceptance), **English only**.
- `specs/STATUS.md` = the live current-focus. Read it at the start of a build.
- Skills:
  - `murmur-ship` — any build task end-to-end, from intent to a delivered PR.
  - `murmur-build-spec` — spec discipline + test-first (ship runs it for you).
  - `murmur-smoke` — real-boundary probing in a throwaway `scratch/` script.
  - `murmur-issue` — a bug/feature/debt becomes a GitHub issue: open / close /
    sync, evidence gathered from the session, one pointer line in STATUS.md
    `## Open`.
  - `create-pr` — push + open the PR (runs the local CI pre-check first).
  - `murmur-release` — cut a version end-to-end: bump + release PR, tag on the
    release commit, GitHub Release with notes, npm publish (the npm login is
    the user's own act, never automated).
- graphify: before any broad code search, run `graphify query "<question>"`.
  A post-commit hook rebuilds the graph for **code** changes only; doc/spec
  edits are not auto-indexed. Do **not** run `/graphify --update` per PR —
  batch the doc debt: run it only once ~10 PRs have landed since the last
  update, or when a graph query visibly misses recent docs. `graphify-out/`
  is gitignored; never commit it.

## Working norms / red lines

- **Test-first per build step** — full discipline in `murmur-build-spec`; never
  backfill tests.
- **"Prompt green" ≠ engine delivers** — the Claude brain narrating a
  `submit_pick` or a line is not proof the song played or the pick landed.
  Before claiming done, read the deterministic seam (the MCP tool, the engine)
  or `.dev/dev.log` — never trust the model's self-report.
- **English** for all committed source/specs/docs (pre-commit enforces it,
  markdown included); **Chinese** for conversation with the user.
- **Never `git add -A` / `git add .`** — the main checkout is shared across
  sessions and holds other sessions' scratch; stage explicit paths.
- **Linked worktree env**: a fresh linked worktree does not inherit the
  gitignored `.env*` (remote-voice creds); `make install` / `make dev` auto-sync
  them from the main worktree via `make sync-env` (copy-if-absent). They never
  carry over on their own.
- **Never gate a commit/push on a piped command's exit code** (`pnpm test | tail`
  reports `tail`'s exit) — run the gating command bare and check its real code.
- `git commit` runs `language: system` pre-commit hooks — `node`/`npx` must be
  on PATH (`make install` provisions the `pre-commit` runner itself via
  `uv tool install`).
- The **ponytail** plugin is enabled on purpose (minimal-code ladder): before
  writing new code, climb it — needed at all? already in the codebase? stdlib?
  one line?
- **Types: `any` is banned; `unknown` is a last resort.** Exhaust precise
  types / generics / discriminated unions / `z.infer` first. `unknown` is
  legitimate only at a trust boundary and must be narrowed (zod parse) at the
  point of entry — never passed downstream. `any` needs an
  `oxlint-disable-next-line no-explicit-any` + a one-line reason, only where
  an SDK boundary is genuinely unsolvable (`src/contracts.ts` `TaskTool` is
  the one example). oxlint enforces the rule (`.oxlintrc.json`).
- **Comments state current intent, not edit-history** — no "used to / renamed
  from / now X, was Y" or date/commit stamps; delete a stale comment when you
  move its code. This is AI-rot's most common vector.
- **Decision style:** mid-task, pick the recommended option and keep going; log
  every decision and batch the log + reasons at the end. Reserve a clarify-gate
  stop for material, hard-to-reverse forks only.
- `scratch/` is gitignored and never committed. Never run the brain/guide with
  `bypassPermissions` unsupervised.
