# spec/03-02 · ducking — a source-agnostic mixing audio engine

> **Status**: Not started. Design-level (mechanism + contracts, not final code).
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
5. **Music playback + Director talk↔music scheduling + optional DJ "up next" announce** (moved here from 03-01): the local-policy cadence that decides when a music segment plays, the wiring that plays the tracks 03-01 pulls, and an optional short spoken intro over the track's start. Music actually reaching the speakers begins here.
6. **Integration:** the `AudioClip`s pulled by [`03-01`](03-01-brain-harness.md)'s `MusicProgrammer.next_track` flow through this engine.

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
    """Stop whatever the Director's cancel path targets (spec 01 interjection /
    shutdown). For music: stopping the current music handle. Cancellation
    paths (stop() vs cancelling play()) mirror spec 01's AudioPlayer."""
```
`play(voice)` auto-ducking any active music is what makes "talk over music" and "interjection ducks the song" fall out of one rule — the Director does not orchestrate gain by hand.

### 2.2 The duck seam — one intent, two mechanisms
```python
class MusicHandle(Protocol):
    async def duck(self) -> None: ...     # ramp music DOWN to the duck target
    async def unduck(self) -> None: ...   # ramp music back UP to full
    async def stop(self) -> None: ...

# MVP implementation — sample-level mixing (raw-audio / "A-class" sources)
class MixedHandle(MusicHandle): ...       # duck() ramps a gain we apply in the mixer

# Future (seam only, NOT implemented here) — black-box players
class ControlledHandle(MusicHandle): ...  # duck() issues a volume command to an
                                          # external player (e.g. Spotify app)
