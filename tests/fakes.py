"""Shared fakes for the fast unit layer (DESIGN §11.1).

Every seam ships a fake so the core loop and the Director's arbitration can be
tested with no real audio, LLM, or network.
"""

from __future__ import annotations

import asyncio

from murmur.contracts import AudioClip, ContextPack


class FakeBrain:
    """Records calls; returns deterministic text."""

    def __init__(self) -> None:
        self.talk_count = 0
        self.responded_to: list[str] = []

    async def next_talk(self, ctx: ContextPack) -> str:
        self.talk_count += 1
        return f"talk-{self.talk_count}"

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        self.responded_to.append(user_text)
        return f"reply:{user_text}"


class FakeVoice:
    """Returns an AudioClip without touching disk."""

    def __init__(self) -> None:
        self.started = False
        self.closed = False

    async def start(self) -> None:
        self.started = True

    async def synthesize(self, text: str, *, scenario: str = "broadcast") -> AudioClip:
        return AudioClip(source=f"fake:{text}", kind="talk")

    async def aclose(self) -> None:
        self.closed = True


class FakePlayer:
    """Records played clips. ``play_delay`` > 0 keeps a clip "on air" long enough
    for a queued input line to win the interjection race; the Director cancels it."""

    def __init__(self, play_delay: float = 0.0) -> None:
        self.play_delay = play_delay
        self.played: list[str] = []
        self.stops = 0

    async def play(self, clip: AudioClip) -> None:
        self.played.append(clip.source)
        if self.play_delay:
            await asyncio.sleep(self.play_delay)

    async def stop(self) -> None:
        self.stops += 1


class FakeCli:
    """Feeds scripted lines through ``next_line`` and records rendered output."""

    def __init__(self, lines: list[str] | None = None) -> None:
        self._lines: asyncio.Queue[str] = asyncio.Queue()
        for line in lines or []:
            self._lines.put_nowait(line)
        self.started = False
        self.radio: list[str] = []
        self.user: list[str] = []

    def start(self) -> None:
        self.started = True

    async def next_line(self) -> str:
        return await self._lines.get()

    def on_radio_segment(self, text: str) -> None:
        self.radio.append(text)

    def on_user_line(self, text: str) -> None:
        self.user.append(text)

    def info(self, message: str) -> None:
        pass
