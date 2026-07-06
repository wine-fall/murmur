# spec/03-03 · guide-harness — harness the native agent to set up / repair the music dependency

> **Status**: **Implemented behind an explicit entry; auto-trigger pending** — **part of spec 03, built within spec 03**. Unit-green and merged: `GuideCapable.run_guide` + `_build_guide_options` (isolated, built-ins enabled, `permission_mode="default"`), `SetupGuide.fix_music`, centralized prompts (`GUIDE_PERSONA` + `build_fix_music_prompt`), the deterministic preflight (`music/preflight.py`), and the CLI-Host wiring (`setup.py::run_music_setup`) — the SDK's permission asks are routed via `can_use_tool` (printed, answered y/N on the same stdin the Director uses) and its streamed text via `on_text`. Runnable via `murmur --setup-music`, and **auto-triggered at startup** by 03-02's startup-checks phase (`startup.py::MusicStartupCheck` — a failed/declined check degrades the session to talk-only). **Extended (2026-07)** to cover BOTH music binaries: per-binary probes + the `preflight_music` aggregate, and the guide repairs/installs them in one session with the preflight's findings as evidence. **Remaining**: human acceptance on a real broken environment (§5.3 — a machine with yt-dlp absent is exactly that environment).
> **Part**: The third part of spec 03 (the music family), riding the brain-harness from [`03-01-brain-harness.md`](03-01-brain-harness.md): shape the **native Claude Code agent** to diagnose and — with the user's consent — fix why the music dependencies (**yt-dlp + ffmpeg** — both unbound external binaries per master §10.1) aren't working in *their* environment (missing entirely, or broken — e.g. a corporate proxy whose CA yt-dlp doesn't trust). This is what makes 03's music **actually usable** on constrained machines. See master [`../DESIGN.md`](../DESIGN.md) §3.2 (the brain is a harnessed agent), §10.1 (guided provisioning), §7 pillar 1 (deterministic checks are local, 0 tokens).
> **Milestone**: L1 — part of delivering working music (03). Depends on 03-01 (the harness) + 01 (CLI Host); independent of 03-02 (ducking).
> **Conventions**: English; written for a coding agent. We do **not** build an agent — Claude Code is the agent; we shape it. Prompts centralized under `src/murmur/prompts/`; no CJK in source (master §0).

---

## 1. Goal & scope

### Delivers
1. **The guide harness** — a capability on the harness seam (03-01): `GuideCapable.run_guide(system_prompt, prompt, *, model, max_turns, permission_mode)`. We configure **only two things**; the SDK does the rest:
   - a **behavior-shaping system prompt** — investigate first → explain in plain language → **ask before acting** → smallest safe change → verify;
   - the **SDK launch mode** — Claude Code's built-in tools enabled, run in **`permission_mode="default"`** (step-by-step user confirmation). We never build a consent/detection protocol and never prescribe the fix; the SDK drives ask/execute, and the agent diagnoses the (open-ended) cause itself.
2. **First use — `SetupGuide.fix_music`**: diagnose why the music dependencies (yt-dlp and/or ffmpeg) aren't working (cause is uncertain: not installed, proxy CA, outdated binary, no network, …) and, with the user's consent, fix them in ONE session, then verify. The preflight's findings are handed to the agent as evidence, seeding the diagnosis.
3. **Deterministic preflight trigger**: cheap **local** probes (0 tokens — master §7 pillar 1, *not* LLM calls) — one per binary (`preflight_ytdlp`, `preflight_ffmpeg`), aggregated by `preflight_music` (ok iff BOTH ok; the combined reason names each broken piece) — run at startup / via `--setup-music`, offering the guide on failure.
4. **Run-loop integration**: the guide's confirmations flow to the user through murmur's **existing CLI Host** (`print` + `stdin`, spec 01) — **no TUI required**; the SDK's permission requests are routed to the user and the answers back.

### Out of scope (explicit non-goals)
- **A custom consent protocol or detection/repair logic** — the Claude Code SDK handles ask/execute; we set prompt + mode only.
- **Prescribing the fix** in the prompt — the agent figures out the uncertain cause and proposes the remedy.
- **`bypassPermissions`** in any shipped build — supervised dev only; the default is step-by-step confirmation.
- **A CLI subcommand** (`murmur doctor`) — triggered through murmur's normal interaction; a subcommand is a later option.
- **The TUI** (spec 10) — the plain CLI Host suffices for the confirm interaction.
- Repairing anything beyond the music dependencies (yt-dlp + ffmpeg) for now (the shape generalizes, but only music ships here).

---

## 2. Contracts / seams
- **`GuideCapable`** (harness.py, done): `run_guide(...) -> str` returns the final plain-language explanation. `ClaudeBrain` implements it; distinct from `Harness` (find-music has no built-in tools) — interface segregation.
- **`SetupGuide`** (guide.py): `fix_music(*, ytdlp="yt-dlp", ffmpeg="ffmpeg", reason="", venv_python=None, permission_mode="default") -> str` — `reason` carries the preflight findings into the task prompt.
- **Prompts** (prompts/guide.py, done): `GUIDE_PERSONA` (behavior) + `build_fix_music_prompt` (high-level task, no prescribed remedy).
- **Preflight** (music/preflight.py): deterministic probes — `preflight_ytdlp(binary)` (trivial query), `preflight_ffmpeg(binary)` (`-version` probe), and `preflight_music(ytdlp=..., ffmpeg=...)` aggregating both into one `PreflightResult(ok, reason)` (ok iff both; reason prefixes each broken binary's name). No LLM.
- **Permission routing** (setup.py, done): the SDK's `can_use_tool` callback backed by CLI Host I/O — the ask is printed, the y/N read from the same stdin. Kept minimal: we *route* the SDK's prompt, we do not design consent semantics.

---

## 3. Design
- **Isolation preserved** (03-01 §2.1): `setting_sources=[]`, `strict_mcp_config=True`, no user skills/MCP. **But built-in tools are ENABLED** and allowlisted (`_GUIDE_BUILTINS` = Bash/Read/Write/Edit/Glob/Grep) — the bounded surface a repair task needs (contrast: find-music runs with `tools=[]`). This is the per-task tool-surface principle: each capability gets exactly what it needs.
- **Flow**: startup / first music use → deterministic preflight → if broken, murmur tells the user plainly and offers the guide → on opt-in, `SetupGuide.fix_music` runs → Claude Code investigates (Bash), **asks before each change** (SDK `default` mode, routed to the CLI Host), applies the smallest safe fix, verifies → returns an explanation.
- **Off the live broadcast loop** (master §3.2 boundary ②): setup/repair is a foreground interaction (first-run, radio not yet broadcasting) or a background job — its exact relationship to the broadcast loop is an open question.
- **Model**: Opus (repair is judgment-heavy and occasional; the token cost amortizes).

---

## 4. Dependencies
- **spec 01**: the CLI Host (print/stdin) for routing confirmations; the run loop for triggering.
- **spec 03-01**: the harness seam + `ClaudeBrain` (extended with `run_guide`).
- **External**: `claude-agent-sdk` (built-in tools + permission modes), `yt-dlp` + `ffmpeg` (the unbound binaries being provisioned/repaired).

---

## 5. Acceptance criteria
1. **Guide options** are isolated (`setting_sources=[]`, `strict_mcp_config=True`), built-ins allowlisted, and `permission_mode="default"`. *(Unit — done.)*
2. **Preflight** deterministically detects broken/missing/healthy states for BOTH binaries with **no LLM call** (unit: failing / passing stand-in binaries → correct `ok` + reason), and the aggregate is ok only when both are (a combined reason names each broken piece).
3. **Interactive repair (the real bar, human-run)**: on a machine where yt-dlp is broken (e.g. a corporate proxy CA), starting murmur → it tells you plainly it's broken → offers to fix → **you confirm** → it fixes it, asking before each action → yt-dlp then works (a real search returns JSON, no `--no-check-certificate`). The agent produces the fix; the user answers the confirmations. Can't be self-verified (needs a human + a real broken env).
4. **`bypassPermissions` never appears** in the shipped path (grep-able invariant).

### Testing (master §11)
- **Unit**: the guide options builder (done); the deterministic preflight (stand-in binaries, no network/LLM); a grep-guard that the shipped default is `"default"`, not `"bypassPermissions"`.
- **Integration / human acceptance**: the interactive repair on a real broken environment — user-run.

---

## 6. Open questions
- **Settled — permission routing mechanism**: the SDK's `can_use_tool` callback backed by CLI Host print/stdin (`setup.py::_cli_permission`); no bespoke consent protocol.
- **Settled — preflight scope**: the music dependencies as a set (yt-dlp + ffmpeg, one aggregated check). A general "dependency doctor" stays future work — the startup-checks seam (03-02 §2.4) is where new checks register.
- **Relationship to the broadcast loop**: does setup block startup, or run as a background job while the radio idles/talks? (Master §3.2 boundary ②.) The auto-trigger lands with 03-02's music wiring — decide there.
- **Persistence/safety of fixes**: e.g. appending a CA to certifi is semi-global — confirm each fix is the smallest safe change and reversible/explained.
- **Trigger surface**: this spec triggers via normal interaction; whether to also offer an explicit `murmur doctor`-style entry is deferred.
