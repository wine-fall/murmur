# spec/03-03 · guide-harness — harness the native agent to set up / repair the music dependency

> **Status**: **Implemented behind an explicit entry; auto-trigger pending** — **part of spec 03, built within spec 03**. Unit-green and merged: `GuideCapable.run_guide` + `_build_guide_options` (isolated, built-ins enabled, `permission_mode="default"`), `SetupGuide.fix_music`, centralized prompts (`GUIDE_PERSONA` + `build_fix_music_prompt`), the deterministic preflight (`music/preflight.py`), and the CLI-Host wiring (`setup.py::run_music_setup`) — the SDK's permission asks are routed via `can_use_tool` (printed, answered y/N on the same stdin the Director uses) and its streamed text via `on_text`. Runnable via `murmur --setup-music`, and **auto-triggered at startup** by 03-02's startup-checks phase (`startup.py::MusicStartupCheck` — a failed/declined check degrades the session to talk-only). **Extended (2026-07)** to cover BOTH music binaries: per-binary probes + the `preflight_music` aggregate, and the guide repairs/installs them in one session with the preflight's findings as evidence. **Human acceptance passed (2026-07-06)**: on a real machine with yt-dlp absent (ffmpeg present), `murmur --setup-music` reported exactly the missing binary, the guide proposed and — with per-action consent — performed the install, and the recheck passed (§5.3). All acceptance criteria are now met.
> **TS port (issue #54 Phase 4.5, 2026-07-28):** ported to TS as a fresh seam —
> `GuideCapable.runGuide(GuideRequest)` in `contracts.ts`/`brain.ts` (a different
> harness from `Harness.runTask`: built-in tools + interactive), the deterministic
> preflight probes in `startup.ts`, the CLI wiring + `musicSetupCheck` startup
> auto-trigger in `guide.ts`, prompts in `prompts.ts`, and the explicit
> `--setup-music` entry (`config.ts`/`app.ts`). Two TS-SDK seam facts, pinned by
> unit + smoke: (1) the built-in surface is bounded via the SDK's `tools` option —
> **not** `allowedTools`, which in the TS SDK auto-approves and would defeat the
> per-action confirm; (2) `runGuide` always uses **streaming input** (the
> permission callback and the multi-turn reply loop both require it — the seam
> that regressed the Python build). The SDK's safe-command classifier may run
> read-only commands (e.g. `echo`) without an ask; every state-changing action
> still asks — consent semantics stay SDK-owned per §2. Interactive acceptance
> (§5.3) on the TS build **passed 2026-08-01** on a delegated real-SDK run.
> **Consent revised (2026-08-18, user decision)**: per-action consent — and the
> 2026-08-12 read-only auto-allow carve-out that patched it — is retired in
> favor of **entry authorization + conversational checkpoints**: the offer
> card's `y` authorizes the fixes, `cliPermission` allows every call except
> secret-bearing input, and the guide stops (in natural language) only at
> substantive forks. See §3; §5 criteria updated to match. Earlier
> per-action-consent language in the banners above is history, not contract.
> **Part**: The third part of spec 03 (the music family), riding the brain-harness from [`03-01-brain-harness.md`](03-01-brain-harness.md): shape the **native Claude Code agent** to diagnose and — with the user's consent — fix why the music dependencies (**yt-dlp + ffmpeg** — both unbound external binaries per master §10.1) aren't working in *their* environment (missing entirely, or broken — e.g. a corporate proxy whose CA yt-dlp doesn't trust). This is what makes 03's music **actually usable** on constrained machines. See master [`../DESIGN.md`](../DESIGN.md) §3.2 (the brain is a harnessed agent), §10.1 (guided provisioning), §7 pillar 1 (deterministic checks are local, 0 tokens).
> **Milestone**: L1 — part of delivering working music (03). Depends on 03-01 (the harness) + 01 (CLI Host); independent of 03-02 (ducking).
> **Conventions**: English; written for a coding agent. We do **not** build an agent — Claude Code is the agent; we shape it. Prompts centralized in `src/prompts.ts`; no CJK in source (master §0).

---

## 1. Goal & scope

### Delivers
1. **The guide harness** — a capability on the harness seam (03-01): `GuideCapable.run_guide(system_prompt, prompt, *, model, max_turns, permission_mode)`. We configure **only two things**; the SDK does the rest:
   - a **behavior-shaping system prompt** — investigate first → explain in plain language → act on the entry authorization, **stopping to ask only at substantive forks** → smallest safe change → verify;
   - the **SDK launch mode** — Claude Code's built-in tools enabled, bounded via `tools`, with the `canUseTool` callback allowing within the entry authorization (denying only secret-bearing input — §3). We never prescribe the fix; the agent diagnoses the (open-ended) cause itself.
2. **First use — `SetupGuide.fix_music`**: diagnose why the music dependencies (yt-dlp and/or ffmpeg) aren't working (cause is uncertain: not installed, proxy CA, outdated binary, no network, …) and, with the user's consent, fix them in ONE session, then verify. The preflight's findings are handed to the agent as evidence, seeding the diagnosis.
3. **Deterministic preflight trigger**: cheap **local** probes (0 tokens — master §7 pillar 1, *not* LLM calls) — one per binary (`preflight_ytdlp`, `preflight_ffmpeg`), aggregated by `preflight_music` (ok iff BOTH ok; the combined reason names each broken piece) — run at startup / via `--setup-music`, offering the guide on failure.
4. **Run-loop integration**: the guide's conversation flows through murmur's **existing CLI Host** (`print` + `stdin`, spec 01) — **no TUI required**: its text streams out, its tool activity is narrated, and the user's replies flow back. **Amended (2026-08-11)**: question lines (entry consent, secret paste) route through the optional `Host.ask` seam (spec 10 §3.2-B) so a front-end with a question surface can dock them; a bare host falls back to `info` — this section's plain-CLI behavior is unchanged. **Amended (2026-08-19, user report)**: the per-turn free-reply prompt is an `info` line, never an ask — the guide's own streamed words carry the question, and a spotlight card reading only "your reply" hushed the room over nothing; the modal stays reserved for the onboarding decisions. **Amended again (2026-08-19, grilling session — the conversation-partner boundary, spec 10 §3.4)**: the session has a real lifecycle now. The front-end's Esc arrives as a host `interrupt` and NEVER kills the session: mid-turn it cuts only the turn in flight (`query.interrupt()` via the `GuideRequest.onSession` handle — the SDK answers with that turn's result and the reply loop continues; the cut turn's tool calls are denied and a pending secret read aborts its tool), and at the idle reply prompt it ends the conversation exactly like a typed `/done` (the Esc-Esc exit, normal closing re-probe included). Ending is explicit only — `/done`, Esc at the idle prompt, or the guide finishing; a waiting guide waits without a timeout. Only the typed `/quit` cuts the SDK session outright (the `interrupt` promise). While the guide holds the floor (from the accepted `y` to the conversation's end) the host's `setMode` seam tells the front-end to paint the boundary. **Mid-broadcast re-entry (2026-08-19, spec 10 §3.4)**: a typed `/setup` recalls the same conversation over the air — the Director parks its segment loop while the music plays on, the recall runs `runSetup` with `explicit: true`, and a changed voice endpoint is applied live by swapping the provider behind the app's delegate (issue #97's reopen path).

### Out of scope (explicit non-goals)
- **A custom consent protocol or detection/repair logic** — consent is the entry authorization plus the prompt's conversational checkpoints; the permission callback carries only the secret-input guard, never a dialogue.
- **Prescribing the fix** in the prompt — the agent figures out the uncertain cause and proposes the remedy.
- **`bypassPermissions`** in any shipped build — supervised dev only; the auto-allow lives in the `canUseTool` callback, where the secret-input guard stays enforceable.
- **A CLI subcommand** (`murmur doctor`) — triggered through murmur's normal interaction; a subcommand is a later option.
- A TUI-specific confirm surface — the Host seam carries the interaction in both plain and TUI front-ends (spec 10 §3.2-B).
- Repairing anything beyond the §7 onboarding surface (music binaries, bun, the voice endpoint); a general dependency doctor stays future work.

---

## 2. Contracts / seams
- **`GuideCapable`** (harness.py, done): `run_guide(...) -> str` returns the final plain-language explanation. `ClaudeBrain` implements it; distinct from `Harness` (find-music has no built-in tools) — interface segregation.
- **`SetupGuide`** (guide.py): `fix_music(*, ytdlp="yt-dlp", ffmpeg="ffmpeg", reason="", venv_python=None, permission_mode="default") -> str` — `reason` carries the preflight findings into the task prompt.
- **Prompts** (prompts/guide.py, done): `GUIDE_PERSONA` (behavior) + `build_fix_music_prompt` (high-level task, no prescribed remedy).
- **Preflight** (music/preflight.py): deterministic probes — `preflight_ytdlp(binary)` (trivial query), `preflight_ffmpeg(binary)` (`-version` probe), and `preflight_music(ytdlp=..., ffmpeg=...)` aggregating both into one `PreflightResult(ok, reason)` (ok iff both; reason prefixes each broken binary's name). No LLM.
- **Permission enforcement, two layers** (smoke-measured seam fact: the SDK consults `canUseTool` only when its own policy would ask — a `Read` or a classifier-safe Bash command never reaches it): the **secret-input guard lives in a `PreToolUse` hook** (`guideOptions`, `src/brain.ts`), which fires for every tool use and denies secret-bearing input with an explanation (murmur-owned tools exempt — their handlers own the secret channel); `cliPermission` (`src/guide.ts`) allows whatever does arrive under the entry authorization, repeats the secret test as the belt, and never puts a question to the user. Visibility comes from the tool-activity stream (`onToolUse`/`onToolResult`), which narrates every tool use into the host and dev log.

---

## 3. Design
- **Isolation preserved** (03-01 §2.1): `setting_sources=[]`, `strict_mcp_config=True`, no user skills/MCP. **But built-in tools are ENABLED** and allowlisted (`_GUIDE_BUILTINS` = Bash/Read/Write/Edit/Glob/Grep) — the bounded surface a repair task needs (contrast: find-music runs with `tools=[]`). This is the per-task tool-surface principle: each capability gets exactly what it needs.
- **Flow**: startup / first music use → deterministic preflight → if broken, murmur tells the user plainly and offers the guide → on opt-in, `SetupGuide.fix_music` runs → Claude Code investigates (Bash), **asks before each change** (SDK `default` mode, routed to the CLI Host), applies the smallest safe fix, verifies → returns an explanation.
  **Amended (2026-08-18, user decision — consent moves to the entry, checkpoints move into the conversation)**: the per-action y/N gate — and the 2026-08-12 read-only auto-allow carve-out that patched it — is retired. The offer card's `y` IS the authorization: `cliPermission` allows every tool call outright and never puts a permission question to the user; the wall of y/N it produced buried the conversation the guide exists to have. Two limits remain. (1) **Secret-bearing input is denied**, with a reason the model can act on: a path that can hold a credential (`.env*`, `voice.json`, the `~/.murmur` home, `environ`) for any tool, and for Bash additionally secret-shaped names (api-key/secret/token/password — URLs stripped first, so opening a provider's `api-keys` page stays legal), environment dumps (`env`/`printenv`/`set`/`export`), and parameter expansion (`$VAR` — the guard cannot tell `$HOME` from `$SOME_KEY`, and a literal path is cheap to rephrase). The guard is a **tripwire against accidental credential ingestion, not a sandbox** — the model is prompt-aligned, not adversarial, and a regex cannot enumerate every read of every secret; a secret-hinting tool use's OUTPUT is additionally withheld from the host so a miss on the way in is not persisted on the way out. murmur-owned tools are exempt: their handlers own the secret channel. (2) **Substantive forks stop the conversation, not the tool call**: the prompt has the guide ask in natural language — and wait — before anything destructive or hard-to-reverse, a genuine choice between remedies, or anything that costs money. `bypassPermissions` remains forbidden (the red line stands; the surface stays bounded via `tools`), and the secret guard's real enforcement point is a `PreToolUse` hook — see §2 — because the SDK does not consult `canUseTool` for the calls its own policy already allows. Visibility is the tool-activity stream: every tool use is narrated into the host and the dev log.
- **Off the live broadcast loop** (master §3.2 boundary ②): setup/repair is a foreground interaction (first-run, radio not yet broadcasting) or a background job — its exact relationship to the broadcast loop is an open question.
- **Model**: Opus (repair is judgment-heavy and occasional; the token cost amortizes).

---

## 4. Dependencies
- **spec 01**: the CLI Host (print/stdin) for routing confirmations; the run loop for triggering.
- **spec 03-01**: the harness seam + `ClaudeBrain` (extended with `run_guide`).
- **External**: `claude-agent-sdk` (built-in tools + permission modes), `yt-dlp` + `ffmpeg` (the unbound binaries being provisioned/repaired).

---

## 5. Acceptance criteria
1. **Guide options** are isolated (`setting_sources=[]`, `strict_mcp_config=True`), built-ins bounded via `tools`, the `PreToolUse` secret-guard hook installed, and the `canUseTool` callback implementing the entry-authorization policy: allow, deny secret-bearing input, never ask the user. *(Unit — done; revised 2026-08-18.)*
2. **Preflight** deterministically detects broken/missing/healthy states for BOTH binaries with **no LLM call** (unit: failing / passing stand-in binaries → correct `ok` + reason), and the aggregate is ok only when both are (a combined reason names each broken piece).
3. **Interactive repair (the real bar, human-run)**: on a machine where yt-dlp is broken (e.g. a corporate proxy CA), starting murmur → it tells you plainly it's broken → offers to fix → **you authorize once at the offer** → it fixes it, narrating as it goes and checking back only at substantive forks → yt-dlp then works (a real search returns JSON, no `--no-check-certificate`). The agent produces the fix; the user steers by conversation. Can't be self-verified (needs a human + a real broken env). *(The 2026-07-06 / 2026-08-01 passes below ran under the earlier per-action-consent flow; the 2026-08-18 revision owes a fresh by-ear pass.)*
   **Passed on the TS build — 2026-08-01, delegated real-SDK run**: yt-dlp made unresolvable via a sandboxed PATH; the report named exactly the broken binary, each action asked for consent, the consented fix was applied, and the recheck came back green through the real preflight probe.
4. **`bypassPermissions` never appears** in the shipped path (grep-able invariant).

### Testing (master §11)
- **Unit**: the guide options builder (done); the deterministic preflight (stand-in binaries, no network/LLM); the `cliPermission` policy (allow / secret-deny / murmur-tool exemption / quit); a grep-guard that `bypassPermissions` appears nowhere in `src/`.
- **Integration / human acceptance**: the interactive repair on a real broken environment — user-run.

---

## 6. Open questions
- **Settled — consent mechanism (revised 2026-08-18)**: entry authorization at the offer card + conversational checkpoints at substantive forks; the `canUseTool` callback enforces only the secret-input guard. The earlier per-action y/N (and its read-only carve-out) is retired.
- **Settled — preflight scope**: the music dependencies as a set (yt-dlp + ffmpeg, one aggregated check). A general "dependency doctor" stays future work — the startup-checks seam (03-02 §2.4) is where new checks register.
- **Settled — relationship to the broadcast loop** (§7.1): setup is a foreground conversation offered once per boot before broadcasting; declining degrades the session instead of blocking it.
- **Persistence/safety of fixes**: e.g. appending a CA to certifi is semi-global — confirm each fix is the smallest safe change and reversible/explained.
- **Settled — trigger surface** (§7.1): the boot-time offer plus explicit entries (`--setup-music`, and `--setup` for the full surface).

---

## 7. Slice — conversational onboarding (decided + built 2026-07-31)

> Decision record (grilling session, 2026-07-31): **the app assumes the user
> has Claude Code** — the brain SDK is the one dependency taken as given — so
> every fixable gap is fixed by *talking to murmur*, not by shell
> instructions. The radio always launches; missing pieces degrade the
> session, never block it. A second brain backend (Codex SDK) is explicitly
> out of scope here — tracked as its own issue.

### 7.1 What changes

1. **The shell preflight demotes to a reporter** (`scripts/dev-preflight.ts`):
   it still prints per-dependency findings with fixes, but exits non-zero only
   when `node` itself is unusable — the one gap that leaves nothing to
   converse with. `make dev` therefore always reaches `src/main.ts`; the app
   owns onboarding from there. **Amended (2026-08-11, user decision)**: the
   reporter no longer runs in `make dev`'s path at all — its yt-dlp probe is
   a live network search that held the front-end back for seconds. `make dev`
   gates only on `node -e ""` and launches immediately; the probes run
   in-session (runSetup announces `checking the gear on this machine...`
   first, the front-end's loading signal), and `make preflight` remains the
   standalone no-launch reporter.
   **Leaving mid-onboarding works (2026-08-11)**: a typed `/quit` — which is
   what Ctrl-C in the TUI sends — fires a quit latch inside the consuming
   reader (`quitLatch`/`lineReader`, `src/guide.ts`) instead of being
   swallowed as an answer: every later read declines instantly and the app
   shuts down before the broadcast starts (spec 01 §3.6 extended to the Q&A
   flows).
2. **The guide's coverage grows** from the music binaries to the full
   onboarding surface:
   - `yt-dlp` + `ffmpeg` — as built (§1-§5). **Install channel (decided
     2026-07-31)**: for a *missing* binary the guide prefers the user's own
     package manager — on macOS Homebrew, the same channel `ffmpeg` comes from
     — so both binaries stay on ONE upgrade path; a Python-tool installer
     (`uv tool` / `pipx`) for `yt-dlp` is the fallback, used only when Homebrew
     is unavailable or cannot provide it. The remedy is still never prescribed
     beyond this channel preference; the cause remains the agent's to diagnose;
   - **yt-dlp freshness (added 2026-08-12)**: releases are dated
     (`YYYY.MM.DD`) and extractors rot as sites move their APIs and anti-bot
     checks — Bilibili breaks first (its search/page endpoints 412 stale
     clients). `preflightYtdlpFreshness` (`src/startup.ts`) reads `--version`
     locally and flags a release older than 60 days as a `ytdlp` gap. The
     probe is deliberately **not** a live Bilibili fetch: those endpoints
     answer probabilistically (smoke-measured 412 flicker on identical
     back-to-back requests), so a functional probe would misreport in both
     directions, while the release date is deterministic and free. The gap
     rides behind a WORKING music pair (a broken install is the music gap's
     business, and its repair — an install — already lands the current
     release) and never degrades the session: music keeps playing, the offer
     proposes an upgrade on the channel that owns the binary, verified by
     re-reading the release date;
   - `bun` — the spec-10 front-end runtime (pays off spec 10 §5.10): the guide
     runs the official installer under the entry authorization and verifies
     with `preflightBun`; until then the front-end has fallen back to plain
     (spec 10 §6 default record);
   - the **hosted-voice endpoint** — §7.2.
   - **Amended (2026-08-01, issue #93)**: the voice endpoint is a **nameable
     gap at boot regardless of the voice knob**. With no endpoint the knob
     reads `stub`, the stub engine works, and no probe fails — so keying the
     gap off `voice === 'hosted'` meant a new listener was never told at boot
     that the radio has no real voice. The gap follows the ENDPOINT (env or
     `voice.json`), never the knob; it is an offer item, never a blocker (the
     radio still launches on the stub voice). Corollary: the voice knob's
     default is endpoint-derived — `hosted` when one is configured, `stub`
     otherwise, an explicit `--voice` always winning — because a voice the
     conversation just wrote and validated must be audible (§7.3 criterion 5)
     rather than written and then ignored.
3. **Trigger policy**: at startup — after first-run (spec 06) when both apply;
   the two conversations stay separate and serial — the aggregated startup
   checks (03-02 §2.4 seam) name the gaps and offer the guide **once per
   boot**. The offer has three answers, one option per line on the card so
   each reads as a choice (user report 2026-08-17: a run-on action row made
   Enter look like a default yes): an affirmative (`y`/`yes`/common Chinese
   affirmations) opens the conversation; an **explicit no**
   (`n`/`no`/Chinese negations) starts the degraded session AND lands the
   `setup.declined` record on the tier-③ ledger (spec 05) — later boots with
   the same gaps print one info line instead of re-opening the conversation;
   **anything else — Enter and unrecognized answers included — skips once**:
   the session starts degraded, nothing is recorded, and the next boot offers
   again. Only an explicit no may buy the standing silence. The explicit
   entries always work.
4. **Degraded posture** (extends 03-02's talk-only rule): the radio always
   launches. No music → talk-only; no voice endpoint → segments render
   through the Host (plain or TUI) with the voice silent; the conversation
   channel is alive in every degraded shape — which is exactly what makes
   "talk to fix it" possible.

### 7.2 Voice-endpoint onboarding (new guide task)

- **Config home**: guide-written config lives under `$MURMUR_HOME` via
  `src/paths.ts` (path governance applies): `voice.json`, zod-validated, and
  **mirroring the `MURMUR_TTS_*` env surface knob for knob** —
  `{ ttsUrl, model?, referenceId?, apiKey?, seed? }`. Everything but the URL is
  optional, so a self-hosted server stays a one-field config; a hosted API needs
  the rest (below). Environment variables keep precedence **per knob** — `make
  dev` still loads `.env`, and env beats file — so `.env` stays a dev-time
  override the app itself never writes. The file may hold a credential, so it is
  written **owner-only (0600)**, and a **saved key is bound to the saved
  endpoint**: pointing the run somewhere else (`--tts-url`, `MURMUR_TTS_URL`)
  leaves the stored credential behind rather than handing it to another host.
  *Amended 2026-08-01 (issue #96): a URL-only config could never reach hosted
  fish.audio — it requires a Bearer key AND a `model` header on every request —
  so the one backend new users are pointed at could not be configured by
  conversation at all.*
- **Flow**: the guide explains where an endpoint comes from (a fish.audio
  account, or a self-hosted URL), walks the registration if needed (below), the
  user supplies it, and the guide **validates by synthesizing one real line**
  through the endpoint — with the whole config, key and model header included —
  before writing anything; a failed validation is explained and nothing is
  written. A configuration written mid-conversation is wired into **this** boot
  in full, not just its URL, or the freshly configured voice stays silent (§7.3
  criterion 5).
- **Registration walkthrough** (hosted): murmur cannot click for the user, so
  the guide narrates and **opens** each page as the walkthrough reaches it —
  the signup page, then the API-keys page — and names what to click there,
  pacing itself by the user's replies. Two things it must also get, or the result does not work:
  - the **`model`**, which the hosted API requires on every call;
  - a **`referenceId`** — a voice pinned in the listener's own account.
    fish.audio has no default voice identity and no `seed` in its request
    schema, so without one the timbre changes from line to line. murmur ships
    **no default voice id** — a hosted voice id is private to the account that
    created it, so the maintainer's would 403 for anyone else, and the public
    library's most popular voices are celebrity and character clones — but it
    ships **two reference clips of its own** (male / female, `voices/` in the
    repo, 2026-09-02) that `create_voice` clones INTO the listener's account on
    request (`preset`, below). The guide offers those first, then a recording
    of the listener's own, then a library pick. Skipping is allowed, and the
    guide says plainly what it costs.
- **Tool-captured secrets** (the rule, not just this case): a secret the user
  types **as a conversation message** becomes an SDK user message — it is sent
  to the API and kept in the local session transcript, where it outlives the
  conversation and is readable by any later session. So murmur-owned tools
  never take a credential as an argument. `write_voice_config` takes
  `needsApiKey` instead, and the **tool handler itself** asks the user through
  the Host and reads the line. The model learns only that a key was saved. The
  guide prompt says the same thing in words, because the model must not ask for
  one either.
- **No dated claims**: the guide states nothing about a provider's pricing,
  free tier or limits from memory — free windows move, and a wrong date is a
  promise murmur breaks silently. It **reads the current policy live**
  (WebFetch, at most two attempts — the provider's pages are fetcher-hostile,
  and issue #102 measured ~6 burned rounds without a cap) and reports what it
  just read; past the cap it degrades honestly: says it could not verify and
  hands over the link. No such date is hardcoded anywhere
  in murmur — prompts included. Consequently `WebFetch` joins the guide's
  built-in surface; it is strictly narrower than the `Bash` already there.
- **Tool surface**: this guide task gets TWO murmur-owned extra tools (zod
  input, realpath-scoped to the single config path — the same trust-boundary
  posture as spec 06 slice B). The SDK built-ins stay for diagnosis; these two
  are ours so the path scope is enforceable.
  - `write_voice_config` — the endpoint, proven by one real synth first.
  - `create_voice` (2026-09-01, user report) — the listener's OWN recording
    turned into a hosted voice, and pinned. **The reason it exists is the rule
    above.** A pasted key finishes the endpoint but not the timbre: the guide
    holds `Bash` and could upload a sample itself, except that the key is
    deliberately out of its reach (`SECRET_PATH` refuses any tool input naming
    `voice.json`, `.env` or `.murmur`), so it could only ever tell the listener
    to go do it on the provider's website by hand. That is a setup the guide
    cannot finish. The fix is the same shape as the secret capture: the model
    names a local file and a title, the HANDLER reads the key from the config
    and attaches it to the upload, and only the new voice id comes back. One
    pasted key now covers the whole voice setup.
    - The path is the model's one free-form input and an upload SENDS it, so
      the handler takes only an audio suffix and refuses everything else —
      handed `voice.json` it would post the credential to a third party
      itself. Size-bounded, aborts on Esc before the recording leaves the
      machine, and scrubs the key from any provider error before it reaches
      the conversation.
    - Provider shape, probed against the live API rather than a doc page
      (2026-09-01): `POST /model`, multipart, `type=tts`, `train_mode=fast`
      (usable the instant it is created), `title`, `voices` (the file), and
      optional `texts` (the clip's transcript, which improves the clone).
      Answers `201` with `_id` — that is the `referenceId`. The free tier
      allows it; a created model is deletable, which is how the probe left
      nothing behind.
    - **`preset: male | female`** (2026-09-02) — the same upload, fed from one
      of murmur's own clips instead of a listener path. The clips are **not in
      the npm package**: a listener with a voice of their own, or one from the
      library, would download bytes they never use. They live in the repo
      (`voices/`, excluded from `files`) and the handler fetches the picked one
      on demand from the raw GitHub URL into `$MURMUR_HOME/cache/voices/`,
      **verifies it against a sha256 pinned beside the URL**
      (`assets/voice-presets.json`, which also carries the clip's title and
      transcript), and only then uploads. The pin is what makes a file fetched
      from `main` trustworthy under the listener's key — so a clip is never
      edited in place; a new timbre is a new filename and a new pin. A cached
      clip that no longer matches is re-fetched, not uploaded. A failed or
      mismatched download is an error that names the URL, so the guide can
      hand the listener the file to fetch by hand and finish through
      `audioPath`. No mirror, no retry queue: GitHub reachability is the one
      known soft spot (listeners in mainland China), and the by-hand path is
      the fallback until it is measured to matter.
  - **Both tools ride the TARGET, not the gap** — and an EXPLICIT entry with
    no gaps opens the conversation instead of closing it. The two follow from
    one observation: the listener who reopens setup is usually there to change
    something that already WORKS, above all the timbre the guide itself invited
    them to settle later. Gating on "the endpoint is missing" meant that
    invitation led to a guide with no tool to act on it, and then to a machine
    that answered `/setup` with `everything checks out` and shut the door. So a
    clean explicit run gets a prompt of its own (`healthyMachinePrompt`) that
    hands over no repair task at all — a guide told to fix things will find
    things to fix — and asks what they came to change. No consent card is
    shown there: the y is a consent to REPAIRS, and walking in was the consent.
    The boot path is unchanged (silent on a clean machine), and a run that
    wants no voice has no tool to offer, so it keeps the one-line answer.
    A visit runs under its OWN system persona (`VISIT_PERSONA`): everything
    the repair persona derives from "the user said yes to fixing this" — investigate
    first, make routine changes unasked — is what must not carry when there is
    nothing to fix, and a task prompt cannot hold that line against a system
    prompt saying the opposite while the permission callback auto-allows what
    the persona authorized. The credential rule is stated in both.
  - **The tool reaches the EFFECTIVE endpoint**, not the file: `voice.json < env
    < flags` is the precedence everything else resolves in, so a listener whose
    endpoint comes from `.env` (and therefore has no `voice.json` at all) must
    not be told there is no endpoint while the radio is speaking through one.
    The new voice id is still written to the one file murmur may write, and it
    is merged onto what that FILE holds — an env-only knob does not get
    persisted as though the listener had chosen it.
  - **A voice created mid-run is heard in that run.** `voiceAfterSetup` merges
    per knob rather than returning early when the run booted with a URL: "did
    this run have an endpoint" is a different question from "did the
    conversation change anything", and the early return meant a listener who
    created their own voice kept the old timbre until the next boot while setup
    reported success. Each knob the run already stated still wins.

### 7.3 Acceptance (continues §5)

> **Status (2026-07-31)**: criteria 5-8 are built and pinned by unit tests at
> their deterministic seams (`test/setup.test.ts`, `test/voice-config.test.ts`,
> `test/dev-preflight.test.ts`, `test/app.test.ts`) plus an isolated-environment
> smoke (`scripts/onboarding-smoke.ts`: throwaway `$MURMUR_HOME`, a PATH holding
> only node + claude, real probes and real writes). What remains user-run is the
> same thing §5.3 always was — the real-SDK conversation on a real broken
> machine, which no fake can prove.

5. With no `.env` and no voice config, `make dev` launches, names the gap in
   plain language, and the guide conversation ends with a validated
   `$MURMUR_HOME` voice config and an audible line — the user never touches
   a shell.
6. With bun absent, the front-end falls back to plain and the guide can
   install bun under the entry authorization; after it, `--tui` works
   (pays spec 10 §5.10).
7. An explicit no at the boot-time offer starts the degraded session and
   writes the ledger record; the next boot with the same gaps prints one line
   and does not re-open the conversation. Enter (or an unrecognized answer)
   also starts the degraded session but records nothing — the next boot
   offers again.
8. A missing `node` still stops `make dev` at the shell — there is nothing
   to converse with.

### 7.4 As built (2026-07-31)

Mechanism decisions this slice settled while building, recorded so they are not
relitigated. Criteria 5-8 are pinned by unit tests at the deterministic seams;
the full real-SDK conversation is a user/dispatcher run (§5.3's posture).

- **One aggregated offer replaced the per-check registry.** `StartupCheck` /
  `runStartupChecks` (03-02 §2.4) is gone: it registered one interactive check
  per gap, and §7.1 point 3 requires the opposite — every gap named together and
  offered **once**. `guide.ts::runSetup` is now that phase. The deterministic
  probes it aggregates (`preflightMusic`, `preflightBun`, the voice-endpoint
  read) stay exactly where they were, and `detectGaps` skips any probe the
  session does not want, so `--no-music` still costs no yt-dlp search.
- **A degraded launch is active, not passive.** With gaps, murmur names them in
  plain language and opens the conversation on every boot. The single quiet info
  line applies ONLY after an explicit decline (`setup.declined` on the tier-③
  ledger). The explicit entries ignore the record entirely, and declining an
  explicit `make setup` does **not** write one — reaching for setup on purpose
  and backing out is not the standing "stop asking me" the boot offer records.
- **The recheck re-probes rather than believes the conversation.** "The
  assistant said it installed yt-dlp" is not the fact "yt-dlp works"; the
  outcome the session wires itself from comes from a second probe.
- **`voiceUrl` is read as a thunk**, so an endpoint written mid-conversation is
  heard on THIS boot: the voice provider is built after the setup phase.
- **The ledger gained a `setup` kind** and an impl-level `recentEvents(kind, n)`
  reader on both stores — deliberately not on the `MemoryStore` contract, the
  same posture spec 06 used for `writeProfile`.
- **`write_voice_config` takes no path argument.** The destination is closure-
  bound to `$MURMUR_HOME/voice.json`, resolved with realpath: a symlinked home
  is followed (relocating `~/.murmur` is normal), but a symlink planted *at*
  `voice.json` is refused. The path is resolved BEFORE the validation synth, so
  an endpoint that could never be persisted costs no TTS call.
- **Config precedence is per knob**: `voice.json` < env < flags. Unset env
  variables are omitted rather than blanked, so `.env` overrides only what it
  actually states — and the app never writes `.env`.
