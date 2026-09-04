# spec/12 · settings — the listener's knobs, persisted

> **Status**: Frozen 2026-08-07 (designed in-session with the user; self-grilled
> per repo convention). Building.
> **Part**: A persistent settings layer (`~/.murmur/settings.json`) owned by the
> engine, plus the TUI settings pane (`/settings`). The layer is engine-wide —
> the plain host consumes the same file; the pane is merely its TUI face.
> **Master**: [`../DESIGN.md`](../DESIGN.md) §10 row 12.
> **Milestone**: companion polish — off every critical path.
> **Conventions**: English; written for a coding agent. Design-level —
> mechanism and contracts, not final code.

---

## 1. Goal & scope

### Delivers

1. **`$MURMUR_HOME/settings.json`** — a hand-editable, panel-written,
   agent-writable persistence layer for the knobs a *listener* (not a
   developer) adjusts, merged under env and flags at boot.
2. **The engine as the sole settings authority**: one live store, one writer,
   change events; every consumer goes through the same engine-side setter.
3. **Two additive wire messages** (`settings` / `settingsSet`) so the TUI
   reads and writes settings without touching disk or importing anything
   beyond `src/host/ipc.ts`.
4. **A `/settings` pane in the TUI** — exactly **eight writable items** plus
   two read-only lines. Eight is the ceiling, not a tranche (spec 10 §1 rules
   out the sixteen-knob theming engine).
5. **Hot application**: every item targets take-effect-now; anything that
   falls to the recorded fallback is labeled honestly in the pane.
6. **Two equal ways to change every knob** (amended 2026-08-25, §2.6): the
   `/settings` pane **and** simply telling murmur. Neither is the "real" one —
   the pane's keypress and the reply turn's `change_settings` tool call the
   same `SettingsStore.set`, so they cannot drift.

### The eight writable items

Seven were locked 2026-08-07. The eighth was added **2026-08-25 by user
decision**: spec 06 §3.2 made the host's language a real choice, and a choice
with no user-facing way to change it is not a setting. The lock stands for
everything else — this is not an invitation to a ninth.

| # | Pane intent (user-facing) | Underlying knob(s) |
|---|---|---|
| 1 | Morning/evening anchors on/off | `anchorsEnabled` |
| 2 | Music on/off (off = pure talk radio) | `musicEnabled` |
| 3 | Mix gear: more-music ↔ more-talk | `cadenceMode` + `musicEveryN` (§3.5) |
| 4 | Breathing room between segments | `gapSeconds` |
| 5 | Sound on/off (mute keeps broadcasting) | `muted` (§3.4 — the master output gain) |
| 6 | Pixel pet on/off | `tuiPet` (§3.7) |
| 7 | Memory span (advanced group) | `recentWindow` |
| 8 | The language it speaks | `language` (§3.9) |

Read-only display: the resolved storage home (`config.home`) and the voice
endpoint status (configured / not configured — **never** the key or URL
contents beyond what `hello` already shows).

The pane exposes **intent, never field names**: `every_n` / `random` / `brain`
and the raw knob identifiers appear nowhere in the UI.

### Out of scope (explicit non-goals)

- **No pane entry and no settings-file key** for: `gatingEnabled`,
  `bedEnabled`, `ffmpegCmd` / `ytdlpCmd` / `bunCmd`, `MURMUR_HOME`, the
  `MURMUR_TTS_*` six (owned by the setup conversation + `voice.json`, spec
  03-03 §7.2), `MURMUR_TUI_KITTY_KEYBOARD`, `brain`, `frontEnd`,
  `maxSegments`, the model tier knobs (`model` / `musicModel` /
  `compactModel`), `personaPath`, `MURMUR_SCENE` / `MURMUR_ACTIVITY`,
  `MURMUR_DEV_LOG`. `memoryDir` / `tuiSocket` are pure derivations with no
  handle — they stay read-only facts of the home.
