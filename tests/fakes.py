"""Shared fakes for the fast unit layer (DESIGN §11.1).

Every seam ships a fake so the core loop and the Director's arbitration can be
tested with no real audio, LLM, or network.
"""

from __future__ import annotations

import asyncio
from typing import Any

from murmur.contracts import AudioClip, ContextPack, TrackCandidate


class FakeBrain:
    """Records calls; returns deterministic text. ``respond_delay`` > 0 keeps a
    reply "in composition" long enough for a queued line to merge into it (the
    delay is *before* recording, so a merged-away reply leaves no trace)."""

    def __init__(self, respond_delay: float = 0.0) -> None:
        self.talk_count = 0
        self.responded_to: list[str] = []
        self._respond_delay = respond_delay

    async def next_talk(self, ctx: ContextPack) -> str:
        self.talk_count += 1
        return f"talk-{self.talk_count}"

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        if self._respond_delay:
            await asyncio.sleep(self._respond_delay)
        self.responded_to.append(user_text)
        return f"reply:{user_text}"


class FakeVoice:
    """Returns an AudioClip without touching disk. ``fail_on`` lists texts
    whose synthesis raises (the real sidecar can fail per-utterance). ``events``
    (shared with a FakePlayer) records ("synth", text) so a test can assert the
    reply was synthesized before the current clip was cut (deferred barge-in)."""

    def __init__(
        self,
        fail_on: list[str] | None = None,
        events: list[tuple[str, str]] | None = None,
        synth_delay: float = 0.0,
    ) -> None:
        self.started = False
        self.closed = False
        self._fail_on = set(fail_on or [])
        self._events = events
        self._synth_delay = synth_delay

    async def start(self) -> None:
        self.started = True

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        if text in self._fail_on:
            raise RuntimeError(f"sidecar synthesize failed: {text!r}")
        if self._synth_delay:  # keep a reply "rendering" so a line can merge in
            await asyncio.sleep(self._synth_delay)
        if self._events is not None:
            self._events.append(("synth", text))
        return AudioClip(source=f"fake:{text}", kind="talk")

    async def aclose(self) -> None:
        self.closed = True


class FakePlayer:
    """Records played clips. ``play_delay`` > 0 keeps a clip "on air" long enough
    for a queued input line to win the interjection race; the Director cancels it."""

    def __init__(
        self,
        play_delay: float = 0.0,
        events: list[tuple[str, str]] | None = None,
    ) -> None:
        self.play_delay = play_delay
        self.played: list[str] = []
        self.stops = 0
        self._events = events

    async def play(self, clip: AudioClip) -> None:
        self.played.append(clip.source)
        if self._events is not None:
            self._events.append(("play", clip.source))
        if self.play_delay:
            await asyncio.sleep(self.play_delay)

    async def stop(self) -> None:
        self.stops += 1
        if self._events is not None:
            self._events.append(("stop", ""))


class FakeCli:
    """Feeds scripted lines through ``next_line`` and records rendered output."""

    def __init__(self, lines: list[str] | None = None) -> None:
        self._lines: asyncio.Queue[str] = asyncio.Queue()
        for line in lines or []:
            self._lines.put_nowait(line)
        self.started = False
        self.radio: list[str] = []
        self.user: list[str] = []
        self.infos: list[str] = []

    def start(self) -> None:
        self.started = True

    async def next_line(self) -> str:
        return await self._lines.get()

    def on_radio_segment(self, text: str) -> None:
        self.radio.append(text)

    def on_user_line(self, text: str) -> None:
        self.user.append(text)

    def info(self, message: str) -> None:
        self.infos.append(message)


class FakeMusicProvider:
    """Canned MusicProvider (spec 03-01 §5): no network. ``resolvable`` is the
    set of refs that resolve; any other ref raises so retry paths are testable."""

    def __init__(
        self,
        candidates: list[TrackCandidate] | None = None,
        resolvable: set[str] | None = None,
    ) -> None:
        self._candidates = list(candidates or [])
        self._resolvable = set(resolvable or set())
        self.searched: list[tuple[str, int]] = []
        self.resolved: list[str] = []
        self.started = False
        self.closed = False

    async def start(self) -> None:
        self.started = True

    async def search(self, query: str, *, limit: int = 5) -> list[TrackCandidate]:
        self.searched.append((query, limit))
        return self._candidates[:limit]

    async def resolve(self, ref: str) -> AudioClip:
        self.resolved.append(ref)
        if ref in self._resolvable:
            return AudioClip(source=f"stream:{ref}", kind="music")
        raise RuntimeError(f"cannot resolve {ref!r}")

    async def aclose(self) -> None:
        self.closed = True


