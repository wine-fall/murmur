# spec/10 · tui — the terminal UI front-end

> **Status**: Design. Not yet implemented.
> **Part**: Front-end refinement — replaces the CLI Host's plain print/stdin with a real TUI. The **single richer front-end murmur ever gets**: there is no GUI, no menu-bar, no web surface (master [`../DESIGN.md`](../DESIGN.md) §3.6, §8).
> **Milestone**: Front-end polish — **off the L0→L1 critical path**. Buildable any time after spec 01; independent of voice (02) and music (03).
> **Conventions**: English; written for a coding agent. Design-level — mechanism and contracts, not final code.

---

## 1. Goal & scope

### Delivers
A terminal UI that replaces the plain `cli_host` (spec 01: `print` + line-at-a-time async stdin) with a live, non-clobbering interface, in the **same single asyncio process** (master §3.6 — no daemon, no second window):
1. A **now-playing / status region** that updates live: current segment kind (talk / music), persona name, and program state (on-air / inter-segment gap / awaiting-reply).
2. A **scrolling program log**: radio segments and your typed lines, interleaved in chronological order, scrollable back.
3. A **stable input line** that is always available and never gets clobbered by the radio printing mid-keystroke (the core defect of plain stdout interleaving).
4. Clean **stop** from inside the TUI (`/quit` and Ctrl-C), tearing down the TUI and the voice backend in order.

### Out of scope (explicit non-goals)
- **No GUI / menu-bar / web surface** — ever. If murmur has any UI, it is this TUI (master §8).
- **No daemon / detach / reattach** — the radio surviving terminal close + a reattachable session is the optional daemon/client side-spec (master §10.1); that spec would *build on* this TUI, not the reverse.
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

### 2.2 Same process, same loop
The TUI runs **inside the existing asyncio event loop** alongside the Director (master §3.6, §4 concurrency model). The Director pushes render events to the host; the host yields user lines back. No new process, no IPC.

---

## 3. Design

### 3.1 Framework
A TUI/async-input library is required here — this is exactly where a third-party dependency earns its keep (plain stdout/stdin cannot give a non-clobbering input line). Candidates (decide in this spec's plan): **`textual`** (full async TUI: layout, scrollback widget, input widget, themes) or the lower-level **`prompt_toolkit`** (+ `rich` for rendering) for a leaner footprint. Whichever is chosen must be **async-native** so it co-runs in the Director's loop without a thread bridge.

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
- External: one TUI library (`textual`, or `prompt_toolkit` + `rich`) — selected in this spec's plan.

---

## 5. Acceptance criteria
1. Launching with `front_end="tui"` shows a live **now-playing/status region** and a **scrolling program log**; radio segments appear in the log as they go on air.
2. Typing while the radio is talking **never clobbers** the input line, and the radio output never lands in the middle of your half-typed line.
3. Submitting a line **interrupts**, gets an in-persona reply, and the program **resumes** — identical semantics to the plain host (spec 01 step 3).
4. `/quit` and Ctrl-C **exit cleanly**, tearing down the TUI and the voice backend.
5. The **plain host still works** (`front_end="plain"`): the front-end is genuinely swappable behind the seam, and the fast test layer runs with no TUI present (proves the seam).

---

## 6. Open questions
- **Framework**: `textual` (richer, heavier) vs `prompt_toolkit` + `rich` (leaner). Decide by prototype feel.
- **Default**: does the TUI become the default front-end once stable, or stay opt-in with `plain` as default?
- **Status detail**: how much to surface (just state, or also recent-topic / token-usage hints once spec 08 exists)?
- **Persona/voice attribution in the log**: show a speaker label/color per segment, or keep it minimal?
