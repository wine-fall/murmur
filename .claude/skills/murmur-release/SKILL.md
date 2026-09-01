---
name: murmur-release
description: Use when cutting a murmur release — "release 0.1.3", "ship a version", "cut a release", "publish to npm", "tag a release" (in any language), or /murmur-release. Owns the whole ritual: the version decision, the release PR, the tag, the GitHub Release with notes, and the npm publish. Not for ordinary PRs (that is murmur-ship).
---

# murmur-release — one version, one tag, one release, one publish

A murmur release is **four artifacts that must agree**, in this order:

1. the version in `package.json`, landed on `main` through a PR;
2. a git tag `vX.Y.Z` **on that release commit**;
3. a GitHub Release on that tag, carrying notes a listener can read;
4. the npm package `murmur-radio@X.Y.Z`.

Any one of them alone is a half-release. The order is not negotiable: the tag
names a commit that must already be on `main`, the Release needs the tag, and
the publish ships what the tag points at.

**The version is now load-bearing.** `packageVersion()` (`src/config.ts`) reads
`package.json` at runtime, and that string reaches `murmur --version`, the plain
host's banner, and — the reason it matters — the **version field of every bug
report** a listener files. A release whose `package.json` was never bumped makes
every report from it point at the wrong code.

## Preflight — refuse to start unless all of this holds

```bash
git switch main && git pull --ff-only
git status --porcelain            # must be empty
gh auth switch --user wine-fall   # zach-guo-opus has no write access here
```

Then the gates, **each run bare** — never pipe them, a pipe reports the exit
code of the last stage, not the gate (repo-wide rule, `CLAUDE.md`):

```bash
pnpm test
pnpm run typecheck
npx oxlint src test scripts .github/scripts   # NOT `pnpm run lint` — the rtk hook rewrites it to eslint
(cd tui && bun run typecheck)
```

A red gate ends the release. Do not "release anyway and fix forward": the tag
is the thing people install.

## Deciding the version

Read what has landed since the last tag, and let the Conventional Commit types
decide — the PR titles are already machine-graded by `pr-conventions.yml`, so
this is a reading, not a judgement call:

```bash
git describe --tags --abbrev=0            # the previous tag, e.g. v0.1.2
git log v0.1.2..main --oneline | cat
```

| What landed since the last tag | Bump |
|---|---|
| any `feat` | **minor** (0.1.2 → 0.2.0 once past 1.0; pre-1.0 see below) |
| only `fix` / `perf` | **patch** |
| only `chore` / `docs` / `ci` / `test` / `refactor` | **patch**, and ask whether it is worth a release at all |
| a breaking change | pre-1.0: **minor**; post-1.0: **major** |

**murmur is pre-1.0**, so the practical rule today is: features and fixes both
go to **patch** (0.1.2 → 0.1.3) unless the release changes how an existing
install behaves, which earns the minor. State the bump and the reason in one
sentence before doing anything else.

## 1. The release PR

`main` is protected: no direct pushes, required checks `check` and `test`, zero
required reviewers. So the bump goes through a PR like everything else.

```bash
git switch -c zachg-<mmdd>--release-X.Y.Z
```

Edit `package.json`'s `version` — **that one line, nothing else**. A release PR
that also carries code is not a release PR; land the code first.

Commit as `chore(release): X.Y.Z`, and write the **human summary in the commit
body** — a short paragraph naming what a listener actually gets, in murmur's
voice, not a list of PR titles (the generated notes do that part). The 0.1.2
commit is the shape to copy:

> Ten commits since v0.1.1 — the TUI's station ident and progress rail, the
> settings pane's second way in, first-run speaking the listener's language,
> the listening-data seam, and the two figure fixes that landed today.

Keep that paragraph: step 3 reuses it verbatim as the Release's opening.

Open the PR with the `create-pr` skill, let CI go green, squash-merge it.

## 2. The tag — on the release commit, not on HEAD

```bash
git switch main && git pull --ff-only
git log -1 --oneline                       # must be the chore(release) commit
git tag -a vX.Y.Z -m "murmur X.Y.Z"
git push origin vX.Y.Z
```

