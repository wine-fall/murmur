# spec/10 · tui — the terminal UI front-end

> **Status**: Design. Not yet implemented.
> **Part**: Front-end refinement — replaces the CLI Host's plain print/stdin with a real TUI. The **single richer front-end murmur ever gets**: there is no GUI, no menu-bar, no web surface (master [`../DESIGN.md`](../DESIGN.md) §3.6, §8).
> **Milestone**: Front-end polish — **off the L0→L1 critical path**. Buildable any time after spec 01; independent of voice (02) and music (03).
> **Conventions**: English; written for a coding agent. Design-level — mechanism and contracts, not final code.
> **Amended (2026-07 — two-process direction)**: superseding the original in-process design, the TUI is now a **separate process** attached to a headless murmur engine over **language-neutral IPC** (master §3.6, amended). **Locked**: "two processes over IPC"; front-end = **Go / Charm (Bubble Tea)** (§3.1). **Still open (§6)**: the **IPC protocol** and the **`Host`-seam→IPC mapping**. Sections below that assumed same-process are superseded/annotated inline.

---

## 1. Goal & scope

### Delivers
A terminal UI that replaces the plain `cli_host` (spec 01: `print` + line-at-a-time async stdin) with a live, non-clobbering interface, running as a **separate front-end process** attached to the headless murmur engine over IPC (master §3.6, amended 2026-07 — the original in-place single-process wording is superseded):
1. A **now-playing / status region** that updates live: current segment kind (talk / music), persona name, and program state (on-air / inter-segment gap / awaiting-reply).
2. A **scrolling program log**: radio segments and your typed lines, interleaved in chronological order, scrollable back.
3. A **stable input line** that is always available and never gets clobbered by the radio printing mid-keystroke (the core defect of plain stdout interleaving).
4. Clean **stop** from inside the TUI (`/quit` and Ctrl-C), tearing down the TUI and the voice backend in order.

### Out of scope (explicit non-goals)
- **No GUI / menu-bar / web surface** — ever. If murmur has any UI, it is this TUI (master §8).
- **Daemon / detach / reattach — now overlaps by consequence (amended 2026-07)**. The two-process direction (headless engine + attachable TUI over IPC) *is* the substrate the daemon/client side-spec (master §10.1) wanted. v1 need not ship detach/reattach *UX*, but the engine↔TUI split must be designed so it does not preclude it. How much detach/reattach v1 exposes is an open question (§6), not a wholesale deferral.
- **No new core behavior** — the TUI does not change the Director, Brain, Voice, Music, or Memory contracts. It is purely the front-end surface. Talk-back semantics (interrupt → reply → resume) are owned by spec 01 step 3; the TUI just drives the same path.
- No mouse-driven dashboards, multi-tab layouts, or theming engine beyond the radio essentials.

---

## 2. Contract / seam

### 2.1 The CLI Host becomes a swappable front-end seam
Spec 01 ships a concrete `cli_host` that both **renders** (now-playing + program text) and **reads** keyboard lines + owns the manual-stop signal. This spec formalizes that role into a **front-end seam** with two plain implementations behind it:

- `PlainHost` — spec 01's existing `print`/stdin host (kept; the fallback / headless front-end).
- `TuiHost` — this spec's TUI.

The seam (a `Host` Protocol, owned by spec 01 and *extended*, not broken, here) covers what the Director already needs:
```python
class Host(Protocol):
    def banner(self, persona_first_line: str) -> None: ...
    def on_radio_segment(self, text: str) -> None: ...
    def on_user_line(self, text: str) -> None: ...
    def on_state(self, state: str, *, now_playing: str | None = None) -> None: ...  # added by this spec
    def info(self, message: str) -> None: ...
    async def input_lines(self) -> AsyncIterator[str]: ...  # the keyboard source (spec 01 step 3)
    async def start(self) -> None: ...
    async def aclose(self) -> None: ...
```
- `on_state` is the **one addition** this spec makes to the spec-01 host surface (so a richer front-end can show on-air / gap / awaiting-reply). `PlainHost` may no-op it. This is a permitted *extension* of a spec-01-owned contract (spec 01 §2 rule: downstream may extend, must not break).
- Front-end selection is config-driven (a `front_end` knob in `config`, mirroring `voice_provider`): `"plain"` (default) or `"tui"`. The core never imports a concrete host directly — a `build_host(name)` factory returns the seam.

### 2.2 Two processes over IPC (amended 2026-07 — supersedes "same process, same loop")
The TUI is a **separate process** from the murmur engine. The engine runs headless (Python — the core loop of specs 01/02/03); the TUI process attaches over a **language-neutral IPC** (the same *class* of boundary as the TTS sidecar, master §3.3). The engine emits render events (banner / segment / user-line / state / info) to the TUI; the TUI sends back user lines and control (`/quit`).
- **The `Host` seam (§2.1) still holds** as the engine-side contract — but `TuiHost` becomes a **thin engine-side adapter that bridges those `Host` calls onto the IPC**, with the actual rendering living in the separate TUI process. `PlainHost` stays fully in-process (the headless / test path).
- **Deferred to this spec's plan (not decided here)**: the concrete IPC transport + message schema, and the exact `Host`-call→wire-message mapping. Only the two-process boundary itself is locked.

---

## 3. Design

