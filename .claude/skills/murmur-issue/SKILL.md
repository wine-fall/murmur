---
name: murmur-issue
description: Use when a murmur bug, feature, or debt needs recording, discharging, or auditing — the user reports a bug or asks for a feature ('file an issue', 'record this bug', in any language), a build leaves behind an owed by-ear pass, a measured defect, or a watch item, an issue is being closed with a verdict, or someone asks "what is still open?". Also triggers on /murmur-issue. Owns the loop between GitHub issues and the `## Open` section of specs/STATUS.md; not for work that starts and finishes inside the current PR.
---

# murmur-issue — one debt, one issue, one line

murmur's backlog lives in **GitHub issues**. `specs/STATUS.md`'s `## Open`
section is the **index**, not the record: one line per issue, no restatement of
its body. The issue body is a contract, written like the specs: explicit,
verifiable, no narration — a future agent must be able to pick it up cold.
The three actions below keep issues and the card in step, and CI enforces the
invariant mechanically (`.github/scripts/check-pr.ts`): STATUS.md over its
line cap is red, and an `## Open` line pointing at a **closed** issue is red.

## The threshold — what earns an issue

An open issue is a standing claim on someone's time, so the bar is high and it
is a **conjunction**. Open one only when the thing **outlives the current PR**
(finishable before you open the PR → finish it) **and all three** of these hold:

1. **An evidence anchor.** A measurement, reproduction steps, or a concrete
   session observation — with where it came from: the number, the
   `.dev/dev.log` line, the code seam (`file:line`), the failing command. "It
   felt off" and "this could break" are not anchors.
2. **An explicit close condition.** You can state today, in one falsifiable
   sentence, what makes it closable. If the close condition is "someone decides
   what we want here", the decision is the missing work — not an issue.
3. **A follow-up action that needs scheduling.** Real work a future session
   would pick up and do. If nobody would ever schedule it, an issue only ages.

Miss any one and it does **not** get an issue. Route it instead:

| The thing | Where it goes |
|---|---|
| Observed once, no repro, nothing to do about it | one line in the governing spec's section — or nothing at all |
| A direction with no schedule ("we could also back this with X") | nothing; it earns an issue when someone schedules it. Precedent: #89 is the shape to stop opening |
| An open question the spec already carries | leave it in the spec; do not mirror it |
| A refactor you are about to do anyway, a hypothetical, an unrequested nice-to-have | nothing |

**One ship, one by-ear issue.** All sensory acceptance a single ship leaves
owed goes into **one** `by-ear` issue whose **Done when** is a checklist of the
criteria — never one issue per criterion, and never one per spec section. If a
by-ear issue for the same surface is still open and unrun, append the new
criteria to it instead of opening a sibling.

An issue that clears the bar today can stop clearing it. When a `watch` item
has not recurred, or a scheduled follow-up turns out to be nobody's plan, close
it with that as the conclusion (Action: close) — do not let it sit.

## Labels — two composable axes

**Lifecycle** (exactly one — decides who can close it and how):

| Label | Means | Closes on |
|---|---|---|
| `eng` | a measured defect or a performance target | a re-measurement or a regression test |
| `by-ear` | user-run sensory acceptance, not assertable in a test — one issue per ship, criteria as a checklist | the user's judgment |
| `watch` | observed once, not reproduced, **and** carrying an action (a probe to add, a guard to try) | a recurrence (→ becomes `eng`) **or** "did not recur" |

A repro-less observation with no action is not a `watch` issue — it is a line in
the spec, or nothing (see the threshold).

**Nature** (optional — stacks on top of lifecycle): `bug` when a spec'd
contract is violated (cite the section); `enhancement` when behavior is within
contract but should be better. Example: #77 is `bug, eng`.

## Action: open

1. **Clear the threshold above — name the anchor, the close condition, and the
   follow-up out loud before you write anything.** Cannot name all three → say
   which one is missing and take the route in the table instead. Then check it
   is not already filed, and whether an open issue should **absorb** this
   instead of a new one (the same surface, the same ship's by-ear pass):
   `gh issue list --state open`.
2. **Gather evidence before writing.** The session usually already holds it:
   error output, `.dev/dev.log` lines, measured numbers, the code seam
   (`file:line`), the governing spec section. Missing pieces that are cheap to
   fetch (a grep, a spec read, `graphify query`) — fetch them now. What you
   cannot verify, mark **suspected, NOT verified**; never dress a hypothesis
   up as a finding. Precedent: issue #77 labeled its suspect list exactly so,
   and the dominant root cause turned out to be elsewhere.
3. **Write the body from the template** (below) and create it:
   `gh auth switch --user wine-fall`, then
   `gh issue create --label <labels> --title "<title>" --body-file <file>`.
4. **Add one line to STATUS.md `## Open`**: `- **#N** (label) one sentence.`
   Nothing more — the body is the record. The line rides the current PR if one
   is open; otherwise the next sync carries it — never open a PR just for the
   pointer.
5. If the debt is a *measured fact*, the numbers go in **the spec whose promise
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
test. For `by-ear`: a `- [ ]` checklist with one box per criterion this ship
owes, plus the note that a "no" becomes follow-up issues rather than a reopened
contract. For `watch`: both exits — recurrence, or did-not-recur.>
```

Optional sections, when they earn their place: **Not yet investigated** (what
nobody has looked at, so the next person does not redo the same dead end) and
**Where it is not** (paths already cleared by tests — stops a hunt in the wrong
file).

## Anti-patterns

- Filing an issue for work that finishes in the current PR.
- Draining a ship's leftovers into issues one by one at the end — the threshold
  is a conjunction, and by-ear passes merge into one issue per ship.
- An issue whose whole content is a direction nobody has scheduled, or a "keep
  an eye on this" with no anchor and no action.
- An issue whose close condition is "decide what we want" — the decision is the
  work; have it, then file what it produced.
- Asking the user to describe what the session already witnessed.
- A body that says "see conversation" — the future reader has no conversation.
- An unverified hypothesis stated as the root cause.
- Pasting the issue body into STATUS.md — that is the ledger habit the card
  rule exists to kill.
- Closing an issue without a conclusion comment.
- Closing an issue and leaving its line in `## Open` (CI red) — or deleting the
  line and leaving the issue open (silent debt).
- Putting measured numbers in the issue instead of in the spec they verify.
