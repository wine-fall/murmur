---
name: murmur-handoff
description: Use when the user wants to hand off work to a fresh session — asks to "hand off", "write a handoff", "prep a prompt for another session", or types /murmur-handoff. Produces ONE self-contained prompt the user can paste into a new murmur session and run directly. With args, it captures the stated handoff requirements; with no args, it infers the next step from this session.
---

# murmur-handoff — produce a paste-ready prompt for a fresh session

## What it does

Emit **one fenced code block** holding a prompt the user copies into a new
murmur session verbatim. The receiving session has none of this conversation's
context — the prompt must stand alone. Nothing else is the deliverable; keep any
prose around the block to a line or two.

## Two modes

- **With args** — the user stated what to hand off (a task, a bug, a spec step,
  constraints). Base the prompt on that; pull in session context only to fill
  gaps they didn't spell out.
- **No args** — infer the handoff yourself: what was this session doing, and
  what is the obvious next step? Read the live signals below, name that step,
  and hand it off. State in your one line of prose what you inferred so the user
  can correct it.

## Gather before writing (cheap, do it every time)

- `git status` + `git log --oneline -8` — branch, uncommitted work, recent commits.
- `specs/STATUS.md` — the project's live current-focus.
- Any open PR for the branch (`gh pr view` if one exists) and its CI state.
- The thread itself — decisions made, dead ends hit, things left unfinished.

## The prompt must contain (only what applies)

1. **Orient** — one line: "murmur repo, branch `X`; read `CLAUDE.md` then
   `specs/STATUS.md` first." Don't restate the routing card's content; point at it.
2. **State** — what's already done and committed vs. still dirty/unpushed;
   name the branch and any open PR + its CI status.
3. **The task** — the ONE next thing, concrete and verifiable. If handing off
   mid-build, name the spec (`spec NN`) so the receiver routes through
   `murmur-build-spec` / `murmur-ship`.
4. **Landmines** — decisions already settled (don't relitigate), dead ends
   already tried, and any real-boundary caveat (unit-green ≠ delivered).
5. **Done means** — the acceptance check that closes the task.

## Rules

- Self-contained: no "as we discussed", no reference to this session's messages.
- Point to files, don't inline them — the receiver can open `CLAUDE.md`,
  the spec, `.dev/dev.log`. Paste only facts not on disk (a decision, a failure
  mode you hit, an in-progress diff's intent).
- Honest state: uncommitted work, skipped steps, failing tests go in — a handoff
  that hides them ships a landmine.
- Lazy length: enough to act, no session-transcript dump. If it's longer than the
  work it hands off, cut it.
