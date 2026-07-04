"""Instruction for the Claude-driven music-discovery task (spec 03-01 §2.3).

Centralized here (DESIGN §0): the selection heuristics live in the task
instruction, not scattered in code and not (for the MVP) a formal SDK skill.
English scaffolding; the listener's language/taste comes from the persona.
"""

from __future__ import annotations

# Header prefixing the volatile context block in the music task turn (spec 03-01
# §2.5). Lives here (prompts/) because it is model-facing prompt text; the
# rendering mechanism in music/context.py only glues it on.
MUSIC_CONTEXT_HEADER = "Current context for choosing music:\n"

_FIND_MUSIC_INSTRUCTION = """\
Choose ONE piece of music to play next on a personal radio.

Use the search_music tool to find candidates, judge them against the persona and
the context below, then call submit_pick with the single best track and a short
reason.

Guidance:
- Prefer official audio / studio versions; avoid hour-long loops, low-quality
  re-uploads, and live or cover versions unless they clearly fit the moment.
- Match the listener's taste and language as expressed by the persona.
- Do not repeat something already noted as recently played.
- If your pick fails to resolve, pick another candidate and submit again.
- In submit_pick, also pass the track's title and artist (from the candidate),
  and write `announce`: ONE short spoken line introducing the track, in the
  persona's voice and language — like a radio DJ's "up next". No quotes around
  it, no markdown; it will be read aloud over the song's opening.
"""


def build_find_music_instruction() -> str:
    """The static instruction for the music-discovery task (spec 03-01 §2.3)."""
    return _FIND_MUSIC_INSTRUCTION