```
The engine dispatches a universal duck intent to whichever handle backs the current music. MVP constructs only `MixedHandle`; the `ControlledHandle` seam documents how a non-mixable source (master §5 optional providers) would duck later.

---

## 3. Design

### 3.1 Signal path (MVP, PCM own-mixer)
- **One output stream** via `sounddevice` (PortAudio): float32, fixed rate (proposal 48 kHz), stereo.
- **A mixing callback** pulls one block from each of two ring buffers and outputs `music_block * music_gain + voice_block * voice_gain`, with clipping/limiting.
  - **Music buffer** is fed by an **ffmpeg decoder thread**: `ffmpeg -i <AudioClip.source> -f f32le -ar 48000 -ac 2 -` (source = stream URL from yt-dlp, or a local file) → PCM chunks → ring buffer. ffmpeg owns network + decode + resample; the engine owns only mixing.
  - **Voice buffer** is fed by reading the spec-02 TTS clip (a local wav); short, so it can be loaded/queued quickly (resampled to the mix format if needed).
- **`music_gain`** is driven by an envelope with target 1.0 normally and the **duck target** (~0.3) while a voice clip is active, smoothed as a per-block ramp (~300 ms) so transitions are not abrupt.
- **Sole authority + cancellation** (master §4, spec 01 §3.5): the engine is the only sound source; `stop()` terminates the music ffmpeg and drains buffers; cancelling `play()` (shutdown/Ctrl-C) tears down cleanly with no orphaned ffmpeg/stream (mirrors spec 01's two cancellation paths).

### 3.2 Ducking behavior
- **Talk over music:** Director calls `play(voice)` while a `MusicHandle` is live → engine ducks, plays the voice, unducks. The transition uses the ramp, not a hard step.
- **Interjection during a song:** **duck → reply over music → unduck**, not hard-stop — the song keeps playing under the reply and returns to full gain when the reply ends. This requires a fork in the Director's arbitration (spec-01 stop()-based cancel does not apply to music) — see §3.5.
- **Talk-only segment (no music):** identical to spec 01 — the voice channel plays alone (music_gain irrelevant).

### 3.3 Robustness notes
- **Underrun:** if the music buffer starves (network stall), the callback outputs silence (or holds) for that block rather than blocking the audio thread — a minor glitch, not a crash. Buffer sizing trades latency vs resilience (Open Questions).
- **Format normalization:** the voice wav (spec 02) is resampled/converted to the mix rate/format on load.

### 3.4 Integration with 03-01 and the Director
- Music `AudioClip`s produced by 03-01's `MusicProgrammer` are played via `play_music`; the Director stops issuing music through the old sequential `play`.
- The Director's talk segments call `play(voice)`; auto-ducking makes them ride over any live music.
- The engine is **source-agnostic**: the same PCM path plays a yt-dlp stream URL and a local fixture file, so it is testable without the network.

### 3.5 Director control-flow change: music segments differ from talk (a required edit to the spec-01 loop)
This engine forces a fork in the Director's arbitration (spec 01 §3.3), which today, on any typed line, calls `player.stop()` to cancel the on-air clip:
- **Talk segment (unchanged):** a typed line still cancels the talk clip (`stop()`) and the brain replies — spec-01 cancel-and-resume.
- **Music segment (new):** the Director must **not** `stop()` the song. It races the handle's **completion** against the next typed line; on a line it plays the reply via `play(reply)` — which auto-ducks the *still-playing* music — then keeps awaiting completion (chained interjections all ride over the ducked song). The song is truly stopped only on `/quit`/shutdown or when it ends naturally.
So `_play_interruptible`/`_handle_user` grow a **music branch** ("await song-done vs next-line, reply-over-music on a line") distinct from the talk branch ("cancel-and-resume"). This is the concrete integration change 03-02 lands in the spec-01 loop.

---

## 4. Dependencies
- **spec 01**: the `Player` seam, `AudioClip`, and the sole-audio-authority invariant this engine preserves. **Modifies** the `Director`'s interjection/cancel arbitration to fork music (duck-over) from talk (cancel-and-resume) — see §3.5.
- **spec 03-01**: produces the music `AudioClip`s that flow through this engine (integration). The **engine core is testable independently** with local fixtures.
- **spec 02**: supplies the voice clips mixed on top.
- **External**: `sounddevice` (PortAudio), `numpy`, and **ffmpeg** (system binary) for decode. Per master §10.1, this backend declares its full dependency manifest so provisioning is atomic (no half-installed state).

---

## 5. Acceptance criteria (feature level)
1. **Audible ducking (sensory).** Playing a local music fixture and speaking a TTS clip over it, the music **audibly dips** under the voice and **returns** afterward — smooth, not abrupt. (Human acceptance; the agent produces a checklist.)
2. **Deterministic mixing (unit).** Given synthetic music + voice PCM blocks and an envelope, the mixed output equals the expected samples, and the duck target is reached within the ramp time. No audio hardware needed for this layer.
3. **Interjection ducks, not stops.** Typing during a song ducks the music, the reply is heard over it, and the song returns to full gain and continues; the program then resumes. (Contrast spec 01 / 03-01 interim hard-stop.)
4. **Sole authority preserved.** On `stop()`/shutdown/Ctrl-C, no orphaned ffmpeg process or open stream remains; only the engine ever emits sound.
5. **Source-agnostic.** The same engine plays a **local file** (unit/fixture) and a **yt-dlp stream URL** (integration, tagged).
6. **Duck seam is real.** It is verifiable that `duck()` dispatches over an abstract `MusicHandle` such that a second mechanism (`ControlledHandle`) could slot in without touching the mixer.

### Testing (master §11)
- **Unit (fast):** mixing math + gain-envelope ramp on synthetic PCM; handle dispatch (`MixedHandle` vs a fake `ControlledHandle`); cancellation/teardown with a stand-in decoder (no real ffmpeg/audio).
- **Integration (tagged):** real `sounddevice` output + real `ffmpeg` decode of a local file and a stream URL. `pytest -m integration`. Not in the fast loop.
- **Human acceptance (sensory):** ducking "sounds like radio," talk-over-music warmth, interjection feel — the user judges by ear (master §11.2 layer 3).

---

## 6. Open questions
- **Format/buffers:** samplerate (48 kHz?), block size, and ring-buffer depth — latency vs underrun resilience. Tune during implementation.
- **Envelope shape/timing:** ~300 ms, linear vs exponential ramp, and the exact duck target (0.3?) — tuned by ear.
- **Underrun policy:** output silence vs hold-last-block on a network stall.
- **Inter-segment gap ownership:** does the engine own the paced gap or does the Director keep it (spec 01)? Proposal: Director keeps it; the engine only mixes/plays.
- **Player binary for 03-01 interim:** 03-01 plays stream URLs via `ffplay`/`mpv` before this engine exists; confirm the handoff so config stays coherent when this engine takes over music playback.