class FakeMusicBrain:
    """Scripted Harness (spec 03-01 §2.1): search once, then submit_pick each
    candidate until one resolves. A stand-in for the model's loop — plumbing
    only, no selection intelligence (that is the Ollama/human layer).
    ``with_announce=False`` scripts a model that omits the optional metadata."""

    def __init__(self, with_announce: bool = True) -> None:
        self.tasks: list[dict[str, Any]] = []
        self._with_announce = with_announce

    async def run_task(
        self,
        system_prompt: str,
        prompt: str,
        *,
        tools: list[Any],
        model: str,
        max_turns: int,
    ) -> dict[str, Any] | None:
        self.tasks.append(
            {"system_prompt": system_prompt, "prompt": prompt, "model": model}
        )
        search = next(t for t in tools if not t.terminal)
        submit = next(t for t in tools if t.terminal)
        found = await search.run({"query": "test", "limit": 5})
        for candidate in found["candidates"][:max_turns]:
            args = {"ref": candidate["ref"], "why": "fake pick"}
            if self._with_announce:
                args |= {
                    "title": candidate["title"],
                    "artist": candidate["uploader"],
                    "announce": f"up next: {candidate['title']}",
                }
            out = await submit.run(args)
            if out.get("ok"):
                return out
        return None


class FakeMusicHandle:
    """Scripted MusicHandle (spec 03-02 §2.2): finishes when told (or at once
    with ``auto_finish``), records duck/unduck/stop calls."""

    def __init__(self, auto_finish: bool = False) -> None:
        self._done = asyncio.Event()
        if auto_finish:
            self._done.set()
        self.ducks = 0
        self.unducks = 0
        self.stops = 0

    def finish(self) -> None:
        self._done.set()

    async def duck(self) -> None:
        self.ducks += 1

    async def unduck(self) -> None:
        self.unducks += 1

    async def stop(self) -> None:
        self.stops += 1
        self._done.set()

    async def wait(self) -> None:
        await self._done.wait()


class FakeEngine(FakePlayer):
    """FakePlayer + play_music (the spec 03-02 mixing-player capability):
    records music clips, hands out FakeMusicHandles."""

    def __init__(self, play_delay: float = 0.0, auto_finish: bool = True) -> None:
        super().__init__(play_delay=play_delay)
        self._auto_finish = auto_finish
        self.music_played: list[AudioClip] = []
        self.handles: list[FakeMusicHandle] = []

    async def play_music(self, clip: AudioClip) -> FakeMusicHandle:
        self.music_played.append(clip)
        handle = FakeMusicHandle(auto_finish=self._auto_finish)
        self.handles.append(handle)
        return handle


class FakeMusicProgrammer:
    """Scripted next_track: pops picks (None = nothing found); records the
    contexts it was asked for."""

    def __init__(self, picks: list[Any] | None = None) -> None:
        self._picks = list(picks or [])
        self.contexts: list[Any] = []

    async def next_track(self, ctx: Any) -> Any:
        self.contexts.append(ctx)
        return self._picks.pop(0) if self._picks else None


class ScriptedCadence:
    """Pops scripted kinds; defaults to talk when the script runs out."""

    def __init__(self, kinds: list[str] | None = None) -> None:
        self._kinds = list(kinds or [])
        self.states: list[Any] = []

    async def next_kind(self, state: Any) -> str:
        self.states.append(state)
        return self._kinds.pop(0) if self._kinds else "talk"


class FakeGuideBrain:
    """Scripted GuideCapable (spec 03-03): records run_guide calls, streams a
    canned reply. Stand-in for the real repair loop — no SDK, no shell."""

    def __init__(self, reply: str = "done") -> None:
        self._reply = reply
        self.calls = 0
        self.prompts: list[str] = []

    async def run_guide(
        self,
        system_prompt: str,
        prompt: str,
        *,
        model: str,
        max_turns: int,
        permission_mode: str = "default",
        can_use_tool: Any = None,
        on_text: Any = None,
        next_user_input: Any = None,
    ) -> str:
        self.calls += 1
        self.prompts.append(prompt)
        if on_text is not None:
            on_text(self._reply)
        return self._reply