### 3.1 Framework — Go / Charm (Bubble Tea) (decided 2026-07)
The TUI is a **separate-process** front-end, so the framework is **no longer a Python in-process library** and need not co-run in the Director's asyncio loop. **Decision: Go / Charm (Bubble Tea)** — with Lip Gloss (styling/gradients), Harmonica (motion), and `ntcharts` (audio visualization: waveform / spectrum / sparkline).
- *Why Go/Charm*: the Charm stack is built **warmth-first** (a companion feel, not a dev-tool dashboard); `ntcharts` gives **ready-made audio visualization**; the MVU structure is **highly AI-friendly / fast to build against** — the original top priority.
- *Why not Rust/Ratatui (considered, rejected for v1)*: its edge was crisp **bitmap** pixel-pets via `ratatui-image` on Ghostty's Kitty protocol + `tachyonfx` effects. But **no ready-made pet exists in either ecosystem** — the pet is custom work regardless of language — so Rust's bitmap edge is not leveraged by anything off-the-shelf, while its immediate-mode + borrow-checker cost real build speed. The crisp-sprite ceiling did not justify the friction for v1.
- *Consequence for the pet*: the pixel pet will be **block / half-block sprite art** (à la `krabby`'s unicode sprites), not true bitmaps. Accepted trade for v1.

The original in-process `textual` / `prompt_toolkit`+`rich` candidates are **superseded** by the two-process direction. Motivating goals for the richer front-end: **live audio animation** and a **warm, playful, companion feel** (e.g. a pixel pet) — explicitly *not* a dev-tool dashboard.

### 3.2 Layout (design-level)
- **Status region** (top or side): now-playing kind + persona name + state badge (on-air / gap / awaiting-reply), fed by `on_state`.
- **Program log** (main, scrollable): chronological stream of `on_radio_segment` (radio) and `on_user_line` (you), visually distinguished.
- **Input line** (bottom, always focused): your typing accumulates here and is submitted as a line to `input_lines()`; radio output flows into the log above without ever disturbing the input line.

### 3.3 Input & interruption
The TUI owns the keyboard. A submitted line drives the **same** interjection path spec 01 step 3 defines (interrupt current segment → Brain replies → program resumes) — this spec does not re-specify that behavior, only sources the line from a TUI input widget instead of raw stdin. `/quit` and Ctrl-C raise the same orderly-shutdown path (spec 01 §3.6).

### 3.4 Default vs opt-in
Whether the TUI becomes the **default** front-end or stays opt-in (`front_end="tui"`) is an open question (§6). Until decided, `"plain"` remains the default so the core loop and tests stay framework-free (master §11.1 — the fast test layer runs the core against fakes with no TUI).

---

## 4. Dependencies
- **spec 01** (`core-loop`): the CLI Host seam + the Director events + the step-3 talk-back path. This spec extends the host seam (`on_state`) and adds `TuiHost`.
- Independent of spec 02 (voice) and spec 03 (music): the TUI renders talk-only or talk+music identically.
- External: the separate-process TUI is **Go / Charm (Bubble Tea)** (+ Lip Gloss, Harmonica, `ntcharts`; §3.1), plus the engine↔TUI **IPC layer** (selected in this spec's plan).

---

## 5. Acceptance criteria
1. Launching with `front_end="tui"` shows a live **now-playing/status region** and a **scrolling program log**; radio segments appear in the log as they go on air.
2. Typing while the radio is talking **never clobbers** the input line, and the radio output never lands in the middle of your half-typed line.
3. Submitting a line **interrupts**, gets an in-persona reply, and the program **resumes** — identical semantics to the plain host (spec 01 step 3).
4. `/quit` and Ctrl-C **exit cleanly**, tearing down the TUI and the voice backend.
5. The **plain host still works** (`front_end="plain"`): the front-end is genuinely swappable behind the seam, and the fast test layer runs with no TUI present (proves the seam).

---

## 6. Open questions
- **Language/framework** — **resolved: Go / Charm (Bubble Tea)** (§3.1).
- **IPC protocol + `Host`-seam mapping**: transport (unix socket / stdio JSON-lines, per the TTS-sidecar precedent §3.3) + message schema + how `Host` calls map to wire messages. Note the cross-language boundary is now real (Python engine ↔ Go TUI), so the protocol must be language-neutral.
- **Daemon/detach reconciliation (master §10.1)**: the two-process split subsumes the daemon substrate — decide how much detach/reattach UX, if any, v1 exposes.
- **Default**: does the TUI become the default front-end once stable, or stay opt-in with `plain` as default?
- **Status detail**: how much to surface (just state, or also recent-topic / token-usage hints once spec 08 exists)?
- **Persona/voice attribution in the log**: show a speaker label/color per segment, or keep it minimal?

### 6.1 The design conversation still to have (deferred — brainstorm as its own session)
Beyond the technical open questions above, the **creative** side of the TUI is intentionally not designed yet. To pick up next:
- **Art direction**: overall look / warmth / palette — a **companion radio** feel, not a dev-tool dashboard.
- **The pixel pet**: sprite art (block / half-block per §3.1), idle + reaction behaviors, how it responds to program state (talking / music / awaiting-reply), motion via Harmonica.
- **Audio animation**: the visualizer style driven by the engine's audio — waveform / spectrum / VU — via `ntcharts`.
- **Layout & personality**: how the status region + program log + input line + pet + visualizer compose into something that feels alive.
