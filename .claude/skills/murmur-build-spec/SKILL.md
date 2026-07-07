---
name: murmur-build-spec
description: "Use whenever the user asks to implement, build, work on, continue, or test any murmur spec — the request MUST name a target spec (e.g. `01`, `02`, `01-core-loop`, `L0`, `L1`). Also triggers on `/murmur-build-spec <id>`. This is the spec-driven build discipline for the murmur project: read the named spec first, build against it, and keep the spec and the code aligned (update the spec when a better direction emerges)."
---

# murmur-build-spec — spec-driven build for murmur

The murmur project is built from specs. `specs/DESIGN.md` is the **master spec** (vision, locked decisions, architecture); `specs/specNN/*.md` are **sub-specs** (one per part). Code follows specs, and specs stay true to code. This skill is how every build task runs.

This is the **build discipline**. The end-to-end loop that wraps it — test gate → closing `code-review` → commit, with a clean exit contract — is `murmur-ship`; it calls this skill for the build itself.

Current focus lives in `specs/STATUS.md` — read it at the start of any build task. Later specs (03–09) may still change; don't treat not-yet-built specs as frozen.

## The rule

**Every build task must name a target spec. No spec named → do not start. Ask which spec.**

Accept any unambiguous reference: a sub-spec id (`01`, `01-core-loop`), a milestone (`L0` = specs 01+02; `L1` = adds 03), or `specs/DESIGN.md` for a master-level change. If the user says "keep going" / "continue" right after working on a spec, the same spec is the target.

## Workflow (do these in order)

1. **Read the spec first — always.** Read the named `specs/specNN/*.md` in full, plus the parts of `specs/DESIGN.md` it references (at minimum §0 conventions, and the architecture/scope sections the spec points to). Never start editing from memory of the spec — re-read the current version.
2. **Restate the contract.** Before code, state briefly: what this spec delivers, its contracts/seams, its acceptance criteria, and what's explicitly out of scope. This is the bar you build to.
3. **Clarify gate — confirm the uncertain things BEFORE any code.** This skill is not head-down execution. Scan the part you're about to build for anything not nailed down:
   - the spec's **Open questions** section,
   - underspecified contracts or behaviors, or a choice the spec deliberately left open,
   - ambiguity about scope or approach, or any decision that would be costly to reverse later.

   If any of these apply, **ask the user first** — present each as a concrete choice with your recommendation — and wait for the answer. Do **not** guess and charge ahead on a material uncertainty. (The design itself was already brainstormed; this gate is a focused build-time confirmation, not a full re-brainstorm. A genuinely settled spec with no open questions needs no gate — proceed.) Record the resolved decisions back into the spec (per the alignment section) so the next build doesn't re-ask.
4. **Build against the spec — test-first.** Tests are mandatory (see Testing below). Write logic **test-first**: failing unit test against the seams' fakes → implementation → green. Write the test as part of building each requirement, **in the same step** — never implement first and add tests afterward. Honor the seams the spec declares (don't bypass an interface another spec owns); ensure each seam has a **fake** for tests. Match the surrounding code's style. (See **Test-first is non-negotiable** below — this is the rule most easily rationalized away.)
5. **Verify against the spec's acceptance criteria** before claiming done. Run the **unit suite** (must pass). For criteria covered by integration tests, run them **on demand**. For criteria at the **real Claude / SDK / real-integration boundary that fakes can't prove**, use `murmur-smoke` to see it run for real (see Testing). For **sensory/human-acceptance** criteria (sounds human, feels like radio, type-and-reply flows), produce a **checklist and hand it to the user to run and confirm** — do not self-declare these met. Never claim a milestone (L0/L1) met on assertion alone. (`superpowers:verification-before-completion` applies.)
6. **Keep spec and code aligned** (see next section).

## Spec ↔ code alignment (the core discipline)

The spec is a **living source of truth**, not a frozen contract. During a build you will sometimes discover the spec is wrong or that a better direction exists. When that happens:

- **Stop before silently diverging.** If the implementation is about to differ from the spec in any way that matters (a changed contract, a different mechanism, a dropped/added behavior, a revised acceptance criterion), do not just code around it.
- **Surface the divergence** to the user: what the spec says, what you found, why the new direction is better, and what it costs.
- **On agreement, update the spec to match** — edit the `specs/specNN/*.md` (and `specs/DESIGN.md` if the change is architectural / cross-cutting) so the written spec and the code stay in lockstep. Keep the update English + AI-friendly + at the right altitude (master stays high-level; sub-specs stay design-level).
- **Then continue the build** against the updated spec.

Never leave the spec describing one thing while the code does another. Either the code matches the spec, or the spec has been updated to match the code. Small, obvious corrections (a typo, a renamed field for clarity) can be updated inline with a one-line note; anything that changes a contract, scope, or decision is surfaced first.

When a sub-spec change contradicts or outgrows a master decision, update `specs/DESIGN.md` too — and flag it, because master-level changes are bigger than they look.