- **No theming, no layout knobs, no mouse** (spec 10 §1).
- **No schema extension points.** The file schema is exactly the nine keys of
  §3.1; unknown keys are dropped on read.

---

## 2. Contract / seams

### 2.1 The file

- **Path**: `$MURMUR_HOME/settings.json`, resolved by `paths.ts`
  (`settingsPath()`), sitting at the home root beside `voice.json` — it is
  re-obtainable configuration, not irreplaceable state (master §6.1).
- **Schema** (zod, `src/host/settings.ts`): all keys optional; absence = "the user
  never touched this knob", which falls through to the layer below.

  ```ts
  {
    anchorsEnabled?: boolean
    musicEnabled?: boolean
    cadenceMode?: 'every_n' | 'random' | 'brain'
    musicEveryN?: number   // int, positive
    gapSeconds?: number    // >= 0
    recentWindow?: number  // int, positive
    muted?: boolean        // the listener's output mute (§3.4)
    tuiPet?: boolean
    language?: string      // the spoken-language override (§3.9)
  }
  ```

- **Per-key salvage on read** (differs from the `voice.json` whole-file rule,
  deliberately): the file is hand-editable *and* panel-written, so one broken
  key must not silently discard the rest — a lost mute state is a real harm.
  Read = parse JSON (unparseable file → no settings, dev-log one line), then
  validate **key by key**; a bad key is dropped with a dev-log line, good
  keys survive. Unknown keys are dropped.
- **Atomic write**: temp file + rename in the same directory (the
  `voice-config.ts` template). No secret ever lives here, so no `0600`
  ceremony. The engine writes the full current set of user-touched keys; it
  never rewrites keys the user has not touched (absence is meaningful).

### 2.2 Boot-time precedence

Per knob, lowest first: **`settings.json` < env < CLI flags** — the
`voice.json` precedent (spec 03-03 §7.2), applied uniformly. Concretely, the
settings layer is spread into `parseCli`'s merge below `ttsFromEnv` and the
flag spreads.

The settings layer never touches the `voice` provider knob: `muted` is the
output gain (§3.4), while which provider synthesizes (`stub`/`hosted`,
`voiceExplicit`) stays the env/flag/endpoint-derived dev surface it always
was — a muted run keeps its warm hosted voice.

### 2.3 Runtime rule — the latest user intent wins

Layering is a **boot-time** rule only. A `settingsSet` arriving at runtime is
the newest statement of user intent: it takes effect immediately **and**
persists to the file, even if this run was launched with a flag that overrode
that knob at boot. (Otherwise the pane is a dead UI: the user flips a switch
and nothing happens.) At the next boot the layers apply again — a re-passed
flag wins again, which is what flags mean.

### 2.4 The engine-side store (the single authority)

```ts
// src/host/settings.ts
// The 9 keys of §3.1, resolved. All required EXCEPT `language`, whose absence
// is meaningful at runtime too: it means the persona decides (§3.9).
export type Settings = { /* ... */ }

export interface SettingsStore {
  current(): Settings                    // resolved, live values
  set(patch: Partial<Settings>): void    // validate → apply → persist → notify
  onChange(fn: (next: Settings) => void): void
}
```

- Initialized from the merged boot `Config` (so flags/env are respected as
  the starting state), **not** from the file alone — except `language`, which
  has no `Config` field to carry it and is seeded straight from the file
  (§3.9).
- `set()` is the **only** mutation path — the pane and any future agent tool
  both land here. It zod-validates the patch (reject = drop, no partial
  apply), applies to the live values, writes the file atomically, then
  notifies.
- What `set()` persists: the knob values being set, merged over the file's
  existing user-touched keys.

### 2.5 The wire (additive; `PROTOCOL` stays 2)

Engine → TUI — one new message:

| type | payload | when |
|---|---|---|
| `settings` | `{ values: Settings, home: string, voiceConfigured: boolean }` | after `hello` on every attach, and after **every** `settingsSet` (accepted or rejected — the snapshot always shows truth) |

