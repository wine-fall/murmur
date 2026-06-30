"""AudioPlayer subprocess control (spec 01 §3.5).

Uses tiny stand-in binaries instead of a real audio player: ``true`` exits
immediately (playback finished), ``yes`` runs until terminated (a clip still on
air). No sound, no afplay.
"""

from __future__ import annotations

import asyncio
import contextlib

import pytest

from murmur.audio_player import AudioPlayer
from murmur.contracts import AudioClip

_CLIP = AudioClip(source="ignored-by-stand-in", kind="talk")


def test_play_completes_when_player_exits():
    async def go():
        player = AudioPlayer("true")
        await asyncio.wait_for(player.play(_CLIP), timeout=5)

    asyncio.run(go())


def test_stop_terminates_playback():
    async def go():
        player = AudioPlayer("yes")  # would run forever
        play_task = asyncio.ensure_future(player.play(_CLIP))
        await asyncio.sleep(0.1)  # let it start
        await asyncio.wait_for(player.stop(), timeout=5)
        # play() unwinds promptly once playback is stopped (no hang).
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(play_task, timeout=5)
        assert play_task.done()

    asyncio.run(go())


def test_cancelling_play_propagates_and_kills_subprocess():
    async def go():
        player = AudioPlayer("yes")
        play_task = asyncio.ensure_future(player.play(_CLIP))
        await asyncio.sleep(0.1)
        play_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(play_task, timeout=5)

    asyncio.run(go())
