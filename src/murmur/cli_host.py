"""CLI Host (spec 01 §3.1).

Renders "now playing" + program text, and owns keyboard input from stdin. A
background daemon thread reads lines and hands them to the asyncio loop through
a queue, so the Director can race the current playback against the next typed
line (the cancel-and-resume interjection, §3.3). The daemon thread dies with the
process, keeping shutdown clean.

EOF on stdin (pipe closed / Ctrl-D) means "no more input will come" — NOT quit.
A radio keeps broadcasting whether or not anyone types; only ``/quit`` or Ctrl-C
stops it (§3.6).
"""

from __future__ import annotations

import asyncio
import sys
import threading
from typing import Protocol, runtime_checkable


@runtime_checkable
class Host(Protocol):
    """The CLI-host seam the Director consumes (spec 01 §3.3): start the input
    reader, await the next typed line, and render program/user text. ``CliHost``
    is the real impl (it also renders a banner / info lines, used by app.py);
    tests inject a fake. Kept a Protocol so the Director depends on the
    capability, not the concrete class (interface-first, DESIGN §11.1)."""

    def start(self) -> None: ...

    async def next_line(self) -> str: ...

    def on_radio_segment(self, text: str) -> None: ...

    def on_user_line(self, text: str) -> None: ...

    def info(self, message: str) -> None: ...


class CliHost:
    def __init__(self) -> None:
        self._lines: asyncio.Queue[str] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._reader: threading.Thread | None = None

    # --- keyboard input (stdin) -------------------------------------------
    def start(self) -> None:
        """Spawn the stdin reader. Call once, from inside the running loop."""
        self._loop = asyncio.get_running_loop()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        # Daemon thread: blocks on stdin and hands each line back to the loop.
        # On EOF it simply stops reading (the radio plays on); it does not quit.
        loop = self._loop
        assert loop is not None
        for line in sys.stdin:
            loop.call_soon_threadsafe(self._lines.put_nowait, line.rstrip("\n"))

    async def next_line(self) -> str:
        """Await the next typed line."""
        return await self._lines.get()

    # --- rendering --------------------------------------------------------
    def banner(self, persona_first_line: str, *, brain: str, voice: str) -> None:
        print("┌─ murmur · L0 (spec 01) ──────────────────────────────────────")
        print(f"│ brain: {brain}   voice: {voice}")
        print(f"│ persona: {persona_first_line}")
        print("│ it speaks on its own. Type to talk back; /quit or Ctrl-C to stop.")
        print("└──────────────────────────────────────────────────────────────")
        sys.stdout.flush()

    def on_radio_segment(self, text: str) -> None:
        print(f"\n🎙  {text}")
        sys.stdout.flush()

    def on_user_line(self, text: str) -> None:
        print(f"\n⌨   {text}")
        sys.stdout.flush()

    def info(self, message: str) -> None:
        print(f"·  {message}")
        sys.stdout.flush()
