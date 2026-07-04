"""Music discovery — the brain-harness's first capability (spec 03-01).

Claude, running in the harness (harness.py + Brain.run_task), searches for and
pulls a track to a playable ``AudioClip(kind="music")``. This package holds the
context-insertion mechanism (``context``), the low-level source adapters
(``provider``), the harness tools (``tools``), and the Director-facing entry
(``programmer``). Playback and scheduling are spec 03-02, not here.
"""
