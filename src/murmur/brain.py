"""Brain contract + step-1 stub (spec 01 §3.2).

The Brain wraps ``claude-agent-sdk`` (master §3.2: subscription-OAuth, no API
key; model ``claude-opus-4-8``) and produces talk-segment text and user
responses from a ``ContextPack``.

Step 1 of spec 01 ships only ``StubBrain`` — canned, deterministic text with no
SDK call — so the core loop can be exercised end-to-end before the real Brain
lands in step 2. The two-method ``Brain`` Protocol is fixed here; the real
adapter implements it without touching its consumers (the Director).
"""

from __future__ import annotations

from itertools import cycle
from typing import Protocol, runtime_checkable

from .contracts import ContextPack


@runtime_checkable
class Brain(Protocol):
    async def next_talk(self, ctx: ContextPack) -> str:
        """Generate the next short, self-contained talk-segment script: pick or
        continue a topic and chat, per the persona. Self-initiated — not a
        reply."""
        ...

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        """Respond in-persona to a typed user line; then the program resumes."""
        ...


# Canned segments rotated by the stub. Content is placeholder only — the point
# is to prove the loop, the seam, and that ContextPack flows through. The real
# voice and the real (Claude) text both arrive in later steps.
_STUB_SEGMENTS = (
    "夜深了,空气里只剩我和你。今天就先随便聊聊吧。",
    "刚才路过一个念头——人是不是越长大,越习惯把话咽回去。",
    "放首歌的心情都有了,可惜音乐还得再等等。先用声音陪你。",
    "窗外没什么动静,这种安静其实挺好的,像被世界轻轻放下。",
    "我在想,所谓陪伴,大概就是有个声音一直在,不催你、不问你。",
)


class StubBrain:
    """Deterministic, dependency-free Brain. Satisfies the ``Brain`` Protocol.

    Proves the seam (no ``claude-agent-sdk`` present) for spec 01 §5 criterion
    5. Replaced by the real SDK-backed Brain in spec 01 step 2.
    """

    def __init__(self) -> None:
        self._segments = cycle(_STUB_SEGMENTS)

    async def next_talk(self, ctx: ContextPack) -> str:
        return next(self._segments)

    async def respond(self, user_text: str, ctx: ContextPack) -> str:
        return f"嗯,你说「{user_text}」——我听到了。我们顺着这个再聊聊。"