`specs/STATUS.md` is project-state truth (current milestone, what's next), not a spec contract — but the same living-truth rule applies. You **read it at the start of every build**, so if it's stale when you read it, or this build advances the milestone / changes the next target / closes an open acceptance bar, **update it and re-date-stamp in the same change**. A stale STATUS misdirects the next session.

## Testing (mandatory — see specs/DESIGN.md §11 for the full convention)

- **Test-first for logic.** Failing unit test → implementation → green. Framework: `pytest`.
- **Fakes for seams.** Every provider/seam (`VoiceProvider`, `MusicProvider`, `MemoryStore`, Brain) ships a fake, so the core is always unit-testable without real audio/LLM/network.
- **Three layers:** unit (fast, every change) · integration (tagged, **manual on-demand**, e.g. `pytest -m integration`) · human acceptance (sensory criteria → produce a **checklist for the user to run**).
- **Don't run the heavy real models inside a build's tests.** Real model/voice *capability* eval (Qwen3-TTS, real LLMs — e.g. the voice blind A/B) is the dedicated **eval track** (DESIGN §10.3), not part of normal per-spec verification.
- **Prefer Ollama** for any test/eval that needs an actual local LLM; reserve real Claude (`claude-agent-sdk`) for production + a gated, on-demand live smoke.
- **See it real at the SDK / integration boundary.** When a requirement's correctness lives where fakes can't reach — real `claude-agent-sdk` behavior (`run_task`/`run_guide`), real `yt-dlp`, audio, the interactive guide — use `murmur-smoke` to run a throwaway `scratch/` script, then fold the finding into a unit or `integration`-tagged test. Fakes-green ≠ works there — this project shipped unit-green code broken at that seam (MCP result shape; `can_use_tool` streaming mode).

## Test-first is non-negotiable

**Violating the letter of test-first is violating the spirit of it.** "I ran it and it works, I'll add the test next" is not test-first — it is test-last, and it is forbidden. The test is written and run green *as part of the step that builds the thing*, before that step is called done or committed.

This is the rule most easily rationalized away under build momentum. It already happened on this project: spec 01 was built and committed step by step with only manual runs, the `pytest` suite was backfilled at the very end, and that backfill let a real `AudioPlayer` cancellation bug ship — found only when the test was finally written. Test-per-step would have caught it.

| Rationalization | Reality |
|---|---|
| "I'll verify by running the app and add `pytest` at the end." | A manual run is not a test. Backfilling already shipped a bug here. Write the test in the step. |
| "Tests-after give the same coverage." | Tests-after ask *what does this do*; tests-first ask *what should this do* — and catch the bug before the commit, not after. |
| "This step is exploratory / the shape will change." | Then test the **contract**, not the internals. A changing shape is the reason to pin behavior first. |
| "Claude's / the voice's output is unpredictable — I can't test it." | Correct — so don't. Unit-test the **deterministic scaffolding** (prompt assembly, the loop on fakes); route model/voice quality to the **eval track** (DESIGN §10.3/§11.4). |
| "It's a tiny change." | Tiny changes break too; the test is 30 seconds. |

**Red flags — STOP and write the test first:**
- Implementation written before its test exists.
- "I'll add tests at the end / in a follow-up."
- About to commit a step whose tests you have not run green.
- Asserting on exact Claude / voice output in a unit test (that's the eval track).

## Conventions (from specs/DESIGN.md §0)

- **Specs are written for a coding agent, not humans** — explicit contracts, single source of truth, explicit non-goals, verifiable acceptance criteria.
- **English** for all spec documents; **Chinese** for discussion with the user.
- Master (`specs/DESIGN.md`) stays high-altitude (what/why); sub-specs go to design level (mechanism/contracts), not into code-in-the-doc.
- Sub-specs live under `specs/specNN/` (one directory per top-level spec; a multi-part spec keeps its sub-parts together, e.g. `specs/spec03/03-01-*.md` + `specs/spec03/03-02-*.md`), numbered by build order.

(Cross-session project memory lives **outside the repo** at the Claude project memory dir, not under `murmur/` — don't look for it in the tree.)

## Anti-patterns

- Backfilling tests at the end (test-last) instead of test-first per step — see **Test-first is non-negotiable**.
- Starting a build with no spec named, or from memory without re-reading the spec.
- Charging ahead past a material uncertainty (an Open question, ambiguous scope, or a hard-to-reverse choice) instead of confirming with the user first.
- Letting code drift from the spec without updating the spec — the cardinal sin of this skill.
- Updating the spec to rationalize a shortcut rather than because the new direction is genuinely better — say so honestly and let the user decide.
- Declaring a milestone (L0/L1) met without verifying its acceptance criteria against the running thing.
- Treating later specs (03–09) as frozen — they're expected to change as L0/L1 teach us things.
- Editing `specs/DESIGN.md` for an architectural change without flagging that it's master-level.
