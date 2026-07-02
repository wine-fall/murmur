"""Context insertion for music discovery (spec 03-01 §2.5).

The *mechanism* — not the content (which is deferred). ``render_context`` is the
single place a ``MusicContext`` becomes prompt text, and it enforces the cache
split: the stable ``persona`` goes to the system prompt (prompt-cacheable,
master §7 pillar 4), the volatile ``situation`` goes to the per-call turn. Which
fields compose ``situation`` is decided in a later spec; adding them touches only
this file and never ``Brain.run_task``.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..prompts import MUSIC_CONTEXT_HEADER


@dataclass(frozen=True)
class MusicContext:
    """Carrier passed to ``MusicProgrammer.next_track``. Concrete fields are
    deferred (spec 03-01 §2.4): only the two the mechanism needs are pinned."""

    persona: str  # stable, cacheable prefix (taste / language)
    situation: str  # volatile block rendered into the task turn; content deferred


def render_context(ctx: MusicContext) -> tuple[str, str]:
    """Render ``ctx`` into ``(system_prompt, situation_block)``.

    ``system_prompt`` is the stable prefix (persona, verbatim) so repeated calls
    hit the prompt cache; ``situation_block`` is the volatile part, sent fresh
    each call. Keeping the two disjoint is what makes insertion *fast* (cache
    stays warm) — see the tests in ``test_music_context``.
    """
    system_prompt = ctx.persona
    situation_block = f"{MUSIC_CONTEXT_HEADER}{ctx.situation}"
    return system_prompt, situation_block
