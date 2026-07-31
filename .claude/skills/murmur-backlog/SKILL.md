---
name: murmur-backlog
description: Use when a murmur debt is created, discharged, or audited — an owed by-ear pass, a measured defect nobody is fixing yet, a watch item, or a "what is still open?" question. Also triggers on /murmur-backlog. Owns the loop between GitHub issues and the `## Open` section of specs/STATUS.md; not for work that starts and finishes inside the current PR.
---

# murmur-backlog — one debt, one issue, one line

murmur's backlog lives in **GitHub issues**. `specs/STATUS.md`'s `## Open`
section is the **index**, not the record: one line per issue, no restatement of
its body. The two are kept in step by the three actions below, and CI enforces
the invariant mechanically (`.github/scripts/check-pr.ts`): STATUS.md over its
line cap is red, and an `## Open` line pointing at a **closed** issue is red.

## The threshold — what earns an issue

**Only work that will outlive the current PR.** If you can finish it before you
open the PR, finish it; an issue for it is noise that someone has to close.

Open one when the thing is:

- **owed to the user** — a sensory / by-ear pass nobody but they can run;
- **measured but unfixed** — a real number or a real observation, with no fix in
  this change (this is the honest exit from "I found something while doing
  something else");
- **seen once, not reproduced** — a `watch` item;
- **decided but not built** — a direction that needs its own build task.

Do **not** open one for: a refactor you are about to do anyway, a hypothetical,
a nice-to-have nobody has asked for, or a restatement of something the spec
already carries as an open question.

## Labels

| Label | Means | Closes on |
|---|---|---|
| `eng` | a measured defect or a performance target | a re-measurement or a regression test |
| `by-ear` | user-run sensory acceptance, not assertable in a test | the user's judgment |
| `watch` | observed once, not reproduced | a recurrence (→ becomes `eng`) **or** "did not recur" |

## Action: open

1. **Check the threshold above.** Then check it is not already filed:
   `gh issue list --state open`.
2. **Write the body from the template** (below) and create it:
   `gh issue create --label <eng|by-ear|watch> --title "<title>" --body-file <file>`.
3. **Add one line to STATUS.md `## Open`**, in the same change:
   `- **#N** (label) one sentence.` Nothing more — the body is the record.
4. If the debt is a *measured fact*, the numbers go in **the spec whose promise
   they verify**, not in the issue and not in STATUS.md. The issue links to it.

## Action: close

1. **Comment the conclusion on the issue before closing it.** What was found,
   what changed, what the evidence was. A `by-ear` issue closes on the user's
   verdict — quote it. A closed issue with no conclusion is lost work.
2. `gh issue close <N> --comment "<conclusion>"`.
3. **Delete its line from STATUS.md `## Open` in the same change.** CI turns red
   if you forget, but the point is not to need CI to notice.
4. A `watch` item may close on "did not recur" — say so explicitly, with what
   was run and did not reproduce it.

## Action: sync

An audit, when the two have drifted (or before a handoff):

1. `gh issue list --state open --json number,title,labels` — what GitHub thinks.
2. Read STATUS.md's `## Open` section — what the card thinks.
3. Reconcile **both** directions:
   - an open issue with **no line** → add the line (it is a real debt nobody can see);
   - a line pointing at a **closed** issue → delete the line (this is the CI red);
   - a line pointing at **nothing** (no such issue) → the line is a fiction: open
     the issue or delete the line;
   - a line whose sentence **contradicts** the issue title → the issue wins; the
     card is the index.
4. Report what moved. A sync that changes nothing is a good outcome, not a
   wasted run — say "in step" and stop.

## Issue body template

```markdown
**What it is**

<One or two paragraphs. What was seen or what is owed — concrete, with numbers
if there are numbers. If a cause is suspected but unverified, say "suspected,
NOT verified" and name what would confirm it.>

**Spec**

<`specs/specNN/....md` §N — the contract this touches. If the measured record
lives in that spec, point at the section.>

**Done when**

<The falsifiable close condition. For `eng`: a re-measurement or a regression
test. For `by-ear`: what the user has to have run, and that a "no" becomes
follow-up issues rather than a reopened contract. For `watch`: both exits —
recurrence, or did-not-recur.>
```

Optional sections, when they earn their place: **Not yet investigated** (what
nobody has looked at, so the next person does not redo the same dead end) and
**Where it is not** (paths already cleared by tests — stops a hunt in the wrong
file).

## Anti-patterns

- Filing an issue for work that finishes in the current PR.
- Pasting the issue body into STATUS.md — that is the ledger habit the card
  rule exists to kill.
- Closing an issue without a conclusion comment.
- Closing an issue and leaving its line in `## Open` (CI red) — or deleting the
  line and leaving the issue open (silent debt).
- Putting measured numbers in the issue instead of in the spec they verify.
