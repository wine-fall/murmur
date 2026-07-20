# spec/03-04 · background bed — always-on low-volume music under talk

> **Status**: **Built** (mechanism-level; by-ear tuning open). The bed channel,
> crossfade primitive, cached source, first-run pull, and CLI/Make wiring are
> implemented and unit-green; a real-boundary smoke pulled a bed and played it
> under talk with a bed↔song crossfade. The sensory pass (§5.8) — bed level,
> crossfade smoothness, loop inaudibility, and tuning `_BED_GAIN`/`_BED_XFADE_S`
> — is a by-ear checklist owed to the user (like the L0/L1 sensory bars).
>
> **As-built notes (divergences from the design, all minor):**
> - **Gains stay module constants**, not config. §1.6 listed "bed gain as
>   config"; §3.3 said "module constants". Kept them constants in
>   `engine/mixer.py` (`BED_GAIN`, `BED_XFADE_S`, mirroring 03-02's
>   `DUCK_TARGET`); config/CLI carry only on/off (`bed_enabled` / `--no-bed`).
>   The engine also accepts them as constructor params (tests inject tiny
>   values); adding env/CLI overrides later is a one-liner if wanted.
> - **First-run pull runs as an app-loading step** (`app.py`, before the radio
>   loop), not as a `StartupCheck` instance. The pull is non-interactive and
>   self-degrading; the `StartupCheck` seam is for interactive preflights. Intent
>   of §2.3 (loading-time, before the loop, degrades cleanly) is met.
> - **Manifest uses `ytsearch1:` refs** for the L1 curated set (a rotating
>   handful of calm instrumentals) rather than hand-pinned video ids — a copied
>   id that rots takes its line with it, and ids can't be verified offline. The
>   pulled file is cached and stable thereafter (the cache key is the ref string).
>   Upgrade path: pin explicit CC-BY URLs once verified.
> **Part**: An extension of the [`03-02`](03-02-ducking.md) mixing engine. 03-02
> plays a **featured song** and ducks it under voice, but during pure talk there
> is **no music at all** — silence under the host. This spec adds a continuous,
> low-volume **background bed** under all talk that **crossfades into** the
> featured song and back, so the air is never silent: "always music, never
> silence under talk." It builds the **crossfade** primitive 03-02 listed as an
> unbuilt "free upgrade."
> **Milestone**: polish over L1 (radio feel). See master [`../DESIGN.md`](../DESIGN.md)
> §4 (AudioEngine = sole audio authority; duck/stop), §3.5 (voice is the soul).
> **Conventions**: English; written for a coding agent. Design-level. No CJK in source.

---

## 1. Goal & scope

### Delivers
1. **A background-bed channel in the engine.** A third logical source (bed +
   featured-music + voice) that plays a low-volume instrumental **continuously
   under talk**, so a pure-talk stretch is never dead silence.
2. **Crossfade bed ↔ featured song.** When a featured song (03-02) starts, the
   bed **crossfades out** and the song **crossfades in**; when the song ends, the
   song crossfades out and the bed crossfades back in. The featured song is the
   clear foreground event; the bed is only ever the backdrop between songs. This
   is the concrete build of 03-02's deferred crossfade primitive.
3. **Seamless bed looping / rotation.** The bed never hard-cuts: as one bed track
   nears its end it crossfades into the next cached track (or loops itself), so
   the backdrop is gap-free for an arbitrarily long talk stretch.
4. **A curated, cached bed library (no runtime search, no dead-air).** The bed
   audio comes from a **curated manifest in the repo** (a small, versioned list of
   yt-dlp-resolvable refs), pulled to a local cache during **first-run loading**
   (onboarding-style — §2.3). At runtime the engine plays **only local files** —
   instant, offline, and free of the resolve latency spec 04 exists to hide. A
   `make bed-refresh` re-pulls after the manifest changes.
5. **Gain relationship.** The bed sits well under the voice (default ≈ 0.15–0.20
   of full) and, unlike the featured song, does **not** pump-duck under each voice
   clip (it is already low; ducking a low bed on every utterance would reintroduce
   the on/off "AI" pumping this is meant to smooth). The featured song keeps its
   03-02 duck-under-voice behavior. All gains/fades are module constants, by-ear
   tunable (§6).
6. **Config / CLI.** `--bed` / `--no-bed` (default on when a bed cache exists),
   plus the manifest path, cache dir, and bed gain as config with env/CLI
   overrides — mirroring the 03-02 music knobs (no code edit per swap). `--no-bed`
   (or an empty cache) degrades cleanly to the current talk-with-silence behavior.

### Out of scope (explicit non-goals)
- **Brain-picked / mood-matched bed at runtime.** The bed is curated + cached, not
  chosen per-segment by the Brain. Mood-aware bed selection is a later upgrade.
