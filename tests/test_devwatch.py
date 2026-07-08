"""devwatch log-follow + memory-line logic (no live processes / real tailing).

devwatch is a scripts/ module that imports its sibling ``memwatch``; adding
scripts/ to the path lets both resolve as normal modules.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import devwatch  # noqa: E402  (after the sys.path insert above)


def test_follower_tolerates_a_missing_file(tmp_path):
    follower = devwatch.LogFollower(tmp_path / "nope.log")
    assert follower.read_new() == []


def test_follower_reads_only_newly_appended_lines(tmp_path):
    p = tmp_path / "log"
    p.write_text("a\nb\n", encoding="utf-8")
    follower = devwatch.LogFollower(p)
    assert follower.read_new() == ["a", "b"]
    with p.open("a", encoding="utf-8") as fh:
        fh.write("c\n")
    assert follower.read_new() == ["c"]
    assert follower.read_new() == []  # nothing new


def test_follower_buffers_a_partial_line_until_its_newline(tmp_path):
    p = tmp_path / "log"
    p.write_text("hel", encoding="utf-8")
    follower = devwatch.LogFollower(p)
    assert follower.read_new() == []  # no newline yet -> nothing complete
    with p.open("a", encoding="utf-8") as fh:
        fh.write("lo\n")
    assert follower.read_new() == ["hello"]


def test_follower_resets_after_truncation(tmp_path):
    p = tmp_path / "log"
    p.write_text("old1\nold2\n", encoding="utf-8")
    follower = devwatch.LogFollower(p)
    follower.read_new()
    p.write_text("fresh\n", encoding="utf-8")  # a new `make dev` truncated it
    assert follower.read_new() == ["fresh"]


def test_level_filter_hides_below_threshold_shows_at_or_above():
    f = devwatch.LevelFilter("INFO")
    assert f.show("14:03:07 INFO    murmur.voice: synth  rtf=1.55") is True
    assert f.show("14:03:07 DEBUG   murmur.harness: task SystemMessage(...)") is False
    assert f.show("14:03:07 WARNING murmur.director: music fell back") is True


def test_level_filter_keeps_traceback_continuation_with_its_parent():
    f = devwatch.LevelFilter("INFO")
    # a hidden DEBUG line's non-level continuation stays hidden...
    assert f.show("14:03:07 DEBUG   murmur.harness: dump") is False
    assert f.show("    continued dump line") is False
    # ...a shown WARNING's traceback lines stay shown.
    assert f.show("14:03:07 WARNING murmur.director: boom") is True
    assert f.show("Traceback (most recent call last):") is True
    assert f.show('  File "x.py", line 1, in <module>') is True
    assert f.show("ValueError: boom") is True


def test_level_filter_debug_shows_everything():
    f = devwatch.LevelFilter("DEBUG")
    assert f.show("14:03:07 DEBUG   murmur.harness: task") is True
    assert f.show("14:03:07 INFO    murmur.voice: synth") is True


def _proc(pid: int, rss_kb: int, command: str) -> object:
    return devwatch.memwatch.Proc(pid=pid, ppid=1, rss_kb=rss_kb, command=command)


def test_memory_line_summarizes_the_tree_and_tracks_peak(monkeypatch):
    procs = [_proc(101, 2048, "python -m murmur"), _proc(102, 1024, "ffmpeg -i x")]
    monkeypatch.setattr(devwatch.memwatch, "snapshot", lambda: procs)
    monkeypatch.setattr(devwatch.memwatch, "find_roots", lambda _p: [procs[0]])
    monkeypatch.setattr(devwatch.memwatch, "subtree", lambda _p, root_pid: procs)

    line, peak = devwatch.memory_line(peak_kb=0)
    assert line is not None and line.startswith("  • mem")
    assert peak == 2048 + 1024


def test_memory_line_is_none_when_no_murmur_is_running(monkeypatch):
    monkeypatch.setattr(devwatch.memwatch, "snapshot", lambda: [])
    monkeypatch.setattr(devwatch.memwatch, "find_roots", lambda _p: [])
    line, peak = devwatch.memory_line(peak_kb=42)
    assert line is None
    assert peak == 42  # unchanged
