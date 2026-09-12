# No dead air: the latency budget of an always-on voice agent

murmur is a radio program with a language model for a host. It talks on its own, plays a song, comes back and keeps talking. Every line goes through Claude and then through a text-to-speech endpoint before anyone hears it. Each hop takes seconds. A radio program cannot take seconds between segments.

This post is about how the air stays continuous anyway: the look-ahead, the mixer, the numbers from real runs, and what still fails.

## The cost being hidden

A talk beat is a paragraph of speech. The first batch of a session is the worst case. On two measured runs with the real brain and the hosted voice, one model call for two beats plus their synthesis took 24.5 s cold and 33.9 s hot (spec 04 §3.3, PR #75). A smoke in PR #64 saw the same batch at 23.68 s. A session in `.dev/dev.log` on 2026-08-31 shows the first spoken line 24 s after startup checks began.

Steady-state refills are cheaper. In that log, the model call for a one-beat refill took 9 to 14 s from the request line to the arrival line, across 28 refills. Synthesis starts when that line is logged and its completion is not logged on its own. A beat plays for longer than the call: consecutive spoken lines are 24 to 40 s apart, gap included, across 22 pairs.

Music is the expensive one. Finding a song is an agentic task: search, judge, resolve a stream, probe it. Under controlled conditions that took 40.2 s cold and 54.7 s hot (spec 04 §3.3, PR #91). In the 2026-08-31 session, five picks took 93.7, 89.1, 192.1, 81.7 and 111.7 s (issue #164).

So a beat costs about 10 s of model time plus its synthesis to make, and about 30 s to play. A song costs one to three minutes to find and three to seven to play. Nothing can be made on the critical path. Everything has to be made while something else is on air.

## What it sounded like before

One timeline survives from before any of this existed. `scratch/coldstart_timeline.log`, a local scratch file outside the repo, is dated 2026-07-13, the day before the first prefetch PR (#25) merged. First line at 20.2 s, second at 55.9 s, first song at 122.8 s. The two lines start 35.7 s apart. The file does not record when the first line finished, so the silence inside that interval is unmeasured. Its source is known: the Director of that day generated the next beat only after the previous one had finished (spec 01 §3.4, since superseded).

## The look-ahead

The fix is two buffers inside the Director, the loop that decides what airs next (spec 04; PRs #25, #26, #30, #64).

The talk buffer holds two beats ahead. Each entry is the beat text plus its synthesis as an already-running promise. When a talk segment is due, the Director pops the front beat and awaits a promise that has usually settled.

The buffer is topped up after every consumed beat, so it stays at depth two through a song. A refill is one model call that returns the missing beats through a terminal tool call, so the batch arrives as a parsed argument with no free text to scrape. Each beat starts its own synthesis at once. Retries are bounded; a failed batch loses the look-ahead for that round and never the segment.

The refill's context includes the queued, unaired beats as prior turns. The model is stateless, and it has to be told what is already in the pipe or it will say it again.

A typed line from the listener discards the buffer, because those beats predate the listener's turn. Promises cannot be cancelled, so the discard bumps an epoch counter and a late refill drops its own result.

The music buffer is one slot. The first pick fires at the top of the run, before the cold talk batch, because discovery is independent of talk and used to sit serialized behind it (PR #91). After that, each aired beat tops the slot up. When music is due and the slot holds a resolved pick, the song airs. When the pick is still resolving, the Director airs a buffered beat instead and tries again at the next boundary. Talk covers the search for as long as it takes.

That rule came from a real run: a long-playlist resolve blocked the music branch for 56 s while a warm beat sat in the buffer, and the listener heard silence (spec 04 §3.1).

## The boundary numbers

PR #75 measured whether this works, on two full runs: real brain, real `yt-dlp`, the hosted voice, audio out of the speakers. An isolated `MURMUR_HOME`, persona pre-seeded, bed cache warm, `MURMUR_ACTIVITY=present` so the away-gate could not thin the cadence. Cold is an empty memory; hot is a second run nine minutes later, carrying the first run's turns.

| | cold | hot |
|---|---|---|
| start to banner | 4.2 s | 4.7 s |
| first batch (model + TTS) | 24.5 s | 33.9 s |
| start to first audible word | 28.7 s | 38.6 s |
| start to first music | 136 s | 195 s |

Across both runs, 13 boundaries had a buffered beat due. All 13 aired in the same second as their `talk.buffer warm` log marker, read against the clip's on-air time. Zero residual model or synthesis wait, the two music-to-talk boundaries included. The only dead air left at a boundary is the configured gap, 2 s by default (`gapSeconds` in `src/config.ts`). The 2026-08-31 log agrees: the spoken line, logged once its clip is ready to play, follows `music.end` by 2 s, four times out of four, and across 26 buffered boundaries it lands in the same second as the warm marker.

First music was the bad number. The cadence held it to the third boundary, then a pick still resolving held it longer: two boundaries cold and three hot yielded to talk. PR #91 worked the discovery side: per-stage timing lines, a `--flat-playlist` search, the startup prime, and a situation string bounded to six recent turns. Searches went from 10 to 17 s each down to 2.3 to 2.6 s. Re-measured under the same conditions:

| | cold | hot |
|---|---|---|
| pick fired | t0+3 s | t0+4 s |
| discovery | 40.2 s | 54.7 s |
| start to first music | 71 s | 78 s |

Both songs landed at the third boundary, the cadence minimum with `musicEveryN=2`, with the pick ready about 30 s before the boundary that aired it. The cadence now sets first music.

## Under the voice

The look-ahead removes the producer wait. Making a talk-only stretch sound like a radio is the mixer's job (spec 03-02, spec 03-04, PR #37).

The engine is a Web Audio graph on `node-web-audio-api`: a background bed, the featured song, and the voice, mixed to one output. Every gain move is `AudioParam` automation scheduled the moment its trigger is known.

The bed is a curated set of instrumentals cached on first run and played from disk only, so no resolve latency touches the audio path. It plays at 0.5 gain under all talk (`BED_GAIN`, `src/audio/engine.ts`) and never ducks per voice clip; a low bed that pumps on every sentence reads as a machine. It crossfades out over 1.5 s when a song starts and back when it ends.

The featured song ducks under voice. When `play(voice)` runs with a song live, the song's gain ramps to 0.3 over 0.3 s (`DUCK_TARGET`, `RAMP_S`). The unduck is scheduled at the clip's known end before the clip has played, and it takes 2.5 s (`UNDUCK_RAMP_S`). At the fast speed the ear hears a switch; at the slow speed, a room settling.

The head of a track is born ducked: the gain is stepped to the duck target before the first frame is scheduled, and the announce rides over it. A ramp there would let a fast source put out 0.3 s at full volume first.

One source of dead air sits inside the voice. The hosted fish-speech endpoint runs sentences together, and its documented `[pause]` tag was inert on the tier in use: a silence measurement found zero added gaps (PR #32, spec 02 §3.6). So the voice layer splits a beat at sentence enders, synthesizes each, and joins them with a 0.8 s silence pad (`src/voice/hosted-voice.ts`). This is the one place silence is added on purpose.

## What still fails by ear

The look-ahead has a consequence only listening exposed. The buffer is full before a song starts, so the beat that airs after a song was written before the song existed and could not mention it. The talk came in on a topic from minutes ago. The fix is a separate one-beat slot, the coda, generated at the song's start with the song in context and aired over the last 8 to 12 s of the track on a coin flip, or else at the boundary (spec 04 §3.3-C). Whether it lands is an open by-ear pass (issue #198).

Discovery is unstable. The 2026-08-31 session saw three dead stream probes in half an hour, each costing a pick-again round, and one pick that gave up. Every pick ran 1.5 to 3.5 times the controlled baseline while the search, resolve and probe stages stayed normal. The excess is in model turns and retries; source health at the probe stage is the suspected cause, unverified (issue #164). The never-block rule means the listener hears talk through those minutes, and also long stretches with no song.

Between the announce at the head and the coda at the tail, the host never talks over a song unless the listener types first. The engine can duck for a beat mid-track and the Director never asks (issue #163). A buffered beat can be minutes old by then, so that feature has to check the beat against the live track before airing it.

The cold start is still 25 to 39 s of bed with no voice. The look-ahead holds at every buffered boundary in the measured runs. It covers neither the first batch nor the time anchors, which spec 07 generates at their own boundary. The first batch is unsolved.

## Reproduce

The numbers above were read by hand off `.dev/dev.log` and the PR bodies that quote it. There is no benchmark harness; the log is the harness.

```
make dev        # real brain, real yt-dlp, hosted voice (endpoint from .env)
make logs       # second terminal: tails .dev/dev.log
```

Set `MURMUR_ACTIVITY=present` so the cadence does not thin while you look away. Point `MURMUR_HOME` at a fresh directory for a cold run, then again for a hot one.

```
grep -E 'talk.buffer|talk.refill|music.pick|music.search|music.resolve|music.probe|music.end' .dev/dev.log
```

`talk.buffer warm` means the beat came from the buffer; the spoken line after it is logged once its clip is ready to play, so the two stamps show whether synthesis was still pending. `talk.refill need` to `got` is one refill's model call. `music.pick start` to `done` is one discovery. `music.end` to the next spoken line is the boundary gap. `STUB=1 make dev` runs a canned brain and a silent voice: the mechanics show, the latency does not.

The mixer is asserted on an offline render, no audio device needed: `pnpm test -- test/engine.test.ts` covers the duck, the slow unduck, the born-ducked head, the bed crossfade and the no-gap loop. The never-block rule and the buffer surviving music are in `test/director-music.test.ts`.

Each constant has one home: `src/audio/engine.ts` for gains and ramps, `src/director/director.ts` for the buffer depth and the coda, `src/config.ts` for the gap and cadence. `specs/spec04/04-no-dead-air.md` carries the measurement tables.
