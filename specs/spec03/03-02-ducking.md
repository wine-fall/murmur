# spec/03-02 · ducking — a source-agnostic mixing audio engine

> **Status**: **Code-implemented; human (sensory) acceptance pending.** Unit suite green (mixer math, engine behavior on fakes, cadence modes, Director music branch, startup checks); integration tests (real ffmpeg decode, real sounddevice) pass locally; real-seam smoke verified (real yt-dlp stream through the engine with an audible duck + clean teardown; real Haiku pick task returns title/artist/announce). Remaining: the by-ear checklist (§5.1/§5.3 sensory half — smoothness/"sounds like radio") and envelope tuning if the ear disagrees with the defaults.
> **TS port (issue #54 Phase 3, 2026-07-27)**: the engine (§2.1/§2.2), the Director's music branch (§3.5), the announce path (§1 #6), the startup-check seam (§2.4, deterministic preflight only — the interactive guide offer waits for Phase 4.5's `run_guide` harness), and the 03-04 bed are now implemented in TS (`src/audio/engine.ts`, `src/audio/ffmpeg.ts`, `src/setup/startup.ts`, `src/audio/bed.ts`, the `src/director/director.ts` music branch). Phase 2 had already ported §2.3 cadence and the §1 #9 context assembly. The TS engine is **not** the §3.1 numpy callback mixer — see §3.1-TS below for the Web Audio realization and the settled streaming decision. A minimal single-slot music **pick-prefetch** (spec 04 slice 1) ships with the branch so the boundary never blocks on `nextTrack` (~2 min observed cold); spec 04's talk look-ahead is NOT ported yet.
> **Part**: Replace the spec-01 afplay-based `AudioPlayer` with a **mixing audio engine** that plays music and voice **simultaneously** and **ducks** the music under the voice. See master [`../DESIGN.md`](../DESIGN.md) §4 (AudioPlayer = sole audio authority, duck/stop), §3.5 (voice is the soul), §10 (build order).
> **Milestone**: L1 (radio feel) — the second half, after [`03-01-brain-harness.md`](03-01-brain-harness.md). 03-01 makes the radio **find and play real songs** (sequentially); this spec makes talk play **over ducked music** and makes a typed interjection **duck** the song instead of hard-stopping it — the last piece of the radio feel.
> **Conventions**: English; written for a coding agent. Design-level. No CJK in source (master §0).

---

## 1. Goal & scope

### Delivers
1. **A mixing audio engine** that replaces the single-clip afplay `AudioPlayer`: it plays a **long music source** and short **voice clips** at the same time, mixing to **one** output stream. Still the **sole audio authority** (master §4) — nothing else emits sound — but now with two logical channels (music + voice).
2. **Ducking (MVP = gain envelope).** When a voice clip plays over music, the music channel's gain ramps down (≈1.0 → ≈0.3 over ~300 ms), holds, and ramps back when the voice ends. This is the DJ-over-music radio feel.
3. **Interjection = duck, not stop.** A typed interjection during a song **ducks** the music and plays the reply **over** it (replaces the spec-01 hard-stop for music segments); the song resumes at full gain afterward.
4. **A source-agnostic seam** — ducking is a property of an abstract **music-playback handle**, with two prospective mechanisms behind one `duck()` interface (master "raw-audio vs black-box player" analysis): the **PCM/own-mixer** path (this MVP) and a future **external-player volume-control** path (seam only). So "ducking applies regardless of source" holds at the architecture level.
5. **Music playback + Director talk↔music scheduling behind a switchable `CadencePolicy` seam** (moved here from 03-01): the Director consults a `CadencePolicy` at each segment boundary to decide talk vs music. Three modes, switchable by config/CLI flag: **`every_n`** (default — a song after every N talk segments, deterministic, 0 tokens), **`random`** (probability p with min/max-interval guardrails; seeded RNG injectable for tests), **`brain`** (opt-in — a one-shot cheap-model call decides by feel; any failure/timeout hard-falls-back to the local policy; this mode is the explicit, user-chosen exception to master §7 pillar 1). Music actually reaching the speakers begins here.
6. **The DJ's way into a track (in scope, decided).** A spoken intro over the ducked head of each track. The announce copy is written by the **same pick task** that chose the track (the 03-01 `submit_pick` terminal tool gains `title`/`artist`/`announce` fields — no extra LLM call, in-persona at runtime, no hardcoded copy in source per master §0). Flow: start music → **the Director ducks the head immediately** → synthesize announce → `play(announce)` rides the already-ducked head → its scheduled unduck lifts the song **slowly** back to full. A missing announce (or one whose synthesis failed) skips the intro, and the Director then lifts the head itself — nothing else would.
   Three things make this a hand-over rather than a label (amended 2026-09-03, by-ear):
   - **Length.** The contract asks for **two to four sentences, ~10-20 s spoken** (§6.1), not one line. A single line has no room to arrive anywhere.
   - **Continuity.** The pick situation carries the beat that was on air when the pick was fired, **labeled as that line** (`The line on air as this song was chosen: "…"`), and the contract asks the announce to pick up the thread it leaves — or, when it leaves none, to simply bring the song in. The label says *chosen*, not *just before*, because a prefetched pick is fired one or more talk beats ahead of the boundary that airs it (spec 04 §3.1) and the situation is fixed at fire time; a label that overclaimed would have the announce hand over from a line the listener heard two beats ago. Talking *about* the track is optional and incidental: a sentence or two where it comes naturally, never a title/artist/year rundown and never an "up next" formula. No template sentence is imposed; the persona writes all of it.
   - **One text, not two.** The `submit_pick` schema's `announce` parameter description is a runtime instruction of its own, read by the model at exactly the moment it fills the field. It is the same exported string as the contract's (`ANNOUNCE_FIELD_DESCRIPTION` in `src/prompts/`), so the two can never drift into asking for different announces.
   - **Envelope.** The head is **born ducked** (the Director ducks the handle the moment `playMusic` returns, before any audio), so a song never comes up at full volume only to be shoved down under the first word; and the return is **asymmetric** — down on `RAMP_S`, up on the much longer `UNDUCK_RAMP_S` (§3.2, §6.1). Born-ducked is a **step, not a ramp**: a gain move made before the stream's first frame is scheduled has not been heard by anyone, so `MixedHandle` sets the value outright — ramping it would let a fast source (a local file, a warm cache) put out 0.3 s of full-volume audio first. A voice clip that fails to load lifts the music on its way out (`play()` occupies no time, so it owes the unduck it would have scheduled), or the head would stay ducked for the whole song.
   *Side effect, intended:* a typed reply over a song goes out through the same `play()` path, so the song settles back under a reply on the same slow lift.
7. **Startup checks phase (extensible seam).** At app start, run registered environment checks through a decoupled `StartupCheck`-style seam — built for onboarding to hang future checks on. First (and only, here) check: the music-dependency preflight (yt-dlp + ffmpeg, per 03-03) + guide offer, reusing 03-03's `run_music_setup` verbatim (broken → tell the user plainly, offer the guide, y/N). A failed/declined music check degrades the session to talk-only (the radio still starts); `--no-music` skips the check and music scheduling entirely. This is where 03-03's "automatic trigger" lands.
8. **Integration:** the `AudioClip`s pulled by [`03-01`](03-01-brain-harness.md)'s `MusicProgrammer.next_track` flow through this engine (widened to `TrackPick(clip, announce)` — see 03-01 §2.4).
9. **Assemble the music context (first real `situation`).** When the Director schedules a music segment it builds the `MusicContext` (spec 03-01 §2.4) — persona + a `situation` string — and calls `next_track`. This is the first place `situation` is populated with real content (03-01 declared the field + insertion mechanism but wrote nothing to it). MVP fills it with the **L1-available** signals (session `recent` turns + the Director's intent); richer content (recent-window / anti-repeat ledger from spec 05, time-of-day / pacing from spec 07) enriches it as those land. What makes a *good* context is an open question (§6).

### Out of scope (explicit non-goals)
- **Crossfade** and **true sidechain-compression** ducking — MVP is a fixed gain envelope. Because we own the sample-level mixer, both are later **free upgrades** (the voice is already a PCM buffer we hold); not built here.
- **The external-player (black-box) duck mechanism** (Spotify app / Apple Music via AppleScript volume) — the **seam** is defined so it can slot in, but **no implementation** here. MVP implements only the PCM/own-mixer path.
- **No-dead-air look-ahead / pre-generation buffer** → spec 04. This engine plays what it is handed; it does not pre-resolve the next segment.
- **skip command** — deferred (not in L1).
- **Music search / acquisition (find + pull)** → [`03-01`](03-01-brain-harness.md). (Scheduling + playback + announce are now owned *here* — see Delivers #5.)

---

## 2. Contracts / seams

### 2.1 The engine (extends the spec-01 `Player` seam)
Spec 01 defined `Player` (`play(clip)` / `stop()`) as the audio seam the Director consumes. This spec provides a richer implementation behind a compatible surface; the Director keeps depending on the capability, not the concrete class.

```python
class AudioEngine(Player):
    async def play_music(self, clip: AudioClip) -> "MusicHandle": ...
    """Start a long music source (AudioClip(kind='music'); source = stream URL
    or local file) and return a handle. Playback is non-blocking — the music
    keeps running while the Director does other things — but the handle exposes
    an awaitable completion (see §3.5) so the Director can sequence 'song ends
    -> next segment', plus `duck()/unduck()/stop()` to control it."""

    async def play(self, clip: AudioClip) -> None: ...
    """Play a voice clip (kind='talk'). If music is currently playing, the
    engine AUTO-DUCKS it for the duration of this clip and unducks after —
    implemented by calling the live `MusicHandle`'s `duck()`/`unduck()` (the
    same primitive a future `ControlledHandle` implements), so there is ONE
    ducking path, not two. Awaits until the clip finishes or is cancelled
    (spec 01 semantics)."""

    async def stop(self) -> None: ...
    """Cancel current VOICE playback only (the spec-01 interjection signal) —
    a reply-over-music interrupted by the next typed line must never kill the
    song. Music stops via its handle (`MusicHandle.stop()`; the Director does
    this on /quit) or `aclose()`. Cancellation paths (stop() vs cancelling
    play()) mirror spec 01's AudioPlayer."""

    async def aclose(self) -> None: ...
    """Shutdown: stop voice + music (no orphaned decoder) and release the
    output stream. The app's finally path."""
```
`play(voice)` auto-ducking any active music is what makes "talk over music" and "interjection ducks the song" fall out of one rule — the Director does not orchestrate gain by hand.

### 2.2 The duck seam — one intent, two mechanisms
```python
class MusicHandle(Protocol):
    async def duck(self) -> None: ...     # ramp music DOWN to the duck target
    async def unduck(self) -> None: ...   # ramp music back UP to full
    async def stop(self) -> None: ...
    async def wait(self) -> None: ...     # awaitable completion (natural end or stop)

# MVP implementation — sample-level mixing (raw-audio / "A-class" sources)
class MixedHandle(MusicHandle): ...       # duck() ramps a gain we apply in the mixer

# Future (seam only, NOT implemented here) — black-box players
class ControlledHandle(MusicHandle): ...  # duck() issues a volume command to an
                                          # external player (e.g. Spotify app)
```
The engine dispatches a universal duck intent to whichever handle backs the current music. MVP constructs only `MixedHandle`; the `ControlledHandle` seam documents how a non-mixable source (master §5 optional providers) would duck later.

### 2.3 `CadencePolicy` — the talk↔music scheduling seam (switchable modes)
```python
@dataclass(frozen=True)
class CadenceState:
    talks_since_music: int     # local signals only; extend as later specs add sources

class CadencePolicy(Protocol):
    async def next_kind(self, state: CadenceState) -> str: ...   # "talk" | "music"

class EveryNCadence(CadencePolicy): ...    # default: music after every N talks (0 tokens)
class RandomCadence(CadencePolicy): ...    # p per boundary + min/max-interval guardrails; injectable RNG
class BrainCadence(CadencePolicy): ...     # opt-in: one-shot cheap-model judgment; hard fallback to local on any failure
```
The Director consults the seam at each segment boundary and never knows which mode is behind it. Mode + knobs (N, p, bounds) are config; a CLI flag selects the mode.

### 2.4 Startup checks — the extensible preflight seam
```python
class StartupCheck(Protocol):
    name: str                                   # e.g. "music"
    async def run(self, host: Host) -> bool: ...  # interactive allowed; False = feature unavailable
```
App start runs the registered checks in order before broadcasting. The only check shipped here wraps 03-03's `run_music_setup` (deterministic preflight → offer the guide → recheck); its result gates music scheduling for the session (False → talk-only). The seam exists so future onboarding checks (other providers, models, credentials) slot in without touching the app loop; `--no-music` skips the music check entirely.

---

## 3. Design

### 3.1 Signal path (MVP, PCM own-mixer)
- **One output stream** via `sounddevice` (PortAudio): float32, fixed rate (proposal 48 kHz), stereo.
- **A mixing callback** pulls one block from each of two ring buffers and outputs `music_block * music_gain + voice_block * voice_gain`, with clipping/limiting.
  - **Music buffer** is fed by an **ffmpeg decoder thread**: `ffmpeg -i <AudioClip.source> -f f32le -ar 48000 -ac 2 -` (source = stream URL from yt-dlp, or a local file) → PCM chunks → ring buffer. ffmpeg owns network + decode + resample; the engine owns only mixing.
  - **Voice buffer** is fed by reading the spec-02 TTS clip (a local wav); short, so it can be loaded/queued quickly (resampled to the mix format if needed).
- **`music_gain`** is driven by an envelope with target 1.0 normally and the **duck target** (~0.3) while a voice clip is active, smoothed as a per-block ramp (~300 ms) so transitions are not abrupt.
- **Sole authority + cancellation** (master §4, spec 01 §3.5): the engine is the only sound source; `stop()` terminates the music ffmpeg and drains buffers; cancelling `play()` (shutdown/Ctrl-C) tears down cleanly with no orphaned ffmpeg/stream (mirrors spec 01's two cancellation paths).

### 3.1-TS Signal path (TypeScript engine, issue #54 Phase 3)

The TS engine realizes the same contracts as Web Audio **graph orchestration**
on `node-web-audio-api` (the Phase 0 binding decision) instead of an owned
sample loop: per-source `AudioBufferSourceNode`s + per-channel `GainNode`s, with
every gain move (duck, unduck, bed crossfade) expressed as `AudioParam`
automation. Notes, all settled during the Phase 3 build:

- **Streaming strategy — decided: chunk-scheduled buffer segments,** not an
  `AudioWorklet`. The ffmpeg decode stream (`ffmpeg -i <src> -f f32le -ar 48000
  -ac 2 -`) is reframed into ~1 s `AudioBuffer` segments scheduled back-to-back
  at sample-accurate context times, keeping only a bounded scheduling lead
  (~8 s) ahead of playback — an hour-long source holds ~8 s of PCM in memory,
  never a ~1.4 GB whole-file buffer. Measured offline: chunk-scheduled output
  differs from a single-buffer render by ~1e-11 max sample error (gapless).
  An `AudioWorklet` fed from a ring buffer would add a worklet module + thread
  hop + hand-rolled buffering for no additional capability at this scale; it
  remains the fallback if chunk scheduling ever proves insufficient.
- **Underrun**: a chunk arriving behind playback is re-anchored slightly ahead
  of `currentTime` — a silent gap, not a crash (same §3.3 posture).
- **Deterministic automation**: gain intents are anchored to context time the
  moment their trigger is known — `play(voice)` schedules the unduck at the
  clip's known end; the bed's post-song return is anchored at the song's
  end-of-stream time as soon as the decode finishes scheduling. This makes an
  `OfflineAudioContext` render of the same engine calls the unit-test layer
  (RMS-window assertions on duck/crossfade), with no device and no realtime
  races.
- **Decoder failure is loud**: an abnormal ffmpeg exit raises out of the decode
  stream (surfaced via the engine log + `waitStarted(false)`), never
  masquerading as a clean end — the "announced but silent" 403 lesson.

### 3.2 Ducking behavior
- **Talk over music:** Director calls `play(voice)` while a `MusicHandle` is live → engine ducks, plays the voice, unducks. The transition uses the ramp, not a hard step.
- **The two ramps are not the same length** (amended 2026-09-03). Getting out of the voice's way has to happen at once (`RAMP_S`); coming back does not, and at the same speed the ear reads it as a switch flipping rather than a room settling. So `unduck()` runs on `UNDUCK_RAMP_S` (§6.1), several times longer. Both are still one `AudioParam` ramp anchored at a known time — the unduck is still scheduled at the voice clip's known end, so the slow return is deterministic and rendered identically offline.
- **Interjection during a song:** **duck → reply over music → unduck**, not hard-stop — the song keeps playing under the reply and returns to full gain when the reply ends. This requires a fork in the Director's arbitration (spec-01 stop()-based cancel does not apply to music) — see §3.5.
- **Talk-only segment (no music):** identical to spec 01 — the voice channel plays alone (music_gain irrelevant).

### 3.3 Robustness notes
- **Underrun:** if the music buffer starves (network stall), the callback outputs silence (or holds) for that block rather than blocking the audio thread — a minor glitch, not a crash. Buffer sizing trades latency vs resilience (Open Questions).
- **Format normalization:** the voice wav (spec 02) is resampled/converted to the mix rate/format on load.

### 3.4 Integration with 03-01 and the Director
- Music `AudioClip`s produced by 03-01's `MusicProgrammer` are played via `play_music`; the Director stops issuing music through the old sequential `play`.
- The Director's talk segments call `play(voice)`; auto-ducking makes them ride over any live music.
- The engine is **source-agnostic**: the same PCM path plays a yt-dlp stream URL and a local fixture file, so it is testable without the network.

### 3.5 Director control-flow: music segments duck, talk segments cut
This engine forks the Director's interjection handling (spec 01 §3.3). The base
mechanism is the same for both: a typed line composes its reply while the current
audio keeps playing and barges in only when the reply clip is ready (prepare-
then-barge-in). What differs is the **barge-in target**:
- **Talk (voice clip):** the ready reply cuts the on-air voice clip (`stop()` — the voice channel) and becomes the new voice clip.
- **Music (song):** the Director must **not** `stop()` the song. It races the song's **completion** against the next typed line; a reply is played via `play(reply)` — which auto-ducks the *still-playing* music — then it keeps awaiting completion (chained interjections all ride over the ducked song). The song is truly stopped only on `/quit`/shutdown or when it ends naturally.
Both live behind **one** arbitration path in the Director (spec 01 §3.3): the song
is a persistent background activity, voice clips are the replaceable foreground.
This is the concrete integration change 03-02 lands in the spec-01 loop.

---

## 4. Dependencies
- **spec 01**: the `Player` seam, `AudioClip`, and the sole-audio-authority invariant this engine preserves. **Modifies** the `Director`'s interjection arbitration to fork music (duck-over) from talk (barge-in cut) — see §3.5.
- **spec 03-01**: produces the music `AudioClip`s that flow through this engine (integration). The **engine core is testable independently** with local fixtures.
- **spec 02**: supplies the voice clips mixed on top.
- **External**: `sounddevice` (PortAudio), `numpy`, and **ffmpeg** (system binary) for decode. Per master §10.1, this backend declares its full dependency manifest so provisioning is atomic (no half-installed state). Config: `ffmpeg_cmd` replaces the retired spec-01 `player_cmd`/`--player` (the engine has no external player binary); new knobs `music_enabled`/`ytdlp_cmd`/`music_model`/`cadence_mode`/`music_every_n`, flags `--no-music`/`--cadence`.

---

## 5. Acceptance criteria (feature level)
1. **Audible ducking (sensory).** Playing a local music fixture and speaking a TTS clip over it, the music **audibly dips** under the voice and **returns** afterward — smooth, not abrupt. (Human acceptance; the agent produces a checklist.)
2. **Deterministic mixing (unit).** Given synthetic music + voice PCM blocks and an envelope, the mixed output equals the expected samples, and the duck target is reached within the ramp time. No audio hardware needed for this layer.
3. **Interjection ducks, not stops.** Typing during a song ducks the music, the reply is heard over it, and the song returns to full gain and continues; the program then resumes. (Contrast spec 01 / 03-01 interim hard-stop.)
4. **Sole authority preserved.** On `stop()`/shutdown/Ctrl-C, no orphaned ffmpeg process or open stream remains; only the engine ever emits sound.
5. **Source-agnostic.** The same engine plays a **local file** (unit/fixture) and a **yt-dlp stream URL** (integration, tagged).
6. **Duck seam is real.** It is verifiable that `duck()` dispatches over an abstract `MusicHandle` such that a second mechanism (`ControlledHandle`) could slot in without touching the mixer.
7. **Cadence is switchable (unit).** The Director schedules music through the `CadencePolicy` seam; each mode is unit-tested in isolation (`every_n` deterministic sequence; `random` respects guardrails under a seeded RNG; `brain` returns the model's choice and hard-falls-back to local policy on failure/timeout), and switching modes touches only config.
8. **Announce rides the duck (unit + sensory).** When a pick carries an announce line, the track's head is ducked before it is audible, and the line is synthesized and played over it via the same auto-duck path as any voice clip; the song then returns to full on the slow ramp (`UNDUCK_RAMP_S`), verifiable on an offline render. A pick with no announce — or one whose synthesis failed — plays the track directly, with the head lifted explicitly rather than left ducked. The line's *length and hand-over quality* are by-ear (§6.1), not a unit assertion on model text.
9. **Startup checks gate music (unit).** The app runs the registered startup checks before broadcasting; a failing/declined music check yields a talk-only session (radio still starts); `--no-music` skips the check; a second registered fake check runs without any app-loop change (the seam is real).

### Testing (master §11)
- **Unit (fast):** mixing math + gain-envelope ramp on synthetic PCM; handle dispatch (`MixedHandle` vs a fake `ControlledHandle`); cancellation/teardown with a stand-in decoder (no real ffmpeg/audio).
- **Integration (tagged):** real `sounddevice` output + real `ffmpeg` decode of a local file and a stream URL. `pytest -m integration`. Not in the fast loop.
- **Human acceptance (sensory):** ducking "sounds like radio," talk-over-music warmth, interjection feel — the user judges by ear (master §11.2 layer 3).

---

## 6. Open questions

### 6.1 By-ear constants
The knobs that only the ear can set. Each is a module constant with one home, so
an audition changes one number in one place.

| Constant | Home | Value | What it sets |
|---|---|---|---|
| `DUCK_TARGET` | `src/audio/engine.ts` | 0.3 | How far the music drops under a voice. |
| `RAMP_S` | `src/audio/engine.ts` | 0.3 s | How fast it gets out of the way. |
| `UNDUCK_RAMP_S` | `src/audio/engine.ts` | 2.5 s | How slowly it comes back after the voice ends. |
| announce length | `FIND_MUSIC_CONTRACT`, `src/prompts/` | 2-4 sentences, ~10-20 s | How much room the way into a track has. |
| `CODA_RIDE_P` | `src/director/director.ts` | 0.5 | How often the way OUT of a track rides its outro (spec 04 §3.3-C). |
| `CODA_LEAD_MIN_S` / `CODA_LEAD_MAX_S` | `src/director/director.ts` | 8 s / 12 s | How long before the end that ride starts. |

- **Format/buffers:** starting values 48 kHz / stereo / float32, block + ring depth tuned during implementation (latency vs underrun resilience).
- **Envelope shape/timing:** starting values ~300 ms linear ramp, duck target 0.3 — final numbers tuned by ear at human acceptance.
- **What makes a *reasonable* music context** (the content of `MusicContext.situation`, inherited from 03-01 §6): which signals actually improve picks, how to phrase them, and how much to include (token cost). MVP: session `recent` turns + the Director's intent; revisit as spec 05 (ledger/recent-window) and spec 07 (time-of-day/pacing) add sources.
- **Settled (recorded so they are not re-asked):** cadence is a switchable `CadencePolicy` seam — `every_n` default / `random` / `brain` opt-in (§2.3); the "up next" announce is in scope, written by the pick task itself (no extra LLM call, no hardcoded copy — §1 #6); music is **on by default**, gated by the extensible startup-checks phase, `--no-music` to skip (§2.4); underrun outputs silence for the starved block; the inter-segment gap stays with the **Director** (the engine only mixes/plays); the "03-01 interim `ffplay` player" question is **moot** — 03-01 shipped find+pull with no playback at all.
