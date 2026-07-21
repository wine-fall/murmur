"""Spec 05 §2.1/§2.2 — the extended MemoryStore Protocol + ContextPack fields.

Contract-stability tests (acceptance §5.7): both stores satisfy the extended
Protocol; every ContextPack addition is defaulted so existing constructions
stay valid.
"""

from __future__ import annotations

from murmur.contracts import ContextPack, MemoryStore, Turn
from murmur.memory import InProcessMemoryStore


def test_context_pack_additions_are_defaulted() -> None:
    # Existing (spec 01/04) constructions keep compiling untouched.
    pack = ContextPack(persona="p", recent=[Turn("radio", "hi")])
    assert pack.profile == ""
    assert pack.covered_topics == ()
    assert pack.scene is None


def test_in_process_store_satisfies_extended_protocol() -> None:
    assert isinstance(InProcessMemoryStore(), MemoryStore)


def test_in_process_profile_default_empty() -> None:
    assert InProcessMemoryStore().profile() == ""


def test_in_process_ledger_queries() -> None:
    store = InProcessMemoryStore()
    assert store.recent_topics(5) == []
    assert store.recent_songs(5) == []
    store.record_event("topic", "night walks")
    store.record_event("song", "Song A — Artist")
    store.record_event("topic", "coffee")
    store.record_event("song", "Song B — Artist")
    assert store.recent_topics(10) == ["night walks", "coffee"]
    assert store.recent_topics(1) == ["coffee"]
    assert store.recent_songs(10) == ["Song A — Artist", "Song B — Artist"]
    assert store.recent_songs(1) == ["Song B — Artist"]
    assert store.recent_topics(0) == []
