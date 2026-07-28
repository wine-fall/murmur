# murmur — current focus

_The single source of truth for "what are we building right now." Read it at
the start of any build task. Update it when the focus moves; date-stamp it._

_Last updated: 2026-07-28 (Phase 4.5)_

- **Migration in progress: Python → TypeScript (issue #54).** The TS
  implementation grows in top-level `ts/` beside the Python `src/` (the
  behavior oracle) until the Phase 5 cutover. Structure is designed fresh from
  the specs, never transliterated (issue ground rule).
  - **Phase 0 (done 2026-07-27):** audio-output binding decided —
    `node-web-audio-api` (Web Audio graph as the mixer; `OfflineAudioContext`
    for deterministic engine tests). Details in the issue's Phase 0 comment.
  - **Phase 1 (done 2026-07-27):** toolchain (`ts/` ESM skeleton, strict
    `tsc`, vitest, oxlint, zod-at-boundaries) + the spec-01 core loop in TS:
    contracts, config, in-process memory, persona, prompts, stub voice,
    subprocess player, CLI host, Director (batched talk + prepare-then-barge-in
    + `/quit`), StubBrain + ClaudeBrain on `@anthropic-ai/claude-agent-sdk`
    (isolated one-shot query + the `emit_talk_beats` in-process MCP tool seam).
    TS CI job added alongside the untouched Python jobs; the source-language
    gate now covers `.ts`. Unit-green; real-SDK smoke passed (MCP tool called,
    Chinese beats + reply).
  - **Phase 2 (done 2026-07-27):** hosted voice + music find/pull + cadence in
    TS. `HostedVoice` (spec 02 §3.6: fish-speech `/v1/tts` over `fetch`,
    `MURMUR_TTS_*` via zod, model header, seed pinning, sentence split + silence
    pad) is now the real voice — local MLX backends are not ported. Music
    (spec 03-01): yt-dlp `search`/`resolve`, the `search_music` + `submit_pick`
    tools with the pull-time probe seam, context insertion, `MusicProgrammer`.
    Cadence (spec 03-02 §2.3): `every_n` / `random` / `brain` + hard fallback.
    The harness is TS-native: `Harness.runTask<T>` over SDK `tool()`s built
    around a `finish` callback replaces Python's `BrainTool`/`terminal` protocol,
    and `nextTalks` was refactored onto it.
    **Decision — music does not air in Phase 2** (deliberate scope line): the
    only playback available is the interim subprocess player, which cannot mix,
    duck, or decode a stream URL, so wiring music into the Director now would
    mean interim playback that Phase 3 deletes (spec 03-02 §6 already settled
    "the interim player is moot"). Phase 2 therefore ships find+pull+cadence as
    verified seams; the Director's music branch, announce, and startup checks
    land with the engine in Phase 3.
    Real-boundary smokes all passed: fish.audio TTS (rtf 0.34-0.36, split beat
    spliced with a real pad), real yt-dlp search+resolve, and a real Haiku pick
    task that searched, judged, and returned title/artist/announce in Chinese
    with the resolved stream probed as playable.
    **Owed:** by-ear pass on the TS voice (same sensory bar as Python) and the
    music-pick latency — one `nextTrack` measured ~118s (a yt-dlp search alone is
    ~11s and the model runs several); spec 04's prefetch is what hides it, and it
    is not wired until the Director consumes music in Phase 3.
  - **Phase 3 (done 2026-07-27):** the audio engine as Web Audio graph
    orchestration on `node-web-audio-api` (spec 03-02) + the 03-04 bed + the
    Director's music branch. `ts/src/engine.ts`: per-channel `GainNode`
    automation is the mixer; long sources stream as **chunk-scheduled buffer
    segments** (the settled streaming decision — see 03-02 §3.1-TS) off the
    ffmpeg decode boundary (`ts/src/ffmpeg.ts`, abnormal exit raises); voice
    `play()` auto-ducks via the live `MusicHandle` with the unduck scheduled
    declaratively at the clip's known end; `OfflineAudioContext` renders are
    the unit layer (duck RMS ratio, bed crossfades, gapless chunk seams).
    Director (spec 03-02 §3.5): cadence at each boundary, single-slot music
    **pick-prefetch** (spec 04 slice 1 — a boundary never blocks on a pick
    still resolving; it airs talk instead), `waitStarted` confirmed before the
    announce commits (bounded retry, then visible degrade to talk), announce
    rides the ducked head, interjections duck and never stop the song, session
    avoid-list. Startup checks (spec 03-02 §2.4): deterministic yt-dlp+ffmpeg
    preflight, fail -> talk-only, `--no-music` skips; the interactive guide
    offer waits for Phase 4.5's `run_guide`. Bed (spec 03-04): same cache
    layout/key as Python (warm cache reused), first-run pull at loading time,
    `--no-bed`. The interim `SubprocessPlayer` is retired; `playerCmd/--player`
    replaced by `ffmpegCmd`.
    **Not ported yet (spec 04 remainder):** the talk look-ahead (depth-2
    buffer). Cost today: after a song ends, the next talk generates cold
    (Brain+synth wait); the music boundary itself never blocks (prefetch).
    **Owed:** the by-ear pass over the TS engine (duck/crossfade smoothness —
    same sensory bar as Python), the spec-04 talk look-ahead in a later phase,
    and a cancellable-task seam (an AbortSignal through `Harness.runTask`) so
    an in-flight background pick can be settled on shutdown — today the
    Director drops the reference and the orphaned subprocess self-terminates
    on EPIPE after process exit (bounded leak, accepted for now; Python could
    cancel because asyncio tasks are cancellable, TS promises are not).
  - **Phase 4 (done 2026-07-28):** memory + compaction (spec 05) in TS.
    `ts/src/paths.ts` gained `dataRoot()`; `ts/src/memory.ts` carries both
    stores — the extended `InProcessMemoryStore` and the file-backed
    `PersistentMemoryStore` (three tiers under `dataRoot()/memory`, zod-parsed
    on read, same on-disk layout as Python incl. snake_case `meta.json`, so
    the existing memory dir carries over at cutover). `ts/src/compaction.ts`
    is the single-flight Compactor over the store's compaction surface +
    `Brain.compactProfile` (neutral system framing, cheap tier via
    `compactModel`), poked by the Director per boundary, flushed on shutdown.
    `ts/src/scene.ts` ports the spec-04 §3.4 scene seam (ratified by 05 §2.2);
    `ContextPack` gained optional `scene`/`profile`/`coveredTopics`; the talk +
    respond prompts render the profile block, the cross-day don't-repeat line,
    and the scene cue. The Director ledgers per-beat topics and aired songs
    (replacing the session-local avoid-list) and reads the music avoid-list
    from the store. App wiring: persona homed into the memory dir (copy-once),
    stub runs stay fully in-process (stub isolation). 181 vitest tests green;
    the §5.10 two-run real-SDK smoke passed (run 2 carried run 1's tail;
    forced compaction wrote a plausible Chinese profile; topic tags arrived on
    real beats).
  - **Phase 4.5 (done 2026-07-28):** the guide harness (spec 03-03) in TS.
    `GuideCapable.runGuide(GuideRequest)` (`contracts.ts`/`brain.ts`) — the
    native Claude Code agent with the curated built-ins
    (Bash/Read/Write/Edit/Glob/Grep), `permissionMode: 'default'`, streamed
    text, and the multi-turn user-reply loop; a separate seam from
    `Harness.runTask`. Two TS-SDK seam facts pinned by unit + smoke: the
    surface is bounded via `tools` (NOT `allowedTools`, which auto-approves in
    the TS SDK), and `runGuide` always uses streaming input (the permission
    callback + reply loop both need it — the seam that regressed Python).
    Deterministic preflight probes (`preflightYtdlp`/`preflightFfmpeg`/
    `preflightMusic`, reason names each broken binary) in `startup.ts`;
    `guide.ts` wires the CLI (per-action y/N on the Director's stdin, reply
    loop, `runMusicSetup` offer→repair→recheck) and `musicSetupCheck` replaces
    Phase 3's message-only music check (the 03-03 auto-trigger). Explicit
    entry: `--setup-music`. Real-SDK smoke: streamed text, multi-turn reply
    reached the agent, a mutating command fired the ask and deny blocked it;
    the SDK's safe-command classifier runs read-only commands without an ask
    (consent semantics stay SDK-owned). **Owed: the interactive repair
    acceptance (real terminal, broken binary) is a user-run checklist.**
  - **Next: Phase 5 — cutover.** Delete the Python implementation, promote
    `ts/` -> `src/`, swap branch-protection required checks to the TS CI job,
    retool Makefile / pre-commit / source-language hook / dev scripts / the
    murmur skills, update this STATUS to the TS reality.
- **Milestone: L0 + L1 — code-complete (Python).** L0 = specs `01-core-loop` +
  `02-voice-provider`; L1 = adds `03-01-brain-harness` + `03-02-ducking` (+ the
  `03-03` guided install). The code and unit gate are done and green.
- **Current focus: cold-start / responsiveness — `spec 04` (no-dead-air),
  pulled forward.** A `make dev-fishaudio` measurement showed boot is fast
  (~3.5s) but the first-music wait is long (~76s: forced opening talk segments +
  a ~45s cold music search). Attacked in PRs:
  - **shipped (PR #24)**: spec 01 §3.3 — `Steer` + prepare-then-barge-in
    interjection (no dead-air on talk-back); groundwork for the look-ahead.
  - **shipped (PR #25)**: spec 04 slice 1 — **music-pick prefetch** (overlap the
    ~45s find-and-pull with the opening talk).
  - **shipped (PRs #26, #29)**: spec 04 slice 2 — **talk look-ahead** (batched
    `Brain.next_talks` via the `emit_talk_beats` harness tool; parallel TTS).
  - **building**: spec 04 §3.3 — **talk look-ahead survives music** (depth-2
    buffer, refilled when drained — including during a song — so the music→talk
    boundary has no Brain/synth wait; bounded retry + dev-log on the refill path).
- **Fixed (spec 03-02/04): "announced song but silent."** An intermittent
  googlevideo 403 made `play_music` hand back a handle that never decoded a
  frame; the announce had already claimed the song, then the loop silently cut to
  talk. Now: the music path has observability (`play_music` / feeder
  first-frame / EOF-reason+frames / surfaced ffmpeg stderr / `music.segment`
  timing), the decoder RAISES on abnormal ffmpeg exit (no longer masquerades as a
  clean end), and the Director confirms real audio (`MusicHandle.wait_started`)
  before committing the announce; on no audio it retries a fresh pick (usually a
  different, working stream) and only degrades visibly to talk once the bounded
  attempts are spent. Picks are also validated at PULL time: `submit_pick` probes
  the resolved stream (decodes one frame) and rejects a dead 403 as a retryable
  error, so the model picks another candidate during talk — the music boundary
  usually gets an already-playable stream, with `wait_started` as the play-time
  backstop. The bed now covers stream startup (bed<->song crossfade
  deferred to first audio), so a dead pick never leaves dead air. **Owed (by-ear pass):** the announce can still
  land a beat into the song when TTS synth outruns stream startup — sensory tuning.
- **Open: end-to-end latency measurement.** Acceptance so far is mechanism-level
  (fakes prove the buffers work); the motivating ~76s first-music wait has **not**
  been re-measured on a real run. Owed: a `make dev-fishaudio` before/after.
- **Built (spec 03-04): always-on background music bed.** A continuous
  low-volume instrumental under all talk that crossfades out under the featured
  song and back (building 03-02's deferred crossfade primitive), with a
  seamless bed loop. Curated `assets/bed_sources.txt` → first-run pull to
  `~/.cache/murmur/bed/` (`make bed-refresh`) → **local-only** at runtime.
  `--no-bed` / empty cache degrade to talk-with-silence. Mechanism unit-green +
  real-boundary smoke passed; **by-ear tuning of `_BED_GAIN`/`_BED_XFADE_S` and
  crossfade smoothness owed** (folds into the sensory pass below).
- **Open: by-ear / sensory acceptance** (L0/L1 "sounds human, feels like radio",
  PR #24's gapless-barge-in feel) — owed once the TUI is ready; a real listening
  pass, not an assertion.
- **Shipped (storage consolidation, chore ahead of spec 05):** `paths.py` — the
  single resolver for murmur's user storage under **one home** (`~/.murmur`,
  `$MURMUR_HOME`-relocatable; data/ + cache/ split by replaceable-or-not). The
  bed cache migrated from `~/.cache/murmur/bed`; a pre-commit gate
  (`scripts/check_paths.py`) forbids hardcoded home paths elsewhere. `DESIGN.md`
  §6.1 + spec 05 §2.3 updated from the earlier XDG plan to this one-home layout.
- **Built (spec 05, `specs/spec05/05-memory.md`): persistent memory —
  mechanism-level, 2026-07-21.** Three persistent tiers (profile/history/ledger,
  local files under `paths.data_root()/memory`) + cross-session context-pack
  assembly (ratifies the spec-04 §3.4 `scene` field; adds `profile` /
  `covered_topics`) + background compaction through the Brain seam. `emit_talk_beats`
  gained an optional per-beat topic (cross-day anti-repeat, issue #44); songs are
  ledgered at air time and feed the music avoid-list. Unit-green; real
  `compact_profile`/`next_talks` smoke-tested through the SDK. Library research in
  issue #45 (verdict: stdlib files, no dependency).
  **Owed:** the on-demand two-run persistence smoke + profile/topic quality by
  ear (eval track); persona **evolution** is spec 06 (this only homes persona.md).
- Later specs (06–09) are expected to change as we learn — not frozen.