**This is where the ritual has gone wrong before.** `v0.1.1` points at
`f7c3be4`, a `docs(readme)` commit — whatever happened to be HEAD at the time —
not at a release commit. A tag on the wrong commit makes the Release's
generated notes span the wrong range and makes `git describe` lie. Confirm the
commit under the tag before pushing it.

## 3. The GitHub Release

Compose the notes deterministically rather than relying on flag combinations:
ask GitHub for the generated half, then put the human paragraph on top.

```bash
gh api -X POST repos/wine-fall/murmur/releases/generate-notes \
  -f tag_name=vX.Y.Z -f target_commitish=main -f previous_tag_name=vPREV \
  --jq .body > /tmp/notes-generated.md
```

That returns a `## What's Changed` list — one line per merged PR with author and
link — plus a **Full Changelog** compare link. murmur's PR titles are written to
be read, so this half needs no editing; the `[spec NN]` tags are noise a reader
skips over, and stripping them costs more than it buys.

Build the file as: the human paragraph from the release commit, a blank line,
then the generated body. Then:

```bash
gh release create vX.Y.Z --verify-tag --title "murmur X.Y.Z" --notes-file /tmp/notes-final.md
```

`--verify-tag` aborts if the tag is not on the remote, which is the failure you
want loud — without it `gh` silently creates a tag of its own on the default
branch's HEAD, reintroducing the `v0.1.1` bug.

## 4. npm publish — the credential boundary

```bash
npm whoami
```

**If this fails with E401, stop and hand it to the user.** Logging in is their
act, not yours: ask them to run `npm login` themselves (in Claude Code, the
`! npm login` prefix runs it in-session). Never enter, echo, or store npm
credentials or a token.

Publishing is outward-facing and effectively irreversible — npm allows unpublish
only within 72 hours, and a version number is never reusable. **Say what is
about to ship and get an explicit yes before running it**, even mid-task:

> About to publish murmur-radio@X.Y.Z to npm as `latest`. Confirm?

```bash
npm publish
```

`prepack` runs on its own: it wipes `dist/`, compiles with
`tsconfig.build.json`, and copies `src/prompts/persona-seed.md` into
`dist/prompts/`. What ships is the `files` list in `package.json` — `dist`,
`src/ipc.ts`, `src/activity.ts`, `assets`, and the `tui/` sources. If a release
adds a new runtime asset outside those paths, `files` must learn about it in the
same release or the published package is broken while the repo looks fine.

## 5. Verify, then say so plainly

```bash
npm view murmur-radio dist-tags                    # latest == X.Y.Z
gh release view vX.Y.Z --json tagName,isLatest
git describe --tags --abbrev=0                     # vX.Y.Z
```

Then report the four artifacts and the install line
(`npm install -g murmur-radio`). A release is not "done" because the publish
command exited zero — read the registry back.

## Failure modes worth knowing before you hit them

| Symptom | What it actually is |
|---|---|
| `gh pr checks` says `no checks reported`, forever | The PR conflicts with main. GitHub builds `pull_request` workflows on the merge ref, which cannot exist while conflicted, so **zero** checks are created. Check `gh pr view <N> --json mergeable`; rebase. Never poll with `until gh pr checks` — it cannot terminate. |
| `npm publish` → E401/E403 | Not logged in, or logged in as someone without publish rights on `murmur-radio`. The user's act; see step 4. |
| Release notes span too many PRs | The previous tag is on the wrong commit (the `v0.1.1` bug). Pass `previous_tag_name` explicitly rather than letting GitHub guess. |
| `git push origin vX.Y.Z` rejected | The tag already exists remotely. Never force-push a tag people may have installed against — cut the next patch instead. |

## Backfilling the releases that were never created

`v0.1.0`, `v0.1.1` and `v0.1.2` are tagged but have **no GitHub Release**, so
the Releases page is empty for everything before this skill existed. Backfill is
optional and safe: `gh release create <tag> --verify-tag --notes-file …` on an
existing tag creates the Release without moving anything. Take each one's human
paragraph from its release commit body, and pass `previous_tag_name` explicitly
— `v0.1.1`'s misplaced tag makes the automatic guess wrong. Mark old ones
`--latest=false` so the newest release keeps the "Latest" badge.