TUI → Engine — one new message:

| type | payload | semantics |
|---|---|---|
| `settingsSet` | `{ patch: Partial<Settings> }` | engine validates via `SettingsStore.set`; a store-rejected patch (e.g. empty) is answered with a fresh unchanged snapshot — no error channel in v1. A patch that fails the wire schema itself (an illegal value) is a **malformed message** and gets the standard §2.3 treatment: dropped with a dev-log line, no reply — the pane offers only legal values, so only a foreign client can produce one |

- `settings` snapshots are **excluded from the replay backlog** (like `viz`):
  every attach gets a fresh snapshot anyway, and a replayed stale one could
  arrive after it.
- Older peers ignore both types (the §2.3 forward-compatibility rule); no
  protocol bump.

---

### 2.6 Two equal ways in (amended 2026-08-25)

Every knob in the table above is reachable **both** ways, and the two are the
same act:

1. **The pane** — `/settings`, a keypress becomes a `SettingsPatch` on the
   wire (§2.5), and the engine applies it.
2. **Saying so** — "turn the music off", "speak Japanese", "give it more room
   to breathe". The reply turn is already an agent (spec 11); it gains a
   `change_settings` tool whose handler calls the **same**
   `SettingsStore.set`.

Neither path is privileged and neither owns state. Consequences that are
contracts, not implementation taste:

- **One writer, still.** The tool does not touch disk, `Config`, or the
  Director's fields; it calls the store, and the store's existing
  persist-and-notify does the rest (§2.4). A pane open at that moment
  refreshes through the same `onChange` -> `settings` snapshot it always did.
- **The tool speaks intent, not field names.** Its schema is the pane's
  vocabulary (music on/off, more music / more talk, breathing room, sound,
  memory span, the language) — the raw knob identifiers appear in neither UI,
  per §1. The mapping from intent to fields lives in one place per client.
- **Ask before a destructive read of intent.** A settings change is cheap and
  reversible, so it needs no confirmation ceremony (unlike `end_broadcast`,
  spec 11 §2.1) — but the model must not infer one from a mood remark. "This
  song is too loud" is not "mute"; only an actual request changes a knob.
- **Narration follows delivery** (spec 11 §3.2): the tool applies the change
  and returns what is now true; the spoken reply is composed afterwards, so
  the host never promises a change it did not make.
- **Exposing the tool is not authorizing it.** The steer prompt's catch-all
  ends "anything the tools above do not cover is just conversation", so a
  settings rule must be added to that prompt alongside the `switch_music` one,
  gated on the same capability. A tool in the set that the prompt does not
  name is a tool the model is being told not to use.
- **Capability parity with the pane.** The pane greys the music items when
  this run has no music pipeline; the tool refuses those same fields for the
  same reason and says why. A knob the run cannot honour must never answer
  `ok`.

## 3. Design

### 3.1 File keys mirror `Config` field names

The file stores **raw fields, not intent gears**. The pane owns the
intent-to-field translation (§3.5); the file layer stays a trivial
`Partial<Config>` spread, the future agent tool can set precise values, and
no second vocabulary exists. `tuiPet` is the one new `Config` field
(boolean, default `true`).

### 3.2 Hot-application matrix

Every knob targets hot. Mechanism per knob:

| Knob | Mechanism | Effect boundary |
|---|---|---|
| `gapSeconds`, `recentWindow` | Director deps read the live store instead of captured scalars (`director.ts` already reads per loop) | next gap / next brain call |
| `muted` | one gain move on the engine's master bus (§3.4); nothing else in the program notices | **instant, mid-word** — it is the listener's volume knob, and unmute resumes the sentence in flight |
| `anchorsEnabled` | the scheduler is **always constructed**; the fire site checks the live flag | next anchor check |
| `cadenceMode` + `musicEveryN` | the cadence decision point reads the live store (rebuild-per-boundary or getter — implementation's pick) | next segment boundary |
| `musicEnabled` | the music pipeline is **built whenever its dependencies exist** regardless of the flag; the Director's schedule-next-music site checks the live flag. **Off gates the spend, not just the airtime** (peer-review find): the prefetch paths consult the same flag, so a disabled session pays zero discovery calls. Toggle-on re-enters through the existing boundary cold path (the away-stream precedent) | next segment boundary |
| `tuiPet` | client-side render toggle driven by the `settings` snapshot | immediate |
| `language` | the Director composes the system prompt as persona + the language directive (§3.9); a change re-composes it | next brain call |

**Fallback clause (recorded, with teeth)**: if implementation finds the
music pipeline's build-time coupling (yt-dlp preflight, guide trigger) too
entangled to build-when-disabled, `musicEnabled` falls back to
**restart-required in both directions** — never the asymmetric
"off is hot, on needs restart". The pane must then label the item
"takes effect next start". No other knob has a sanctioned fallback.

### 3.3 What hot application must NOT do

- Never interrupt the *program* on air (cadence changes land at the next
  boundary; a live segment finishes its script). Muting is not an
  interruption: the segment keeps rolling, only its sound is gated (§3.4).
- Never tear down / rebuild providers mid-run (the store flips flags;
  construction stays a boot concern).
- Never write the file except through `SettingsStore.set`.

### 3.4 Mute semantics — the listener's output gain

> **Re-decided 2026-08-07 (user re-frame, supersedes the original
> voice-provider mechanism).** The first build implemented mute as "route
> synthesis to the silent stub" (`voice: 'stub'` + a clearing `null`). That
> conflated two layers and produced an indefensible lag: the on-air clip and
> the look-ahead's pre-synthesized beats kept speaking after the toggle — a
> mute button that does not mute. The mechanism is retired; this section is
> the contract.

- **`muted` is the engine's master-bus gain** (`AudioEngine.setMuted`): one
  ramp to 0/1, ~80ms, bus-wide — voice, music, and bed together. It is the
  radio's volume knob, owned by the listener.
- **The program never notices.** Synthesis, discovery, scheduling, pacing,
  and the clips themselves all continue; text keeps landing in the log.
  Unmute picks the sound back up mid-sentence, exactly like a real radio.
  (The spend continues while muted — mute is a listening state, not a
  budget lever; `--no-music` / `--voice stub` remain the spend knobs.)
- **Instant both ways, mid-word.** No buffer to drain, no next-utterance
  boundary.
- The `voice` provider knob (`stub`/`hosted`, `voiceExplicit`) is untouched
  by the settings layer — it stays the dev/env surface for whether murmur
  synthesizes at all.
- The visualizer taps the bus, so muted bars go honestly flat.
- The pane's sound toggle never greys: mute works on any run with a speaker.
  The read-only endpoint line still explains "sound on but nobody speaks"
  (endpoint not configured — the setup conversation's job).

### 3.5 The mix gear (intent → fields)

Three gears, mapped engine-values at write time:

| Gear (UI intent) | Written values |
|---|---|
| more music | `{ cadenceMode: 'every_n', musicEveryN: 1 }` |
| balanced *(default)* | `{ cadenceMode: 'every_n', musicEveryN: 2 }` |
| more talk | `{ cadenceMode: 'every_n', musicEveryN: 4 }` |

- Current values that match no gear (hand-set `random` / `brain`, or another
  N via file/env/flags) display as a fourth read-only position, **custom**;
  selecting any gear overwrites it. `random` / `brain` stay reachable by
  hand-edit / flags — the pane never names them.
- `musicEnabled: false` greys the gear out (still visible, not adjustable —
  it is meaningless without music).

### 3.6 The pane (TUI settings mode)

- **Entry**: the listener types `/settings`. The engine owns command parsing
  (spec 10 §3.2-C) — it recognizes the command and replies with a fresh
  `settings` snapshot; the TUI opens the pane on that snapshot. An unknown
  front-end (plain host) treats `/settings` as it treats any command it has
  no rendering for: a one-line `info` pointing at `settings.json`.
- **Keys while open**: ↑/↓ move between items; Space/Enter toggles booleans
  and applies a gear; ←/→ step numeric items; Esc closes. Every change sends
  `settingsSet` immediately — there is no staged "apply" step; the radio is
  live and so are its knobs.
- **Numeric ranges** (pane-enforced; the schema itself stays permissive for
  hand edits): `gapSeconds` 0–10 step 0.5; `recentWindow` 4–48 step 2.
- **Groups**: six primary items; `recentWindow` sits under an **advanced**
  divider with the two read-only lines.
- **Focus — a sanctioned exception to spec 10's permanent-focus rule**:
  while the pane is open, keystrokes route to the pane and the input line
  shows a placeholder ("settings open — Esc to return"). The spec-10 red
  line defends against *radio output* stealing focus mid-keystroke; a
  listener-invoked mode is the listener spending their own focus. Esc is
  instant; the broadcast never pauses; the log keeps scrolling behind the
  pane. No IME interaction exists inside the pane (toggles and steppers
  only), so the CJK gate is untouched.
- **Honesty labels**: any knob operating under the §3.2 fallback clause shows
  "takes effect next start" inline. Nothing else carries a label — hot is
  the default and needs no caption.

### 3.7 The pet knob's new home

`tuiPet` moves from client-only env into the settings layer (this amends
spec 10 §3.3): file `tuiPet` < client env `MURMUR_TUI_PET` — the env stays
as a client-local escape hatch and final override, consistent with the
per-knob env-beats-file rule everywhere else. The value travels in the
`settings` snapshot; the client applies its own env override on top at
render time. The spec-10 argument ("the engine has no business in what the
band contains") loses to a stronger one: the settings layer exists precisely
so the engine is the *single configuration holder*, and one boolean riding
an existing snapshot is not a theming engine.

### 3.8 Testing posture

Per master §11: all deterministic → unit tests on fakes, test-first.

- File layer: per-key salvage (bad key dropped, good keys survive,
  unparseable file → empty), atomic write, unknown-key drop.
- Store: set→apply→persist→notify order; invalid patch = no-op;
  initialization from merged Config (flag respected at boot, overridden by a
  later `set`).
- Config merge: settings < env < flags per knob; `muted` rides in without
  touching the `voice` provider derivation.
- Wire: round-trip zod on both new types; snapshot-after-set including the
  rejected-patch case; backlog exclusion.
- Engine: `setMuted` silences the whole bus (voice + music) in an offline
  render and restores it — gain choreography asserted on samples.
- Hot paths: director picks up a changed `gapSeconds`/`recentWindow` without
  reconstruction; anchors/cadence/music flags consulted at their decision
  sites (fakes, no audio).
- Pane rendering is not frame-asserted (spec 10 §3.9); it gets the bounded
  client smoke plus the human pass (§5).

---

### 3.9 The language knob (added 2026-08-25)

The one knob whose authority lives outside this layer. Spec 06 §3.2 makes the
**persona** the standing statement of what the host speaks, written once at
onboarding and never rewritten by murmur. This knob does not touch that:

- **`language` is optional in the resolved `Settings`** — the only knob that
  is. **Absent means "the user never said", and the persona decides**, exactly
  the fall-through §2.2 already describes for the file. It is not defaulted to
  the detected locale: that default is already baked into the persona at
  onboarding, and defaulting here would silently override a persona the
  listener hand-wrote.
- **Set means an override**, applied by composing the system prompt as
  `persona` + one directive line (`languageDirective()`, `src/prompts/`).
  `persona.md` is never edited — so clearing the knob restores whatever the
  persona says, and a hand-edited persona is never clobbered by a stale knob.
- **Free text, not an enum.** The value is a language *name* as a person would
  say it ("Japanese", "Traditional Chinese", "Brazilian Portuguese"). Any
  closed list would be wrong for someone. Validation is a length bound and a
  one-line shape check, not a vocabulary.
- **The pane cannot step through it**, so the language item is the one pane
  entry that opens an inline text edit on Enter rather than toggling
  (§3.6 delta). Escape cancels; empty submit clears the override. The editor
  takes bracketed paste as well as keystrokes — the input line is unfocused
  while the pane is open, so paste would otherwise be dropped.
- **The FILE is its only boot source.** Unlike every other knob it has no env
  or CLI surface, so §2.2's precedence chain has just one link: the store's
  boot `initial` must be seeded from `settings.json` directly, not from
  `Config`. Seeding only the write-back set leaves the override dead after a
  restart — set once, gone next boot.

## 4. Dependencies

- **spec 01 / `config.ts`**: the merge chain.
- **spec 05 / `paths.ts`**: the single path authority gains `settingsPath()`.
- **spec 10**: the wire (`ipc.ts`), the TUI client, the replay backlog rule;
  amended at §3.3 (pet) and §3.3-adjacent (focus exception noted from this
  spec).
- **spec 03-02**: cadence + music scheduling decision sites; the engine's
  master bus carries the mute (§3.4).
- **spec 07**: the anchor fire site.

---

## 5. Acceptance criteria

1. **File & merge**: a hand-written `settings.json` changes the running
   defaults; a broken key is dropped alone (dev-log line) while its siblings
   apply; env and flags still beat the file per knob; a file-set `muted:
   true` boots the engine silent without touching the voice provider.
2. **Single writer**: every mutation path lands in `SettingsStore.set`; the
   file on disk is byte-stable except through it; writes are atomic.
3. **Wire**: attaching yields a `settings` snapshot after `hello`; every
   well-formed `settingsSet` (applied or store-rejected) yields a fresh
   snapshot, and a schema-invalid one is dropped as malformed (§2.5); old
   clients are unaffected; no protocol bump; snapshots never appear in the
   replay backlog.
4. **Pane**: `/settings` opens the pane; exactly eight writable items + two
   read-only lines; intent labels only (no `every_n`/`random`/`brain`, no
   field names); custom gear position renders when values match no preset;
   gear greys when music is off; the language row opens an inline edit (typed
   or pasted) instead of stepping, and reads "the persona's own" with no
   override set; Esc returns focus with the broadcast uninterrupted; ranges
   enforced as §3.6.
4b. **Both ways in** (§2.6): telling murmur to change a knob moves
   `settings.json` exactly as the pane's keypress does — verified at the FILE,
   never from the reply's narration; the steer prompt names `change_settings`
   only when a store is wired; the music fields are refused when this run has
   no music pipeline; a `language` set survives a restart.
5. **Hot effect, per knob**: gap and memory-span changes land without
   reconstruction (fakes); mute silences the whole output instantly and
   unmute restores it mid-sentence (offline render, §3.8);
   anchors/cadence/music honor the live flag at their next decision point —
   or, under the recorded fallback only, `musicEnabled` is labeled
   restart-required in both directions.
6. **Isolation intact**: `test/front-end-isolation.test.ts` stays green —
   the client's only `src/` import remains `ipc.ts`; the plain path
   (`frontEnd: 'plain'`) gains no new cost beyond one file read at boot.
7. **Human pass (sensory, user-run)**: the pane feels like part of the
   radio — open, flip music off, hear pure talk continue; mute and watch the
   program roll on silently; Esc back mid-song without a hiccup.

---

## 6. Open questions

- **Cadence hot mechanism** (rebuild-per-boundary vs live getter) — an
  implementation pick inside §3.2's contract, not a design fork.
- **The agent settings tool** (spec 11 posture: "say it and the radio
  adjusts itself") — the store is its seam; scheduling that tool is a later
  decision.
- **A `settings` CLI subcommand for plain-host users** (`murmur settings
  gap 3`)? Deferred — hand-editing the file is the plain path today; open it
  only if real friction shows.
