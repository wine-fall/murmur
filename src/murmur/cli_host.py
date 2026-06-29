"""CLI Host (spec 01 §3.1 ``cli_host``).

Renders "now playing" + program text to the terminal. Step 1 of spec 01 is
**render-only**: it shows what the radio is saying as the loop runs. Reading
keyboard lines from stdin and owning the manual-stop signal (typed talk-back,
``/quit``) arrive in spec 01 step 3, where the proactive program and your typing
share this same terminal.
"""

from __future__ import annotations

import sys


class CliHost:
    def banner(self, persona_first_line: str, *, brain: str, voice: str) -> None:
        print("┌─ murmur · L0 (spec 01) ──────────────────────────────────────")
        print(f"│ brain: {brain}   voice: {voice}")
        print(f"│ persona: {persona_first_line}")
        print("│ the radio will start speaking on its own. Ctrl-C to stop.")
        print("└──────────────────────────────────────────────────────────────")
        sys.stdout.flush()

    def on_radio_segment(self, text: str) -> None:
        print(f"\n🎙  {text}")
        sys.stdout.flush()

    def on_user_line(self, text: str) -> None:
        print(f"\n⌨️   {text}")
        sys.stdout.flush()

    def info(self, message: str) -> None:
        print(f"·  {message}")
        sys.stdout.flush()