- **A runtime bed search** (open yt-dlp query). The manifest is a fixed, known set
  of refs; resolving happens at first-run loading, never on the audio hot path.
- **True sidechain compression** for the bed↔voice relationship — the bed is a
  fixed low gain, not a compressor. (Same posture as 03-02's fixed envelope.)
- **Per-track beat-matching / key-matching** between bed and featured song. The
  bed crossfades fully out under the song, so they never overlap.

---

## 2. Contracts / seams

### 2.1 The engine gains a bed
The 03-02 `AudioEngine` mixes a music `MusicHandle` + voice clips into one output.
This spec adds a **bed** as a persistent low-gain source the engine owns:

```python
class AudioEngine(Player):          # extends 03-02
    async def start_bed(self, bed: "BedSource") -> None: ...
    """Begin the continuous background bed (idempotent). The engine pulls PCM
    from `bed` (which yields successive local bed tracks) and mixes it at the bed
    gain under everything, looping/rotating with a crossfade so it never gaps.
    No-op if bed is disabled or the source is empty (degrade to no bed)."""

    async def stop_bed(self) -> None: ...
    """Fade the bed out and stop pulling from the source (on /quit / shutdown)."""
```

The bed↔song crossfade is internal: `play_music` (03-02) first **crossfades the
bed down**, plays the song (which still ducks under voice per 03-02), and on the
song's completion **crossfades the bed back up** — one code path, driven by the
existing music lifecycle. The Director is **unchanged**: it still just schedules
talk/music; the bed lives entirely inside the engine.

### 2.2 `BedSource` — local, cached tracks
```python
class BedSource(Protocol):
    def tracks(self) -> list[Path]: ...
    """The cached local bed files, in play order (empty -> no bed). Local files
    only; resolving/pulling happened at first-run loading, never on the audio
    path."""
```

A `CachedBedSource(cache_dir)` implementation lists the cached wavs. A fake in
tests returns scripted paths. No network at this seam.

### 2.3 The manifest + first-run pull (loading-time, off the hot path)
- **Manifest**: a versioned repo file (e.g. `assets/bed_sources.txt`) — one
  yt-dlp-resolvable ref per line, comments allowed. Curated by hand / by Claude
  Code; the only bed artifact committed (the repo stays **binary-free**).
- **First-run pull (onboarding-style):** the cache is populated during
  **first-run loading** — a startup step (the 03-02 Delivers #7 startup-check
  seam, beside the yt-dlp/ffmpeg preflight) that, when the cache is empty,
  resolves each manifest ref via the **existing 03-01 yt-dlp acquisition** into the
  local cache **before the radio loop starts**. This is a one-time loading wait
  (like onboarding), not an audio-path hop — so it never causes broadcast dead air
  (spec 04). Idempotent: subsequent runs find the cache warm and skip straight to
  playing. It logs failures and continues (a dead ref must not abort the pull); if
  the whole pull fails (e.g. offline), the session degrades to **no bed** and the
  radio still starts.
- **Manual refresh:** a `make bed-refresh` target re-pulls after the maintainer
  edits the manifest (curation update). Cache location: `~/.cache/murmur/bed/`
  (per-user, outside the repo, survives clones).
- **Future — silent bed rotation:** a later background task can swap the bed over
  a session (fetch a fresh track, crossfade it in) so the backdrop varies over
  time. Out of scope for this build; noted so the seam leaves room (§6).

---

## 3. Design

### 3.1 Bed lifecycle
- **First-run loading**: if the bed cache is empty (and bed is enabled), the
  startup step pulls the manifest into the cache during loading (§2.3) — a one-time
  onboarding wait, before the radio loop.
- **Boot**: after the engine starts and the bed cache is non-empty (and `--no-bed`
  not set), `start_bed` begins the backdrop **before the first talk segment**, so
  the very first words already have music under them.
- **Under talk**: the bed plays at the bed gain (≈0.15–0.20). Voice clips play at
  full over it. The bed does **not** duck per voice clip (§1.5).
- **Featured song** (03-02 music segment): `play_music` crossfades the bed **out**
  (bed gain → 0 over ~`_BED_XFADE_S`) as the song crossfades **in**; the song
  runs (ducking under voice as today); on song end, the song crossfades out and
  the bed crossfades **back in**. Net: continuous music, with the song as a clean
  foreground swell.
- **Seamless loop / rotation**: when the current bed track is within
  `_BED_XFADE_S` of its end, the engine crossfades into the next cached track
  (wrapping the list); a single-track cache crossfades the track into itself. No
  hard cut.
- **Shutdown / `/quit`**: `stop_bed` fades the bed out and stops the source; no
  bed task outlives the engine (mirrors 03-02 teardown).

### 3.2 The crossfade primitive
A gain-ramp crossfade in the sample mixer: over `_BED_XFADE_S` (~1–2 s, tunable),
source A's gain ramps to 0 while source B's ramps to its target, summed
sample-for-sample (we already own the PCM buffers — 03-02's "free upgrade"). Used
for both bed↔song and bed-track loops. Equal-power vs linear ramp is a by-ear
tuning detail (§6); start linear, revisit.

### 3.3 Gains (module constants, by-ear tunable — §6)
- `_BED_GAIN` ≈ 0.15–0.20 — bed under talk.
- Featured-song gains stay as 03-02 defines them (≈1.0 full, ≈0.3 ducked).
- `_BED_XFADE_S` — the crossfade duration for bed↔song and bed loops.

### 3.4 Degradation (never crash, never block)
- **First-run pull fails** (offline / every ref dead) or `--no-bed` / a
  `BedSource` error → **no bed**, logged; the radio runs exactly as pre-03-04
  (talk may be silent between songs). Correctness never depends on the bed being
  present, and a failed pull never blocks startup.
- A bad/failed bed track at runtime → skip to the next cached track; if none play,
  degrade to no bed. A bed fault must **never** interrupt the featured song, the
  voice, or the loop.

---

## 4. Dependencies
- **spec 03-02** — the mixing engine (sample mixer, `MusicHandle`, duck envelope,
  music lifecycle) this extends; **builds** its deferred crossfade upgrade.
- **spec 03-01** — the yt-dlp acquisition reused by the first-run bed pull.
- **spec 03-03** — the startup-check / guided-install seam the first-run pull hangs
  on (03-02 Delivers #7), beside the music-dependency preflight.
- **spec 04** — the no-dead-air principle: the bed pulls at **first-run loading**,
  never on the audio path, so during the broadcast it is always a warm local file
  with no resolve latency.
- **Director / spec 01** — unchanged; the bed is engine-internal.

---

## 5. Acceptance criteria (feature level)
1. **Bed under talk (fakes):** with a non-empty `BedSource`, a pure-talk stretch
   has the bed mixed in at the bed gain under the voice — verified on the fake
   engine (the bed channel is active/non-silent during talk).
2. **Crossfade into the song (fakes):** when a featured song starts, the bed gain
   ramps to 0 and the song ramps in over `_BED_XFADE_S`; when the song ends, the
   bed ramps back. Verified via recorded gain ramps on the fake mixer (no real
   audio).
3. **Seamless loop (fakes):** a bed shorter than the talk stretch crossfades into
   the next cached track (or itself) with overlapping gains — no zero-gain gap at
   the loop boundary.
4. **Local-only at runtime:** the runtime `BedSource` reads only local cached
   files; no network / yt-dlp call happens on the audio path (verified: the fake
   acquisition is never called during a run).
5. **First-run pull (fakes):** on an empty cache the startup step resolves each
   manifest ref into the cache via the (faked) 03-01 acquisition, skips
   already-cached refs, and continues past a failing ref (one bad ref does not
   abort the pull); a warm cache skips the pull entirely.
6. **Degradation:** a failed first-run pull (offline) / `--no-bed` / a `BedSource`
   error → the radio starts talk-only with no bed and no crash (verified on
   fakes); a runtime bed fault never interrupts the featured song or voice.
7. **No bed task outlives the engine** (clean `/quit` / shutdown).
8. **Sensory (by-ear checklist, not asserted):** the bed is present but
   unobtrusive under talk; the bed↔song crossfades feel smooth (no pop / no
   silence gap); the loop is inaudible; the whole thing "sounds like radio"
   (DESIGN §10.3) — a real listening pass, plus tuning `_BED_GAIN` / `_BED_XFADE_S`
   if the ear disagrees with the defaults.

---

## 6. Open questions
- **Empty-cache behavior — decided:** pull during **first-run loading**
  (onboarding-style), not a committed binary and not a permanent no-bed default.
  A failed pull (offline) degrades to no-bed for that session (§3.4). Repo stays
  binary-free (only the manifest is committed).
- **Cache location — decided:** `~/.cache/murmur/bed/` (per-user, outside the
  repo, survives clones).
- **Silent bed rotation (future, not this build):** a background task that swaps
  the bed over a session (fetch a fresh track, crossfade it in) so the backdrop
  varies. The `BedSource` + crossfade seams leave room for it; scope + cadence TBD.
- **Crossfade curve** (equal-power vs linear) and the exact `_BED_XFADE_S` /
  `_BED_GAIN` defaults — by-ear tuning after the mechanism lands.
- **Bed track length / rotation policy** — long ambient pieces looped vs a small
  rotating set; how many refs the manifest should carry for L1.
- **License/attribution** for curated refs — the same acquisition posture as
  featured songs (master §10.1); note any attribution requirements per source.
